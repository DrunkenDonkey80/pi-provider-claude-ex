/** Shared rendering for the slash commands, the CLI and the status widget. */

import type { Account } from "./store.ts";
import { SERVE_TTL_MS, type UsageEntry, type UsageCache } from "./usage.ts";

export function relative(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 90) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 90) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 36) return `${h}h ${m % 60}m`;
	return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Fixed-width reset clock: align each number at its unit, not the whole text. */
function clockRelative(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 90) return `${String(s).padStart(2)}s    `;
	const m = Math.round(s / 60);
	if (m < 90) return `${String(m).padStart(2)}m    `;
	const h = Math.floor(m / 60);
	if (h < 36) return `${String(h).padStart(2)}h ${String(m % 60).padStart(2)}m`;
	return `${String(Math.floor(h / 24)).padStart(2)}d ${String(h % 24).padStart(2)}h`;
}

const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

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
		`${isActive ? "▸" : " "} ${index + 1}.`,
		window("5h", entry?.five_hour, HOUR, 2 * HOUR),
		window("7d", entry?.seven_day, DAY, 2 * DAY),
	];
	for (const s of entry?.scoped ?? [])
		parts.push(`${s.name} ${Math.round(s.pct)}%`);
	if (entry?.spend)
		parts.push(
			`spend ${entry.spend.used.toFixed(2)}/${entry.spend.limit.toFixed(2)} ${entry.spend.currency}`,
		);
	if (state !== "ok") parts.push(state);
	// "login exp <date>" read as "login expired" on a truncated row; this is the
	// date the login stays GOOD until, so say that.
	if (account.refreshExpires)
		parts.push(
			`login ok to ${new Date(account.refreshExpires).toISOString().slice(0, 10)}`,
		);
	parts.push(`${account.label}${id ? ` ${id}` : ""}`);
	if (entry?.error) parts.push(`usage: ${entry.error}`);
	else if (entry?.at && Date.now() - entry.at > SERVE_TTL_MS)
		parts.push(`as of ${relative(Date.now() - entry.at)} ago`);
	else if (!entry?.at) parts.push("usage: not fetched yet");
	return parts.join(" · ");
}

const resetAt = (iso: string | undefined): number => {
	const at = iso ? Date.parse(iso) : Number.NaN;
	return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
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
			pct5: pct5 ?? Number.POSITIVE_INFINITY,
			reset5: resetAt(usage?.five_hour?.resets_at),
			reset7: resetAt(usage?.seven_day?.resets_at),
		};
	});
	return ranked
		.sort((a, b) => {
			if (a.group !== b.group) return a.group - b.group;
			// Weekly quota is the perishable one: spend the account whose 7d window
			// resets soonest, since anything left on it evaporates. 5h usage only
			// breaks ties. (An unknown reset sorts last: no data, no urgency.)
			if (a.group === 0)
				return a.reset7 - b.reset7 || a.pct5 - b.pct5 || a.index - b.index;
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
