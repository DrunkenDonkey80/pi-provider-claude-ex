/** Shared rendering for the slash commands, the CLI and the status widget. */

import type { Account } from "./store.ts";
import {
	SERVE_TTL_MS,
	type UsageEntry,
	type UsageCache,
	upcomingNightMs,
} from "./usage.ts";

export function relative(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 90) return `${s}s`;
	const m = Math.round(s / 60);
	// Switch to hours at 60, not 90: "71m" next to a sibling's "4h 51m" reads as
	// a different unit at a glance, and can't align under a fixed-width clock.
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 36) return `${h}h ${m % 60}m`;
	return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Fixed-width reset clock. Single-unit values are padded on the LEFT so the
 * number lands in the same column as a two-unit row's smaller unit: `55m`
 * under the `15m` of `2h 15m`, not floating out at the left edge.
 */
function clockRelative(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 90) return `    ${String(s).padStart(2)}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `    ${String(m).padStart(2)}m`;
	const h = Math.floor(m / 60);
	if (h < 36) return `${String(h).padStart(2)}h ${String(m % 60).padStart(2)}m`;
	return `${String(Math.floor(h / 24)).padStart(2)}d ${String(h % 24).padStart(2)}h`;
}

const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const blue = (s: string) => `\x1b[34m${s}\x1b[0m`;

/** Yellow past half the window, red past three quarters. */
function quotaColor(pct: number, s: string): string {
	if (pct > 75) return red(s);
	if (pct > 50) return yellow(s);
	return s;
}

/** A window is "drained" once this much is spent — see clockColor. */
const DRAINED_PCT = 80;

/**
 * Colour the reset clock by how soon it fires, so a window about to roll over
 * is obvious at a glance. Only while quota is left to lose: past DRAINED_PCT
 * the window is spent, and an imminent reset is good news, not a warning.
 */
function clockColor(
	msLeft: number,
	pct: number,
	redAt: number,
	yellowAt: number,
	s: string,
): string {
	if (pct >= DRAINED_PCT) return s;
	if (msLeft <= redAt) return red(s);
	if (msLeft <= yellowAt) return yellow(s);
	return s;
}

/**
 * Every field is padded to a fixed width so the columns line up down the list.
 * Padding happens BEFORE colouring — ANSI escapes count as characters to
 * padStart/padEnd, so a coloured cell padded afterwards comes out short.
 * Clock numbers are independently right-aligned: " 5h  3m" / "12h  3m" and
 * " 2d  1h" / " 2d 16h". Widest percent is "100" (3).
 */
const CLOCK_W = 7;
const PCT_W = 3;
const BLANK_CLOCK = " ".repeat(CLOCK_W + 2); // the "(" and ")" too

function window(
	name: string,
	w: { pct: number; resets_at?: string } | undefined,
	redAt: number,
	yellowAt: number,
): string {
	if (!w)
		return `${name}${BLANK_CLOCK} [${"─".repeat(8)}] ${"—".padStart(PCT_W + 1)}`;
	const pct = Math.round(w.pct);
	const filled = Math.round((pct / 100) * 8);
	const bar = "█".repeat(filled) + "░".repeat(8 - filled);
	const at = w.resets_at ? Date.parse(w.resets_at) : Number.NaN;
	// The clock and the bar are coloured independently: one says "time is running
	// out", the other "quota is running out". They are not the same warning.
	const clock = Number.isFinite(at)
		? clockColor(
				at - Date.now(),
				pct,
				redAt,
				yellowAt,
				`(${clockRelative(at - Date.now())})`,
			)
		: BLANK_CLOCK;
	return `${name}${clock} ${quotaColor(pct, `[${bar}] ${String(pct).padStart(PCT_W)}%`)}`;
}

export function accountState(account: Account, now = Date.now()): string {
	if (account.dead) return "dead (re-login)";
	if (account.disabled) return "disabled";
	if ((account.cooldownUntil ?? 0) > now)
		return `cooling ${relative((account.cooldownUntil ?? 0) - now)}`;
	return "ok";
}

/** One line per account: quota windows, state, and login lifetime. */
export function accountLine(
	account: Account,
	index: number,
	entry: UsageEntry | undefined,
	isActive: boolean,
): string {
	const state = accountState(account);
	const paint = account.favorite ? green : account.weekend ? blue : String;
	// Plan/email are shown because one email can hold several subscriptions:
	// without them two rows for the same person are indistinguishable.
	const id = [
		account.email && !account.label.includes(account.email) ? account.email : "",
		account.plan ? `[${account.plan}]` : "",
	]
		.filter(Boolean)
		.join(" ");
	// Fixed-width fields first so the quota columns line up down the list; the
	// variable-length label/email goes last, where ragged ends cost nothing.
	const parts = [
		paint(
			`${isActive ? "▸" : " "} ${index + 1}. ${priorityMark(account.priority).padEnd(2)}`,
		),
		window("5h", entry?.five_hour, HOUR, 2 * HOUR),
		window("7d", entry?.seven_day, DAY, 2 * DAY),
		loginTag(account, entry),
		resetsCell(entry),
	];
	if (account.weekend) {
		const w = weekendState(entry);
		parts.push(
			blue(
				w.state === "drain" ? `wknd drain to ${Math.ceil(w.floor ?? 0)}%` : `wknd ${w.state}`,
			),
		);
	}
	for (const s of entry?.scoped ?? [])
		parts.push(`${s.name} ${Math.round(s.pct)}%`);
	if (entry?.spend)
		parts.push(
			`spend ${entry.spend.used.toFixed(2)}/${entry.spend.limit.toFixed(2)} ${entry.spend.currency}`,
		);
	if (state !== "ok" && !account.dead) parts.push(state); // DEAD says it already
	parts.push(
		paint(`${account.label}${id ? ` ${id}` : ""}`),
	);
	if (entry?.error) parts.push(`usage: ${entry.error}`);
	else if (entry?.at && Date.now() - entry.at > SERVE_TTL_MS)
		parts.push(`as of ${relative(Date.now() - entry.at)} ago`);
	else if (!entry?.at) parts.push("usage: not fetched yet");
	return parts.join(" · ");
}

/** Login health, fixed width: [DEAD] revoked, [ERROR] expired or auth refused. */
function loginTag(account: Account, entry: UsageEntry | undefined): string {
	if (account.dead) return red("[DEAD] ");
	const authFail = /^(http-401|http-403|no-access-token)$/.test(entry?.error ?? "");
	if (authFail || (account.refreshExpires ?? Number.POSITIVE_INFINITY) <= Date.now())
		return yellow("[ERROR]");
	return "[OK]   ";
}

/** Saved limit resets: "?" = unknown/ineligible, red under 3 days to expiry. */
function resetsCell(entry: UsageEntry | undefined): string {
	const W = 18; // "resets 1 (12d  3h)"
	const r = entry?.resets;
	if (!r || r.why) return "resets ?".padEnd(W);
	const now = Date.now();
	const live = r.grants.filter((g) => !g.ends_at || Date.parse(g.ends_at) > now);
	const count = live.reduce((n, g) => n + g.left, 0);
	const ends = live.map((g) => (g.ends_at ? Date.parse(g.ends_at) : Number.POSITIVE_INFINITY));
	const next = Math.min(...ends);
	if (!count || !Number.isFinite(next)) return `resets ${count}`.padEnd(W);
	const s = `resets ${count} (${clockRelative(next - now)})`.padEnd(W);
	return next - now < 3 * DAY ? red(s) : s;
}

const resetAt = (iso: string | undefined): number => {
	const at = iso ? Date.parse(iso) : Number.NaN;
	return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
};

const WINDOW_5H = 5 * HOUR;
/** What an entirely unused week is worth, expressed as time-to-reset. */
const WEEKLY_QUOTA_WEIGHT = 4.4 * DAY;
/** What an about-to-reset 5h window is worth, same units. */
const FIVE_H_NUDGE = 2 * DAY;
/**
 * What a + is worth: the account ranks as if its week reset 2 days sooner.
 * Big enough that + drains before a fresh-ish normal account, small enough
 * that a normal one about to lose real quota still goes first — e.g. 25% left
 * with under ~1.7d, or 50% left with under ~2.8d, beats an untouched + week.
 */
const PRIORITY_WEIGHT = 2 * DAY;
/** Below this much real time left on the week, the deadline slope doubles. */
const URGENT_MS = 12 * HOUR;

export const priorityMark = (p = 0): string =>
	p > 0 ? "+".repeat(p) : "-".repeat(-p);

/** ++ is its own tier ahead of everything ready, -- its own tier behind it. */
const priorityTier = (p: number): number => (p >= 2 ? 0 : p <= -2 ? 2 : 1);

/** Office hours, local time: Mon-Fri 09:00-18:00. */
const OFFICE_START = 9;
const OFFICE_END = 18;
/** Heavy use empties a week in this many office days; sizes the weekend floor. */
const DRAIN_DAYS = 2;

/** Office milliseconds in [from, to), one local day at a time (DST-safe). */
export function officeMs(from: number, to: number): number {
	let ms = 0;
	const d = new Date(from);
	d.setHours(0, 0, 0, 0);
	for (; d.getTime() < to; d.setDate(d.getDate() + 1)) {
		if (d.getDay() === 0 || d.getDay() === 6) continue;
		const start = new Date(d).setHours(OFFICE_START);
		const end = new Date(d).setHours(OFFICE_END);
		ms += Math.max(0, Math.min(end, to) - Math.max(start, from));
	}
	return ms;
}

function nextOfficeStart(now: number): number {
	const d = new Date(now);
	d.setHours(OFFICE_START, 0, 0, 0);
	while (d.getDay() === 0 || d.getDay() === 6 || d.getTime() <= now)
		d.setDate(d.getDate() + 1);
	return d.getTime();
}

/**
 * A weekend account is a reserve for office hours, drained in free time down
 * to a floor that covers the office hours left before its 7d reset at peak
 * burn (a full week in DRAIN_DAYS office days). A fresh week therefore locks
 * itself, and a reset before the next office start floors at 0: drain it all.
 * Free-time use must not leave a 5h window open into the next office start.
 */
export function weekendState(
	entry: UsageEntry | undefined,
	now = Date.now(),
): { state: "drain" | "locked" | "reserve"; floor?: number } {
	if (officeMs(now, now + 1)) return { state: "reserve" };
	const pct7 = entry?.seven_day?.pct;
	if (typeof pct7 !== "number") return { state: "locked" };
	// Unknown or already-passed reset = a fresh week the cache hasn't seen: hold.
	const reset7 = resetAt(entry?.seven_day?.resets_at);
	const weekEnd = reset7 > now && Number.isFinite(reset7) ? reset7 : now + 7 * DAY;
	const floor = Math.min(
		100,
		(officeMs(now, weekEnd) * 100) / (DRAIN_DAYS * (OFFICE_END - OFFICE_START) * HOUR),
	);
	const office = nextOfficeStart(now);
	const reset5 = resetAt(entry?.five_hour?.resets_at);
	const fits5 =
		Number.isFinite(reset5) && reset5 > now ? reset5 <= office : now + WINDOW_5H <= office;
	return { state: 100 - pct7 > floor && fits5 ? "drain" : "locked", floor };
}

/** A weekend account outside its drain: behind even --, last resort only. */
export const WEEKEND_HELD = 3;

/** Favorites first, then a draining weekend account, then ++ .. --. */
export const accountTier = (
	a: Account,
	entry: UsageEntry | undefined,
	now = Date.now(),
): number => {
	if (a.favorite) return -2;
	if (a.weekend) return weekendState(entry, now).state === "drain" ? -1 : WEEKEND_HELD;
	return priorityTier(a.priority ?? 0);
};

/**
 * Where a usable account belongs in the list — lower goes first.
 *
 *   rank = time_left_7d
 *        - WEEKLY_QUOTA_WEIGHT * quota_left_7d
 *        - FIVE_H_NUDGE * gate * (1 - time_left_5h / 5h)
 *
 * Time to the weekly reset is the spine: that is the deadline the quota dies
 * on. Unused quota then pulls an account earlier, because a week that is 20%
 * spent has more going to waste than one that is 80% spent.
 *
 * The weight on unused quota is what took tuning, and two real orderings pin it
 * from both sides (both are tests):
 *
 *   3d15h out at 26% used must beat peers 2d out at 60-66%: 40 points of
 *   unspent week outweighs a day of deadline            ->  k > 4.32d
 *
 *   2d10h out at 53% must beat 3d20h out at 23%: there the deadline gap is
 *   wide enough to win                                  ->  k < 4.50d
 *
 * 4.4d sits between them. Charging a full week (the natural "slack"
 * formulation, quota_left - time_left/7d) lets idleness dominate outright: an
 * account resetting in SIX days at 13% used outranked accounts with half the
 * time left, and six days is ample runway to spend it later. Raise k toward 7d
 * to favour draining under-used accounts, lower it toward 1d to rank almost
 * purely by deadline — but the window above is narrow, so re-run both tests.
 *
 * A 5h window about to roll over is free capacity: drain it now and a fresh one
 * opens immediately. So among accounts close on the week, the one whose 5h
 * window expires soonest comes first. `gate` is a threshold, not a factor —
 * scaling by remaining 5h quota would make the right cap depend on 5h usage, so
 * no single constant could order every case. Nearly drained means nothing to
 * drain, so no nudge.
 */
const readyRank = (
	r: {
		reset7: number;
		reset5: number;
		pct5: number;
		pct7: number;
		prio: number;
	},
	now: number,
): number => {
	const left5 = Math.min(Math.max(r.reset5 - now, 0), WINDOW_5H);
	const left7 = Math.max(r.reset7 - now, 0) - upcomingNightMs(now, r.reset7);
	// Under 12h of real time left, each hour counts double: a gentle pull toward
	// the account about to lose its week, not a tier jump.
	const urgency = Math.max(0, URGENT_MS - left7);
	const free7 = 1 - Math.min(r.pct7, 100) / 100;
	const gate = Math.min(1, (1 - Math.min(r.pct5, 100) / 100) / 0.5);
	return (
		left7 -
		urgency -
		WEEKLY_QUOTA_WEIGHT * free7 -
		FIVE_H_NUDGE * gate * (1 - left5 / WINDOW_5H) -
		PRIORITY_WEIGHT * Math.max(-1, Math.min(1, r.prio))
	);
};

/**
 * Put the account a human should try first at the top without changing the
 * automatic picker. Stable ties retain the store order.
 */
export function sortAccountsForDisplay(
	accounts: Account[],
	cache: UsageCache,
	now = Date.now(),
): Account[] {
	const ranked = accounts.map((account, index) => {
		const usage = cache[account.label];
		const pct5 = usage?.five_hour?.pct;
		const pct7 = usage?.seven_day?.pct;
		const healthy = accountState(account, now) === "ok";
		const enabled = !account.dead && !account.disabled;
		const ready =
			healthy &&
			typeof pct5 === "number" &&
			pct5 < 99 &&
			typeof pct7 === "number" &&
			pct7 < 99;
		// A quota-full account is normally cooling until this very reset, so cooling
		// must not disqualify it from the "ready soon" tier. Dead/disabled still do.
		const usefulAfter5hReset =
			enabled &&
			typeof pct5 === "number" &&
			pct5 >= 99 &&
			typeof pct7 === "number" &&
			pct7 < 90;
		let group = 4; // dead or disabled
		if (ready) group = 0;
		else if (usefulAfter5hReset) group = 1;
		else if (healthy) group = 2;
		else if (enabled) group = 3; // cooling for another reason
		return {
			account,
			index,
			group,
			prio: account.priority ?? 0,
			tier: accountTier(account, usage, now),
			pct5: pct5 ?? Number.POSITIVE_INFINITY,
			pct7: pct7 ?? Number.POSITIVE_INFINITY,
			reset5: resetAt(usage?.five_hour?.resets_at),
			reset7: resetAt(usage?.seven_day?.resets_at),
		};
	});
	return ranked
		.sort((a, b) => {
			if (a.group !== b.group) return a.group - b.group;
			if (a.group === 0) {
				const tier = a.tier - b.tier;
				if (tier) return tier;
				// Compared, not subtracted: two unknown resets are both +Infinity and
				// Infinity - Infinity is NaN, which corrupts the whole sort.
				const ra = readyRank(a, now);
				const rb = readyRank(b, now);
				if (ra !== rb) return ra - rb;
				return a.pct5 - b.pct5 || a.index - b.index;
			}
			if (a.group === 1) return a.reset5 - b.reset5 || a.index - b.index;
			return a.index - b.index;
		})
		.map(({ account }) => account);
}

export function poolTable(
	accounts: Account[],
	activeLabel: string | undefined,
	cache: UsageCache,
): string {
	if (!accounts.length)
		return "(no accounts — /claude-pool-add <label> after /login anthropic)";
	return sortAccountsForDisplay(accounts, cache)
		.map((a, i) => accountLine(a, i, cache[a.label], a.label === activeLabel))
		.join("\n");
}

/** Resolve an exact label or unique substring. Display numbers are not IDs. */
export function resolveAccount(
	accounts: Account[],
	query: string,
): Account | undefined {
	const q = query.trim();
	if (!q) return undefined;
	const exact = accounts.find((a) => a.label === q);
	if (exact) return exact;
	const hits = accounts.filter((a) =>
		a.label.toLowerCase().includes(q.toLowerCase()),
	);
	return hits.length === 1 ? hits[0] : undefined;
}
