/**
 * Locked, crash-safe store for the Claude account pool.
 *
 * WHY THIS FILE EXISTS
 *   Anthropic ROTATES refresh tokens: a successful grant returns a new
 *   refresh_token and invalidates the one you POSTed. Upstream kept the pool in
 *   per-process memory and rewrote the whole file with writeFileSync, so two pi
 *   sessions (or pi + Claude Code + claude-swap) would each POST the same
 *   generation — the loser got `invalid_grant` and its rotated successor was
 *   clobbered. That is why pooled accounts "constantly expired".
 *
 *   Fixes, all cross-process:
 *     - directory (mkdir) advisory lock around every read-modify-write
 *     - per-lineage refresh lock held ACROSS the token POST (same shape as
 *       Claude Code's own `.oauth_refresh.lock`), with a consume-gate re-read
 *       inside the lock so a spent generation is never POSTed
 *     - a successor stash written BEFORE the main store write, so a crash
 *       between the POST and the write cannot lose the new refresh token
 *     - best-effort cooperation with Claude Code's real refresh lock when a
 *       `~/.claude/.credentials.json` exists on the machine
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Account {
	label: string;
	refresh: string;
	access: string;
	/** Access-token expiry (epoch ms). Short-lived, refreshed automatically. */
	expires: number;
	/** Login (refresh-token) expiry, epoch ms — the date that actually matters. */
	refreshExpires?: number;
	/** Last successful grant, epoch ms. Drives keep-alive scheduling. */
	lastGrantAt?: number;
	/** Held out of rotation by the user. Still a valid explicit switch target. */
	disabled?: boolean;
	/** Refresh lineage revoked (`invalid_grant`) — needs /login + re-add. */
	dead?: boolean;
	/** Rate/usage capped until this epoch ms. */
	cooldownUntil?: number;
	/** Anthropic identity, from /api/oauth/profile. Lets a fresh `/login
	 * anthropic` be re-attached to the right pool entry automatically.
	 * The key is (uuid, orgUuid): one email can hold several subscriptions,
	 * each with its own quota, so email alone would merge two pools. */
	uuid?: string;
	orgUuid?: string;
	email?: string;
	/** Display only: org name and plan (pro/max/team). */
	org?: string;
	plan?: string;
	/** Consecutive transient refresh failures (never permanent). */
	strikes?: number;
}

/**
 * Shared-repo credential sync. `key` is the AES secret every machine must
 * hold: it travels in the export, never in the repo.
 */
export interface SyncConfig {
	url: string;
	key: string;
	/** Absent/true = on. Off keeps the url+key so it can be re-enabled. */
	on?: boolean;
}

export interface Store {
	enabled?: boolean;
	/** Push/pull credentials through a git repo shared with other machines. */
	sync?: SyncConfig;
	/** Label of the pinned active account (sticky across restarts). */
	active?: string;
	/** Re-pick the best account in the background. Default ON (undefined = on). */
	autoSwitch?: boolean;
	/** The pin was a human choice: hold it until that account runs out. */
	manualPin?: boolean;
	/** Epoch ms of the last automatic re-pick, so the sweep keeps its cadence. */
	autoSwitchAt?: number;
	/**
	 * How many 5h windows to keep already running. Absent/0 = off; `all` warms
	 * every eligible account. Costs a token of weekly quota per warm-up.
	 */
	warm?: number | "all";
	/** Epoch ms of the last warm-up, so window starts stay staggered. */
	warmAt?: number;
	/**
	 * Override the gap between warm-ups. Default is 5h/N, which is the spacing
	 * that keeps N windows evenly phased; anything shorter fills the pool faster
	 * but bunches the expiries back together.
	 */
	warmEveryMs?: number;
	accounts: Account[];
}

export const AGENT_DIR =
	process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const POOL_PATH = join(AGENT_DIR, "claude-pool.json");
export const STASH_PATH = join(AGENT_DIR, "claude-pool.stash.json");
export const USAGE_PATH = join(AGENT_DIR, "claude-pool-usage.json");
export const DAEMON_PATH = join(AGENT_DIR, "claude-pool-daemon.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Lineage identity: survives access-token rotation, changes on re-login. */
export function fingerprint(refresh: string): string {
	return createHash("sha256").update(refresh).digest("hex").slice(0, 12);
}

// ─── locking ────────────────────────────────────────────────────────────────
// mkdir is the mutex (same primitive as npm proper-lockfile, which is what
// Claude Code uses), so the lock works across processes and languages.

export async function withDirLock<T>(
	lockDir: string,
	fn: () => Promise<T> | T,
	opts: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const staleMs = opts.staleMs ?? 60_000; // Claude Code's credential-lock staleness
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			mkdirSync(lockDir, { recursive: false });
			break;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			try {
				// A lock older than staleMs has no live holder (holders touch it).
				if (Date.now() - statSync(lockDir).mtimeMs > staleMs) {
					rmSync(lockDir, { recursive: true, force: true });
					continue;
				}
			} catch {
				continue; // vanished between stat and now — retry the mkdir
			}
			if (Date.now() > deadline) throw new Error(`lock busy: ${lockDir}`);
			await sleep(40 + Math.random() * 90); // jitter: don't convoy
		}
	}
	// Touch faster than the 5s cadence Claude Code uses, so a long hold is
	// never mistaken for stale by a contender.
	const touch = setInterval(() => {
		try {
			const now = new Date();
			utimesSync(lockDir, now, now);
		} catch {
			/* lock already released */
		}
	}, 3_000);
	touch.unref?.();
	try {
		return await fn();
	} finally {
		clearInterval(touch);
		try {
			rmSync(lockDir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}

export const withLock = <T>(
	path: string,
	fn: () => Promise<T> | T,
	opts?: { timeoutMs?: number; staleMs?: number },
): Promise<T> => withDirLock(`${path}.lock`, fn, opts);

/**
 * Best-effort cooperation with Claude Code's own OAuth refresh lock, so a
 * shared account's lineage can't be rotated by `claude` and by us at once.
 * Skipped (never blocks) when Claude Code isn't installed or the lock is busy.
 */
export async function withClaudeCodeRefreshLock<T>(
	fn: () => Promise<T> | T,
): Promise<T> {
	const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
	if (!existsSync(join(home, ".credentials.json"))) return fn();
	try {
		return await withDirLock(join(home, ".oauth_refresh.lock"), fn, {
			timeoutMs: 9_000,
			staleMs: 60_000,
		});
	} catch {
		return fn(); // cooperative, not mandatory
	}
}

// ─── json io ────────────────────────────────────────────────────────────────

export function readJson<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return fallback; // missing or torn/partial read → caller's default
	}
}

export function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
	renameSync(tmp, path); // atomic: readers never see a half-written store
}

// ─── successor stash ────────────────────────────────────────────────────────
// A rotated credential lands here first. If the main store write then fails
// (crash, EPERM, full disk), the next read adopts it instead of POSTing the
// spent predecessor — the failure mode that permanently killed lineages.

interface StashEntry {
	refresh: string;
	access: string;
	expires: number;
	refreshExpires?: number;
	at: number;
}
type Stash = Record<string, StashEntry>;

export function stashPut(label: string, entry: Omit<StashEntry, "at">): void {
	const stash = readJson<Stash>(STASH_PATH, {});
	stash[label] = { ...entry, at: Date.now() };
	writeJsonAtomic(STASH_PATH, stash);
}

export function stashDrop(label: string, refresh: string): void {
	const stash = readJson<Stash>(STASH_PATH, {});
	// Only retire the generation we actually persisted: a concurrent grant may
	// have stashed a newer one that must survive.
	if (stash[label]?.refresh !== refresh) return;
	delete stash[label];
	writeJsonAtomic(STASH_PATH, stash);
}

/** Read the store, adopting any stashed successor the main write missed. */
export function readStore(): Store {
	const store = readJson<Store>(POOL_PATH, { accounts: [] });
	if (!Array.isArray(store.accounts)) store.accounts = [];
	const stash = readJson<Stash>(STASH_PATH, {});
	for (const acct of store.accounts) {
		const s = stash[acct.label];
		if (!s || s.refresh === acct.refresh) continue;
		acct.refresh = s.refresh;
		acct.access = s.access;
		acct.expires = s.expires;
		if (s.refreshExpires) acct.refreshExpires = s.refreshExpires;
		acct.lastGrantAt = s.at;
		acct.dead = false; // a stashed successor is proof the lineage was alive
	}
	return store;
}

/**
 * Read-modify-write the store under the file lock. The mutator gets the CURRENT
 * on-disk state (never a process-local snapshot), so concurrent sessions merge
 * instead of clobbering.
 */
export async function mutateStore<T>(
	mutate: (store: Store) => T,
	opts?: { timeoutMs?: number },
): Promise<T> {
	return withLock(
		POOL_PATH,
		() => {
			const store = readStore();
			const result = mutate(store);
			store.enabled = store.enabled !== false;
			writeJsonAtomic(POOL_PATH, store);
			return result;
		},
		opts,
	);
}

/**
 * Accounts out of an export's text — `{accounts:[...]}` or a bare array.
 * Only label+refresh matter; a refresh token is what survives a machine move.
 * Throws on anything that yields no usable account.
 */
export function parseExport(text: string): Account[] {
	let data: Account[] | { accounts?: Account[] };
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error("not valid JSON");
	}
	const accounts = Array.isArray(data) ? data : data?.accounts;
	const valid = (accounts ?? []).filter(
		(a) => typeof a?.label === "string" && typeof a?.refresh === "string",
	);
	if (!valid.length)
		throw new Error("no accounts with a label and refresh token");
	return valid;
}

/**
 * Sync setup out of an export's text, if it carried one. Undefined rather than
 * throwing: an export written before sync existed is still a valid export.
 */
export function parseSyncConfig(text: string): SyncConfig | undefined {
	try {
		const sync = (JSON.parse(text) as { sync?: SyncConfig })?.sync;
		return typeof sync?.url === "string" && typeof sync.key === "string"
			? { url: sync.url, key: sync.key, on: sync.on !== false }
			: undefined;
	} catch {
		return undefined;
	}
}

export const findAccount = (store: Store, label: string): Account | undefined =>
	store.accounts.find((a) => a.label === label);
