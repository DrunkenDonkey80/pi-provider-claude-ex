/**
 * 5-hour / 7-day / per-model quota reads, with the cadence that keeps them
 * readable.
 *
 * The `/api/oauth/usage` endpoint admits ~28-30 requests per identity per
 * TRAILING 60-minute window and does NOT refill gradually — a burst blocks the
 * account for a full hour (measured by claude-swap's poll_policy). So: a shared
 * on-disk cache with a 180s serve TTL and a 180s minimum interval, at most a
 * couple of accounts per tick, and Retry-After-plus-margin backoff on 429.
 * Every surface (slash command, CLI, daemon, widget) reads the same cache, so
 * repainting a list costs zero requests.
 */

import { USAGE_PATH, readJson, withLock, writeJsonAtomic } from "./store.ts";
import {
	UsageHttpError,
	fetchUsage,
	type UsageSnapshot,
	type UsageWindow,
} from "./oauth.ts";

export const SERVE_TTL_MS = 180_000;
const MIN_INTERVAL_MS = 180_000;
const MAX_INTERVAL_MS = 3_600_000;
// A lapsed 429 block frequently re-blocks right at its stated deadline, so wait
// past it rather than exactly to it.
const RETRY_AFTER_MARGIN_MS = 60_000;

export interface UsageEntry extends UsageSnapshot {
	/** When these numbers were fetched (epoch ms). */
	at?: number;
	nextPollAt?: number;
	intervalMs?: number;
	error?: string;
}
export type UsageCache = Record<string, UsageEntry>;

export const readUsage = (): UsageCache => readJson<UsageCache>(USAGE_PATH, {});

async function patchUsage(label: string, patch: UsageEntry): Promise<void> {
	try {
		await withLock(USAGE_PATH, () => {
			const cache = readUsage();
			// Merge, so last-known windows survive an error pass (fail safe:
			// trusting stale numbers beats showing none).
			cache[label] = { ...cache[label], ...patch };
			writeJsonAtomic(USAGE_PATH, cache);
		});
	} catch {
		/* the cache is an optimization; never break a caller over it */
	}
}

/**
 * Reserve a label's next poll, atomically. Returns false when someone else
 * already holds it.
 *
 * The slot is held for the normal interval; the success/failure patch that
 * follows overwrites it with the real backoff moments later. So a process that
 * dies mid-fetch costs one skipped interval, never a permanently stuck label.
 */
async function claimPoll(
	label: string,
	now: number,
	force: boolean,
): Promise<boolean> {
	try {
		return await withLock(USAGE_PATH, () => {
			const cache = readUsage();
			const entry = cache[label];
			if (!force && (entry?.nextPollAt ?? 0) > now) return false;
			cache[label] = { ...entry, nextPollAt: now + MIN_INTERVAL_MS };
			writeJsonAtomic(USAGE_PATH, cache);
			return true;
		});
	} catch {
		// Lock busy or unreadable: assume another process is on it. Skipping a
		// poll is free; double-polling is what we're here to prevent.
		return false;
	}
}

const W5_MS = 5 * 3_600_000;
const W7_MS = 7 * 24 * 3_600_000;
/** A window at or above this counts as spent (the server rounds percentages). */
const FULL_PCT = 99;
/** How long to park an account that reads full but states no reset time. */
const APPEARS_FULL_MS = 3_600_000;

/** Time left in a window; a whole window when the server states no reset. */
function resetsIn(
	w: UsageWindow | undefined,
	windowMs: number,
	now: number,
): number {
	const at = w?.resets_at ? Date.parse(w.resets_at) : Number.NaN;
	return Number.isFinite(at)
		? Math.max(0, Math.min(windowMs, at - now))
		: windowMs;
}

/**
 * How badly an account wants to be used: per window, the quota left minus the
 * time left to spend it, both as fractions — so the 5h and 7d windows compare
 * directly with no unit juggling.
 *
 *   > 0  more quota than time → use it or lose it
 *   < 0  ahead of budget → save it for later in the window
 *
 * So a 5h window about to reset with quota unspent wins, while "70% of the week
 * gone with 3 days left" (0.30 left vs 0.43 of the week) scores negative and
 * gets held back. Weights tuned in pick-sim.py (7d:5h = 1:2 — a plateau across
 * 0.5-1.5, not a peak, so don't over-tune). An unknown account scores 0:
 * neutral, behind any account with a proven surplus.
 *
 * Three terms, because "“should I use this account" is three questions:
 *
 *   slack_7d          strategic: is this week's quota going to waste?
 *   2 * max(0, s_5h)  opportunistic: a 5h window about to reset with quota on
 *                     it — a bonus only. Drained is a TEMPORARY state that
 *                     `parkFull` already benches, so it must not go negative:
 *                     it buried 100%-of-5h-but-13%-of-the-week-left-with-2-days
 *                     at -1.12, behind accounts with nothing left to spend.
 *   0.5 * free_5h     practical: can it actually serve right now, or does it
 *                     stall in ten minutes? Capped well under the weekly term,
 *                     so it breaks ties instead of driving the choice.
 */
export function switchScore(
	entry: UsageEntry | undefined,
	now = Date.now(),
): number {
	const slack = (w: UsageWindow | undefined, windowMs: number): number =>
		typeof w?.pct === "number"
			? 1 - w.pct / 100 - resetsIn(w, windowMs, now) / windowMs
			: 0;
	const free5h =
		typeof entry?.five_hour?.pct === "number" ? 1 - entry.five_hour.pct / 100 : 0;
	return (
		slack(entry?.seven_day, W7_MS) +
		2 * Math.max(0, slack(entry?.five_hour, W5_MS)) +
		0.5 * free5h
	);
}

/**
 * When a full-looking account frees up again, or undefined if it has room.
 * Lets a fresh read park an account BEFORE we switch into a 429 — the usual
 * cause being another machine draining it since our last read.
 */
export function fullUntil(
	entry: UsageEntry | undefined,
	now = Date.now(),
): number | undefined {
	const windows = [
		[entry?.five_hour, W5_MS],
		[entry?.seven_day, W7_MS],
	] as const;
	for (const [w, windowMs] of windows) {
		if (typeof w?.pct !== "number" || w.pct < FULL_PCT) continue;
		const at = w.resets_at ? Date.parse(w.resets_at) : Number.NaN;
		// No stated reset: park it for an hour rather than retry into the wall.
		return Number.isFinite(at)
			? Math.min(at, now + windowMs)
			: now + APPEARS_FULL_MS;
	}
	return undefined;
}

/**
 * Fetch usage for the accounts that are due, oldest-first, at most `max` per
 * call. `getToken` supplies a valid access token (and is where token refresh
 * happens — this module never touches credentials).
 */
export async function collectUsage(
	labels: string[],
	getToken: (label: string) => Promise<string | undefined>,
	opts: { max?: number; force?: boolean } = {},
): Promise<void> {
	const max = opts.max ?? 2;
	const cache = readUsage();
	const now = Date.now();
	const due = labels
		.filter((l) => opts.force || (cache[l]?.nextPollAt ?? 0) <= now)
		.sort((a, b) => (cache[a]?.at ?? 0) - (cache[b]?.at ?? 0))
		.slice(0, max);

	// Same escalating wait for every failure kind, so a dead account isn't
	// re-probed (and its token re-refreshed) every single tick.
	const backoffFrom = (label: string, retryAfterMs?: number): number =>
		retryAfterMs ??
		Math.min(
			MAX_INTERVAL_MS,
			Math.max(MIN_INTERVAL_MS, (cache[label]?.intervalMs ?? MIN_INTERVAL_MS) * 2),
		);

	for (const label of due) {
		// Reserve the slot before spending a request on it. `due` came from a
		// snapshot, so N processes waking together all see the same label as due
		// and would all fetch it. Claiming under the cache lock means one wins
		// and the rest skip.
		if (!(await claimPoll(label, Date.now(), opts.force === true))) continue;
		const token = await getToken(label);
		if (!token) {
			const backoff = backoffFrom(label);
			await patchUsage(label, {
				error: "no-access-token",
				intervalMs: backoff,
				nextPollAt: Date.now() + backoff,
			});
			continue;
		}
		try {
			const snapshot = await fetchUsage(token);
			await patchUsage(label, {
				...snapshot,
				at: Date.now(),
				error: undefined,
				intervalMs: MIN_INTERVAL_MS,
				nextPollAt: Date.now() + MIN_INTERVAL_MS,
			});
		} catch (e) {
			// A lapsed 429 often re-blocks right at its deadline: wait past it.
			const backoff = backoffFrom(
				label,
				e instanceof UsageHttpError &&
					e.status === 429 &&
					e.retryAfterS !== undefined
					? e.retryAfterS * 1000 + RETRY_AFTER_MARGIN_MS
					: undefined,
			);
			await patchUsage(label, {
				error: e instanceof UsageHttpError ? `http-${e.status}` : "network",
				intervalMs: backoff,
				nextPollAt: Date.now() + backoff,
			});
		}
	}
}
