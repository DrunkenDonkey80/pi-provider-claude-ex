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
	type SyncConfig,
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
import { sortAccountsForDisplay } from "./format.ts";
import {
	SERVE_TTL_MS,
	collectUsage,
	fullUntil,
	readUsage,
	switchScore,
} from "./usage.ts";
import { runWarm } from "./warm.ts";
import {
	type SyncedCred,
	credOf,
	pullAll,
	pullCred,
	pushAll,
	pushCred,
	syncOn,
	syncReady,
} from "./sync.ts";
import { join } from "node:path";

/** Refresh the access token this long before it expires. */
const ACCESS_BUFFER_MS = 10 * 60_000;
/** Exercise an idle lineage after this long, so the login never lapses. */
export const KEEPALIVE_MS = 20 * 24 * 3_600_000;
/** Cooldown applied when a cap is hit without a server-stated reset. */
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
/** Background sweep cadence (daemon, or a session with no daemon running). */
export const TICK_MS = 5 * 60_000;
/** How often a sweep reconciles with the shared repo. */
const SYNC_SWEEP_MS = 60 * 60_000;
/** Only the in-use account polls in the background; the rest refresh on demand. */
export const ACTIVE_USAGE_MS = 5 * 60_000;
/** How often the background sweep re-reads everything and re-picks the best. */
export const AUTO_SWITCH_MS = 20 * 60_000;
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
export async function setActive(
	label: string,
	opts: { manual?: boolean } = {},
): Promise<boolean> {
	const ok = await mutateStore((store) => {
		if (!findAccount(store, label)) return false;
		store.active = label;
		// A human pin outranks the sweep until that account runs out; an automatic
		// pin must clear the flag, or one manual switch would freeze the pool.
		store.manualPin = opts.manual === true;
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
 * Take a credential another machine published, instead of POSTing our own.
 *
 * This is what makes a shared pool work: refresh tokens are single-use, so two
 * machines refreshing the same lineage means one of them ends up holding a
 * revoked token. Adopting a live access token costs no grant and cannot lose
 * that race.
 *
 * `mode` is what counts as better:
 *   - `newer`: a later access expiry, i.e. a later rotation (the normal path)
 *   - `any`:   any different lineage at all — for the `invalid_grant` rescue,
 *              where ours is already dead so anything else is worth trying
 *
 * Best-effort throughout: a missing repo or a wrong key just returns undefined
 * and the caller refreshes the ordinary way.
 */
async function adoptRemote(
	label: string,
	current: Account,
	mode: "newer" | "any",
	config: SyncConfig,
): Promise<Account | undefined> {
	const remote = await pullCred(label, config);
	if (!remote || remote.refresh === current.refresh) return undefined;
	if (mode === "newer") {
		// Must beat ours AND actually be usable, or adopting solves nothing.
		if (remote.expires <= current.expires) return undefined;
		if (remote.expires <= Date.now() + ACCESS_BUFFER_MS) return undefined;
	}
	const saved = await mutateStore((store) => {
		const account = findAccount(store, label);
		if (!account) return undefined;
		account.refresh = remote.refresh;
		account.access = remote.access;
		account.expires = remote.expires;
		if (remote.refreshExpires) account.refreshExpires = remote.refreshExpires;
		account.lastGrantAt = remote.at;
		account.strikes = 0;
		account.dead = false; // a newer generation proves the lineage is alive
		return account;
	});
	invalidateSnapshot();
	log(`adopted ${label} from ${remote.by} (sync)`);
	return saved;
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

				// Another machine may already have rotated this lineage. Taking its
				// token costs no grant and cannot lose the single-use race.
				const config = readStore().sync;
				if (syncOn(config)) {
					const adopted = await adoptRemote(label, current, "newer", config);
					if (adopted) return adopted;
				}

				const outcome = await withClaudeCodeRefreshLock(() =>
					refreshGrant(current.refresh),
				);
				if (!outcome.credential) {
					// `invalid_grant` means someone else spent this generation. If they
					// published the successor, this is a hiccup rather than a death.
					if (outcome.error === "invalid_grant" && syncOn(config)) {
						const rescued = await adoptRemote(label, current, "any", config);
						if (rescued) return rescued;
					}
					return applyRefreshError(label, outcome.error);
				}

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

				// Publish so the other machines can ride this token instead of
				// spending their own copy of a lineage we just rotated away.
				if (saved && syncOn(config)) {
					const beatUs = await pushCred(credOf(saved), config);
					if (beatUs)
						return (await adoptRemote(label, saved, "newer", config)) ?? saved;
				}
				return saved;
			},
			{ timeoutMs: 45_000, staleMs: 120_000 },
		);
	} catch (e) {
		log(`refresh lock busy for ${label}: ${(e as Error).message}`);
		return findAccount(readStore(), label); // another holder is doing it
	}
}

/**
 * Who to adopt and who to publish in one reconcile pass.
 *
 * `expires` is the version, but it only orders LIVE rotations. A dead lineage
 * keeps the expiry of its last successful grant, which is usually later than
 * whatever a healthy machine published — so ranking on expiry alone made a
 * revoked token outrank the live copy, refuse to adopt, and then overwrite the
 * repo with a credential that cannot be refreshed by anyone.
 */
export function syncPlan(
	accounts: Account[],
	remote: Map<string, SyncedCred>,
): { adopt: Account[]; publish: Account[] } {
	const adopt: Account[] = [];
	const publish: Account[] = [];
	for (const account of accounts) {
		const theirs = remote.get(account.label);
		// Dead: our refresh is spent, so anything published beats it — and ours
		// must never be published at any expiry.
		if (theirs && (account.dead || theirs.expires > account.expires))
			adopt.push(account);
		else if (!account.dead && (!theirs || theirs.expires < account.expires))
			publish.push(account);
	}
	return { adopt, publish };
}

/**
 * Reconcile every account with the shared repo in one pass: adopt whatever is
 * newer there, publish whatever is newer here. Used by the menu's "sync now";
 * the refresh path syncs on its own.
 */
export async function syncNow(): Promise<{
	adopted: number;
	pushed: number;
}> {
	const config = readStore().sync;
	if (!syncReady(config)) return { adopted: 0, pushed: 0 };
	const accounts = readStore().accounts;
	const remote = await pullAll(
		accounts.map((a) => a.label),
		config,
	);

	const { adopt, publish } = syncPlan(accounts, remote);
	let adopted = 0;
	for (const account of adopt)
		if (await adoptRemote(account.label, account, "any", config)) adopted++;
	return { adopted, pushed: await pushAll(publish.map(credOf), config) };
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
/**
 * The account the user sees at the top of `/claude-pool` — one ranking for the
 * list and for the switch, so "best" is never something only the code knows.
 * Falls back to `pickActive` when nothing is usable (soonest cooldown).
 */
export function bestLabel(store: Store, now = Date.now()): string | undefined {
	const ranked = sortAccountsForDisplay(store.accounts, readUsage(), now);
	return ranked.find((a) => usable(a, now))?.label ?? pickActive(store);
}

/** Auto-switch on? Absent means yes: the pool should manage itself by default. */
export const autoSwitchEnabled = (store: Store): boolean =>
	store.autoSwitch !== false;

/**
 * Should the sweep re-pick now? A manual pin holds while it can still serve;
 * once it runs out the pool takes over again, which is the whole point of
 * pinning "until it's full" rather than forever.
 */
export function autoSwitchDue(store: Store, now = Date.now()): boolean {
	if (!autoSwitchEnabled(store)) return false;
	const pinned = store.active ? findAccount(store, store.active) : undefined;
	if (store.manualPin && pinned && usable(pinned, now)) return false;
	return now - (store.autoSwitchAt ?? 0) >= AUTO_SWITCH_MS;
}

export async function pickNext(
	opts: { force?: boolean } = {},
): Promise<string | undefined> {
	const store = readStore();
	// No switch pending: the pinned account still works, so spend nothing.
	// `force` is the periodic sweep, which re-reads precisely to find better.
	const pinned = store.active ? findAccount(store, store.active) : undefined;
	if (!opts.force && pinned && usable(pinned)) return pinned.label;

	const labels = store.accounts.filter((a) => usable(a)).map((a) => a.label);
	if (labels.length > 1) {
		try {
			await collectUsage(labels, tokenFor, { max: labels.length });
			await parkFull(labels);
		} catch {
			/* a failed read must never block the switch — fall back to cache */
		}
	}
	const next = bestLabel(readStore());
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
/**
 * A 429 that is about the MODEL, not the account: the subscription doesn't
 * include it. Every account answers the same, so parking and switching just
 * cascades through the whole pool.
 */
export const MODEL_CREDITS_RE = /usage credits are required/i;
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
	// Disabled accounts are refreshed too: being held out of ROTATION must not
	// let the login itself lapse. Only a dead lineage is skipped.
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
	// Publish live credentials on a cadence, not only when one rotates. A machine
	// that logs in and then idles used to keep its good tokens to itself for the
	// whole 8h access life, so the other machine's copies went invalid_grant
	// before anything was ever pushed. Claimed in the store so N sessions do one
	// fetch between them.
	if (
		syncOn(store.sync) &&
		(await mutateStore((s) => {
			if (now - (s.lastSyncAt ?? 0) < SYNC_SWEEP_MS) return false;
			s.lastSyncAt = now;
			return true;
		}))
	) {
		try {
			const { adopted, pushed } = await syncNow();
			if (adopted || pushed) log(`sync sweep: ${adopted} in, ${pushed} out`);
		} catch (e) {
			log(`sync sweep failed: ${(e as Error).message}`);
		}
	}
	if (opts.usage === false) return;
	// Off by default. One warm-up at most, spaced so the windows it starts stay
	// evenly phased rather than all expiring together.
	await runWarm(tokenFor, log);
	// Only the account in use is polled in the background (every ACTIVE_USAGE_MS,
	// still behind its own 429 backoff). The others are read on demand — `r` in
	// /claude-pool, `cpool list --refresh`.
	const active = pickActive(store);
	if (active && now - (readUsage()[active]?.at ?? 0) >= ACTIVE_USAGE_MS)
		await collectUsage([active], tokenFor, { max: 1 });

	// Claim the window INSIDE the store lock. Checking and then stamping lets
	// every session running in parallel pass the check before the first one
	// writes, so N sessions would each re-pick (and each re-read every
	// account's usage) in the same 20-minute window. Claiming atomically means
	// one sweep total, whichever process gets there first. Stamping before the
	// read also stops a failed read becoming a retry on every tick.
	const claimed = await mutateStore((s) => {
		if (!autoSwitchDue(s, now)) return false;
		s.autoSwitchAt = now;
		return true;
	});
	if (!claimed) return;
	invalidateSnapshot();
	const picked = await pickNext({ force: true });
	if (picked) log(`auto-switch → ${picked}`);
}

/** Long-running single-writer sweep loop (`cpool daemon`). */
export async function runDaemon(
	opts: { tickMs?: number; once?: boolean } = {},
): Promise<void> {
	const tickMs = opts.tickMs ?? TICK_MS;
	const beat = setInterval(() => {
		// A heartbeat write that throws from a timer takes the whole process down.
		try {
			writeJsonAtomic(DAEMON_PATH, { pid: process.pid, at: Date.now() });
		} catch {
			/* next beat retries */
		}
	}, DAEMON_HEARTBEAT_MS);
	writeJsonAtomic(DAEMON_PATH, { pid: process.pid, at: Date.now() });
	try {
		for (;;) {
			try {
				await tick();
			} catch (e) {
				log(`sweep failed: ${(e as Error).message}`);
				if (opts.once) throw e;
			}
			if (opts.once) return;
			await new Promise((r) => setTimeout(r, tickMs));
		}
	} finally {
		clearInterval(beat);
	}
}
