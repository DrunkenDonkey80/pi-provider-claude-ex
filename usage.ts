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

import {
	USAGE_PATH,
	readJson,
	withLock,
	writeJsonAtomic,
} from "./store.ts";
import { UsageHttpError, fetchUsage, type UsageSnapshot } from "./oauth.ts";

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

/** Remaining quota headroom (0-100) from the tightest known window. */
export function headroom(entry: UsageEntry | undefined): number | undefined {
	const pcts = [entry?.five_hour?.pct, entry?.seven_day?.pct].filter(
		(p): p is number => typeof p === "number",
	);
	if (!pcts.length) return undefined;
	return 100 - Math.max(...pcts);
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
				e instanceof UsageHttpError && e.status === 429 && e.retryAfterS !== undefined
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
