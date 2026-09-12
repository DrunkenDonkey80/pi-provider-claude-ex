/**
 * Pool state machine: which account is active, keeping every lineage alive,
 * and cooling down the ones that hit a cap.
 *
 * Liveness model (ported from claude-swap, not from upstream's timer):
 *   - Access tokens are refreshed LAZILY — only inside ACCESS_BUFFER_MS of
 *     expiry. Upstream swept every account every 4 minutes; every extra grant
 *     is another chance to lose a rotation race, so fewer grants = longer life.
 *   - A lineage unused for KEEPALIVE_MS is exercised once, on purpose, so the
 *     refresh token never lapses from disuse. That is the only proactive grant.
 *   - Every grant goes through a per-lineage lock with a consume-gate re-read,
 *     so N pi sessions + the daemon can never POST the same generation.
 *   - A transient failure quarantines briefly; only a server-side
 *     `invalid_grant` marks an account dead.
 */

import {
	type Account,
	AGENT_DIR,
	DAEMON_PATH,
	type Store,
	findAccount,
	mutateStore,
	readJson,
	readStore,
	stashDrop,
	stashPut,
	withClaudeCodeRefreshLock,
	withDirLock,
	writeJsonAtomic,
} from "./store.ts";
import { type RefreshError, refreshGrant } from "./oauth.ts";
import {
	SERVE_TTL_MS,
	collectUsage,
	fullUntil,
	readUsage,
	switchScore,
} from "./usage.ts";
import { join } from "node:path";

/** Refresh the access token this long before it expires. */
const ACCESS_BUFFER_MS = 10 * 60_000;
/** Exercise an idle lineage after this long, so the login never lapses. */
export const KEEPALIVE_MS = 20 * 24 * 3_600_000;
/** Cooldown applied when a cap is hit without a server-stated reset. */
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
/** Background sweep cadence (daemon, or a session with no daemon running). */
export const TICK_MS = 5 * 60_000;
/** Only the in-use account polls in the background; the rest refresh on demand. */
export const ACTIVE_USAGE_MS = 5 * 60_000;
const DAEMON_HEARTBEAT_MS = 30_000;
const DAEMON_STALE_MS = 90_000;
/** getApiKey() is synchronous and hot: memoize the on-disk store briefly. */
const SNAPSHOT_TTL_MS = 2_000;

export type Logger = (msg: string) => void;
let log: Logger = () => undefined;
export const setPoolLogger = (fn: Logger): void => {
	log = fn;
};

// ─── snapshot (sync, cross-process fresh) ───────────────────────────────────

let snapshotCache: Store | undefined;
let snapshotAt = 0;

export function snapshot(force = false): Store {
	if (force || !snapshotCache || Date.now() - snapshotAt > SNAPSHOT_TTL_MS) {
		snapshotCache = readStore();
		snapshotAt = Date.now();
	}
	return snapshotCache;
}

export const invalidateSnapshot = (): void => {
	snapshotCache = undefined;
};

export function poolEnabled(): boolean {
	if (process.env.PI_CLAUDE_PROVIDER_POOL_DISABLE === "1") return false;
	const store = snapshot();
	return store.enabled !== false && store.accounts.length > 0;
}

export const usable = (a: Account, now = Date.now()): boolean =>
	!a.dead && !a.disabled && (a.cooldownUntil ?? 0) <= now;

/**
 * Sticky selection: stay on the pinned account while it is usable, otherwise
 * the best switch score (quota left vs time left to spend it), otherwise the
 * one whose cooldown frees up soonest.
 *
 * Sync and hot (getApiKey), so it scores whatever the cache already holds.
 * `pickNext()` is the one that re-reads first — use it when the choice matters.
 */
export function pickActive(store: Store): string | undefined {
	const now = Date.now();
	const pinned = store.active ? findAccount(store, store.active) : undefined;
	if (pinned && usable(pinned, now)) return pinned.label;

	const cache = readUsage();
	const candidates = store.accounts.filter((a) => usable(a, now));
	if (candidates.length) {
		let best = candidates[0];
		let bestScore = switchScore(cache[best.label], now);
		for (const a of candidates.slice(1)) {
			const score = switchScore(cache[a.label], now);
			if (score > bestScore) {
				best = a;
				bestScore = score;
			}
		}
		return best.label;
	}
	// Everything is cooling down: the one that frees up soonest.
	const waiting = store.accounts
		.filter((a) => !a.dead && !a.disabled)
		.sort((a, b) => (a.cooldownUntil ?? 0) - (b.cooldownUntil ?? 0));
	return waiting[0]?.label;
}

export function activeAccount(): Account | undefined {
	const store = snapshot();
	const label = pickActive(store);
	return label ? findAccount(store, label) : undefined;
}

/** Pin an account as active (persisted, so it survives restarts). */
export async function setActive(label: string): Promise<boolean> {
	const ok = await mutateStore((store) => {
		if (!findAccount(store, label)) return false;
		store.active = label;
		return true;
	});
	invalidateSnapshot();
	if (ok) log(`active → ${label}`);
	return ok;
}

// ─── refresh ────────────────────────────────────────────────────────────────

const refreshLockDir = (label: string): string =>
	join(
		AGENT_DIR,
		`claude-pool.${label.replace(/[^a-zA-Z0-9._-]/g, "_")}.refresh.lock`,
	);

async function applyRefreshError(
	label: string,
	error: RefreshError | undefined,
): Promise<Account | undefined> {
	const result = await mutateStore((store) => {
		const account = findAccount(store, label);
		if (!account) return undefined;
		if (error === "invalid_grant" || error === "no_refresh_token") {
			account.dead = true; // the lineage really is gone: needs /login
		} else if (error === "transient") {
			account.strikes = (account.strikes ?? 0) + 1;
			// Brief quarantine so a flapping account doesn't get hammered; NEVER
			// permanent — upstream's text-matched 401 killed live logins.
			account.cooldownUntil = Math.max(
				account.cooldownUntil ?? 0,
				Date.now() + Math.min(30 * 60_000, 60_000 * 2 ** (account.strikes ?? 1)),
			);
		}
		// invalid_client blames our client_id, not this account: no strike.
		return account;
	});
	invalidateSnapshot();
	log(`refresh failed ${label}: ${error}`);
	return result;
}

/**
 * Make sure `label` has a usable access token. Returns the current account.
 *
 * `force` is for the 401 path (the server rejected a token we thought was
 * live) and for explicit user actions. Even then, if the consume-gate re-read
 * shows a different generation, someone else already rotated it and we use
 * theirs instead of POSTing.
 *
 * `force` also RETRIES a dead account: `dead` is our own classification, and a
 * revoked-looking lineage is exactly what a user retries after re-logging in.
 * Only the background sweep skips dead accounts.
 */
export async function ensureFresh(
	label: string,
	opts: { force?: boolean } = {},
): Promise<Account | undefined> {
	const before = findAccount(readStore(), label);
	if (!before) return before;
	if (before.dead && !opts.force) return before;
	if (!opts.force && before.expires > Date.now() + ACCESS_BUFFER_MS)
		return before;

	try {
		return await withDirLock(
			refreshLockDir(label),
			async () => {
				// Consume gate: re-read under the lock. A contender that just
				// rotated this lineage makes our snapshot a spent generation.
				const current = findAccount(readStore(), label);
				if (!current) return undefined;
				if (current.refresh !== before.refresh) return current;
				if (!opts.force && current.expires > Date.now() + ACCESS_BUFFER_MS)
					return current;

				const outcome = await withClaudeCodeRefreshLock(() =>
					refreshGrant(current.refresh),
				);
				if (!outcome.credential) return applyRefreshError(label, outcome.error);

				const next = {
					refresh: outcome.credential.refresh,
					access: outcome.credential.access,
					expires: outcome.credential.expires,
					refreshExpires: outcome.refreshExpires ?? current.refreshExpires,
				};
				// Durable successor BEFORE the store write: if the write dies here,
				// readStore() adopts this instead of re-POSTing a spent token.
				stashPut(label, next);
				const saved = await mutateStore((store) => {
					const account = findAccount(store, label);
					if (!account) return undefined;
					Object.assign(account, next);
					account.lastGrantAt = Date.now();
					account.strikes = 0;
					account.dead = false;
					return account;
				});
				stashDrop(label, next.refresh);
				invalidateSnapshot();
				log(`refreshed ${label} (exp ${new Date(next.expires).toISOString()})`);
				return saved;
			},
			{ timeoutMs: 45_000, staleMs: 120_000 },
		);
	} catch (e) {
		log(`refresh lock busy for ${label}: ${(e as Error).message}`);
		return findAccount(readStore(), label); // another holder is doing it
	}
}

// ─── caps / cooldown ────────────────────────────────────────────────────────

/** A valid access token for a label, or undefined if the lineage is dead. */
const tokenFor = async (label: string): Promise<string | undefined> => {
	const account = await ensureFresh(label);
	return account?.dead ? undefined : account?.access;
};

/**
 * Park every candidate whose FRESH read says a window is spent, until it
 * resets. Only a fresh read may park an account — stale numbers are the exact
 * thing this defends against.
 */
async function parkFull(labels: string[]): Promise<void> {
	const cache = readUsage();
	const now = Date.now();
	const until = new Map<string, number>();
	for (const label of labels) {
		const entry = cache[label];
		if (!entry || now - (entry.at ?? 0) > SERVE_TTL_MS) continue;
		const free = fullUntil(entry, now);
		if (free) until.set(label, free);
	}
	if (!until.size) return;
	await mutateStore((store) => {
		for (const [label, free] of until) {
			const account = findAccount(store, label);
			if (account)
				account.cooldownUntil = Math.max(account.cooldownUntil ?? 0, free);
		}
	});
	invalidateSnapshot();
	log(`parked (read full): ${[...until.keys()].join(", ")}`);
}

/**
 * Pick with fresh numbers. Our cache can be minutes old and another machine or
 * pi session may have drained an account since — switching on that stale
 * optimism means eating a 429 on the very next message. So re-read every
 * candidate, park the ones that come back full, then score.
 *
 * Costs one usage request per candidate, but only on an actual switch (a few
 * times a day), and every read is still behind collectUsage's 180s floor and
 * 429 backoff.
 */
export async function pickNext(): Promise<string | undefined> {
	const store = readStore();
	// No switch pending: the pinned account still works, so spend nothing.
	const pinned = store.active ? findAccount(store, store.active) : undefined;
	if (pinned && usable(pinned)) return pinned.label;

	const labels = store.accounts.filter((a) => usable(a)).map((a) => a.label);
	if (labels.length > 1) {
		try {
			await collectUsage(labels, tokenFor, { max: labels.length });
			await parkFull(labels);
		} catch {
			/* a failed read must never block the switch — fall back to cache */
		}
	}
	const next = pickActive(readStore());
	// Pin it. Without a persisted choice `pickActive` re-scores the cache on
	// every call, so the account in use drifts each time the numbers move — the
	// pool looks like it switched by itself. Sticky only works if we write it.
	if (next && next !== store.active) await setActive(next);
	return next;
}

export async function markRateLimited(
	label: string,
	until: number,
): Promise<string | undefined> {
	// The server just refused us: a forced read tells us when this account
	// actually frees up, instead of trusting the error text (which often says
	// nothing, and a 5-minute guess is what makes the pool flap).
	let parked = until;
	try {
		await collectUsage([label], tokenFor, { max: 1, force: true });
		parked = Math.max(until, fullUntil(readUsage()[label]) ?? 0);
	} catch {
		/* keep the caller's estimate */
	}
	await mutateStore((store) => {
		const account = findAccount(store, label);
		if (account) account.cooldownUntil = parked;
	});
	invalidateSnapshot();
	const next = await pickNext(); // pins the replacement itself
	log(`rate-limited ${label} until ${new Date(parked).toISOString()} → ${next}`);
	return next;
}

/** Claude's cap messages often carry the reset epoch after a pipe. */
export function parseResetEpoch(message: string): number | undefined {
	const m = message.match(/\|(\d{9,13})\b/);
	if (!m) return undefined;
	const n = Number(m[1]);
	return n > 1e12 ? n : n * 1000;
}

export const LIMIT_RE =
	/\b429\b|\b529\b|rate[ _-]?limit|usage[ _-]?limit|overloaded_error|quota/i;
export const AUTH_RE =
	/authentication_error|invalid authentication credentials|\b401\b/i;

export function cooldownFromMessage(message: string): number {
	return parseResetEpoch(message) ?? Date.now() + DEFAULT_COOLDOWN_MS;
}

// ─── background sweep ───────────────────────────────────────────────────────

export interface DaemonHeartbeat {
	pid: number;
	at: number;
}

export function daemonAlive(): boolean {
	const hb = readJson<DaemonHeartbeat | null>(DAEMON_PATH, null);
	return !!hb && Date.now() - hb.at < DAEMON_STALE_MS && hb.pid !== process.pid;
}

/**
 * One sweep: refresh what's near expiry, exercise idle lineages, and top up the
 * usage cache for at most a couple of accounts.
 */
export async function tick(opts: { usage?: boolean } = {}): Promise<void> {
	const store = readStore();
	const now = Date.now();
	for (const account of store.accounts) {
		if (account.dead) continue;
		const idle = now - (account.lastGrantAt ?? account.expires - 8 * 3_600_000);
		const nearExpiry = account.expires <= now + ACCESS_BUFFER_MS;
		if (nearExpiry) await ensureFresh(account.label);
		else if (idle > KEEPALIVE_MS) {
			log(
				`keep-alive grant for ${account.label} (idle ${Math.round(idle / 86_400_000)}d)`,
			);
			await ensureFresh(account.label, { force: true });
		}
	}
	if (opts.usage === false) return;
	// Only the account in use is polled in the background (every ACTIVE_USAGE_MS,
	// still behind its own 429 backoff). The others are read on demand — `r` in
	// /claude-pool, `cpool list --refresh`.
	const active = pickActive(store);
	if (active && now - (readUsage()[active]?.at ?? 0) >= ACTIVE_USAGE_MS)
		await collectUsage([active], tokenFor, { max: 1 });
}

/** Long-running single-writer sweep loop (`cpool daemon`). */
export async function runDaemon(
	opts: { tickMs?: number; once?: boolean } = {},
): Promise<void> {
	const tickMs = opts.tickMs ?? TICK_MS;
	const beat = setInterval(() => {
		writeJsonAtomic(DAEMON_PATH, { pid: process.pid, at: Date.now() });
	}, DAEMON_HEARTBEAT_MS);
	writeJsonAtomic(DAEMON_PATH, { pid: process.pid, at: Date.now() });
	try {
		for (;;) {
			await tick();
			if (opts.once) return;
			await new Promise((r) => setTimeout(r, tickMs));
		}
	} finally {
		clearInterval(beat);
	}
}
