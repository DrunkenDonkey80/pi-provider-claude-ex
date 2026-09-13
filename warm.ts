/**
 * Keep a few 5h windows already running (off by default).
 *
 * The 5h window is created by the first billable request and ends exactly 5h
 * later — an account that has never been touched shows no reset clock at all.
 * That makes an untouched account a liability for burst work: start it, drain
 * the quota in 30 minutes, and you are locked out for the remaining 4h30m. An
 * account whose window started hours ago costs the same 30 minutes of work and
 * then resets almost immediately.
 *
 * So: send one minimal request to the top few accounts whose window has not
 * started, and arrive mid-window instead of at its start.
 *
 * Three things this must not do:
 *
 *   - warm everything at once. N windows started in the same sweep expire in
 *     the same minute, so the pool goes from "always one about to reset" to
 *     "all of them dead for 4h30m". Warms are spaced 5h/N apart so the windows
 *     stay evenly phased — the same convoy problem as the sweep timer, one
 *     layer up.
 *   - warm an account the user disabled, or one that is dead, cooling, or
 *     nearly out of WEEKLY quota. Disabled means "not in rotation", and
 *     spending someone's weekly quota to start a window they did not ask for
 *     is the one cost here that does not come back.
 *   - warm blind. An account we have never read usage for has an unknown
 *     window state; a missing `resets_at` in that case means "no data", not
 *     "not started".
 */

import { sortAccountsForDisplay } from "./format.ts";
import { UsageHttpError, warmSession } from "./oauth.ts";
import { type Account, type Store, mutateStore, readStore } from "./store.ts";
import { type UsageCache, collectUsage, readUsage } from "./usage.ts";

const WINDOW_5H = 5 * 3_600_000;
/** Past this much of the week spent, a warm-up is not worth the quota. */
const WEEK_FULL_PCT = 90;

/** How many windows to keep warm: 0 = off, or `all` for every eligible one. */
export function warmLimit(store: Store): number {
	if (store.warm === "all") return Number.POSITIVE_INFINITY;
	return typeof store.warm === "number" && store.warm > 0 ? store.warm : 0;
}

/**
 * A 5h window that has not started yet: no reset clock AND nothing spent.
 * Requires a real usage read — without one, "no clock" only means "no data".
 */
export function windowUnstarted(cache: UsageCache, label: string): boolean {
	const entry = cache[label];
	if (!entry?.at) return false;
	return !entry.five_hour?.resets_at && (entry.five_hour?.pct ?? 0) === 0;
}

/** Accounts warming is allowed to touch at all. */
const eligible = (store: Store, cache: UsageCache, now: number): Account[] =>
	store.accounts.filter(
		(a) =>
			!a.dead &&
			!a.disabled &&
			(a.cooldownUntil ?? 0) <= now &&
			(cache[a.label]?.seven_day?.pct ?? 0) < WEEK_FULL_PCT,
	);

/**
 * The unstarted windows worth warming, best first — the same ranking the list
 * and the picker use, so warming follows the order you already see.
 */
export function warmTargets(
	store: Store,
	cache: UsageCache,
	now = Date.now(),
): Account[] {
	const limit = warmLimit(store);
	if (limit === 0) return [];
	return sortAccountsForDisplay(eligible(store, cache, now), cache, now)
		.filter((a) => windowUnstarted(cache, a.label))
		.slice(0, limit);
}

/**
 * Gap between warm-ups. Based on how many windows we intend to keep warm, not
 * how many are cold right now: the goal is N windows evenly phased across the
 * 5 hours, so each start lands 5h/N after the last one.
 */
export function warmSpacingMs(
	store: Store,
	cache: UsageCache,
	now = Date.now(),
): number {
	const plan = Math.min(warmLimit(store), eligible(store, cache, now).length);
	return WINDOW_5H / Math.max(1, plan);
}

/**
 * Send one warm-up if one is due. At most one per sweep, whichever process
 * gets there first: the spacing is claimed inside the store lock, because N
 * parallel sessions would otherwise each send their own.
 *
 * On success the account's usage is re-read immediately, so the started window
 * is visible to every session (and cannot be warmed twice off a stale cache).
 */
export async function runWarm(
	getToken: (label: string) => Promise<string | undefined>,
	log: (msg: string) => void = () => {},
): Promise<string | undefined> {
	const now = Date.now();
	const cache = readUsage();
	const store = readStore();
	const target = warmTargets(store, cache, now)[0];
	if (!target) return undefined;
	const spacing = warmSpacingMs(store, cache, now);

	let previous: number | undefined;
	const claimed = await mutateStore((s) => {
		if ((s.warmAt ?? 0) + spacing > now) return false;
		previous = s.warmAt;
		s.warmAt = now;
		return true;
	});
	if (!claimed) return undefined;

	// A warm-up that never happened must not hold the slot: releasing it lets
	// the next sweep retry instead of waiting out the full 5h/N gap. Only the
	// claim we made is released, so a newer claim by another process survives.
	const release = () =>
		mutateStore((s) => {
			if (s.warmAt === now) s.warmAt = previous;
		});

	const token = await getToken(target.label);
	if (!token) {
		await release();
		return undefined;
	}
	try {
		await warmSession(token);
		log(`warmed 5h window on ${target.label}`);
	} catch (e) {
		log(
			`warm-up failed for ${target.label}: ${
				e instanceof UsageHttpError ? `http-${e.status}` : "network"
			}`,
		);
		await release();
		return undefined;
	}
	// Confirm the window actually started, and stop a stale cache re-warming it.
	try {
		await collectUsage([target.label], getToken, { max: 1, force: true });
	} catch {
		/* the warm-up already landed; a failed read must not undo it */
	}
	return target.label;
}
