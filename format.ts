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

function resetsIn(iso: string | undefined): string {
	if (!iso) return "";
	const at = Date.parse(iso);
	if (!Number.isFinite(at)) return "";
	return ` (${relative(at - Date.now())})`;
}

function window(name: string, w: { pct: number; resets_at?: string } | undefined): string {
	if (!w) return `${name} —`;
	return `${name} ${Math.round(w.pct)}%${resetsIn(w.resets_at)}`;
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
	const parts = [
		`${isActive ? "▸" : " "} ${index + 1}. ${account.label}${id ? ` ${id}` : ""}`,
		window("5h", entry?.five_hour),
		window("7d", entry?.seven_day),
	];
	for (const s of entry?.scoped ?? []) parts.push(`${s.name} ${Math.round(s.pct)}%`);
	if (entry?.spend)
		parts.push(
			`spend ${entry.spend.used.toFixed(2)}/${entry.spend.limit.toFixed(2)} ${entry.spend.currency}`,
		);
	if (state !== "ok") parts.push(state);
	if (account.refreshExpires)
		parts.push(`login exp ${new Date(account.refreshExpires).toISOString().slice(0, 10)}`);
	if (entry?.error) parts.push(`usage: ${entry.error}`);
	else if (entry?.at && Date.now() - entry.at > SERVE_TTL_MS)
		parts.push(`as of ${relative(Date.now() - entry.at)} ago`);
	else if (!entry?.at) parts.push("usage: not fetched yet");
	return parts.join(" · ");
}

export function poolTable(
	accounts: Account[],
	activeLabel: string | undefined,
	cache: UsageCache,
): string {
	if (!accounts.length) return "(no accounts — /claude-pool-add <label> after /login anthropic)";
	return accounts
		.map((a, i) => accountLine(a, i, cache[a.label], a.label === activeLabel))
		.join("\n");
}

/** Resolve "2", "datecs:home", or a unique substring to a label. */
export function resolveAccount(accounts: Account[], query: string): Account | undefined {
	const q = query.trim();
	if (!q) return undefined;
	const n = Number(q);
	if (Number.isInteger(n) && n >= 1 && n <= accounts.length) return accounts[n - 1];
	const exact = accounts.find((a) => a.label === q);
	if (exact) return exact;
	const hits = accounts.filter((a) => a.label.toLowerCase().includes(q.toLowerCase()));
	return hits.length === 1 ? hits[0] : undefined;
}
