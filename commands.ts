/** Slash commands: list accounts with quota, switch, add, enable/disable. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENT_DIR, type Account, mutateStore, readStore } from "./store.ts";
import {
	activeAccount,
	ensureFresh,
	invalidateSnapshot,
	pickActive,
	setActive,
} from "./pool.ts";
import { accountLine, poolTable, resolveAccount } from "./format.ts";
import { collectUsage, readUsage } from "./usage.ts";
import { type Profile, fetchProfile } from "./oauth.ts";

interface Ui {
	notify: (m: string, level?: string) => void;
	select: (title: string, options: string[]) => Promise<string | undefined>;
	confirm?: (title: string, body?: string) => Promise<boolean>;
}
type Ctx = { ui: Ui };
type Register = (
	name: string,
	def: {
		description: string;
		handler: (args: string, ctx: Ctx) => Promise<void>;
	},
) => void;

/** Read the single-slot anthropic OAuth creds the native /login wrote. */
function readAnthropicAuth():
	| { refresh: string; access: string; expires: number }
	| undefined {
	try {
		const path = join(AGENT_DIR, "auth.json");
		if (!existsSync(path)) return undefined;
		const a = (
			JSON.parse(readFileSync(path, "utf-8")) as {
				anthropic?: { refresh?: string; access?: string; expires?: number };
			}
		).anthropic;
		if (!a?.access || !a?.refresh) return undefined;
		return { refresh: a.refresh, access: a.access, expires: a.expires ?? 0 };
	} catch {
		return undefined;
	}
}

/**
 * Attach the credential `/login anthropic` just wrote to a pool entry.
 *
 * Anthropic REVOKES an account's previous refresh lineage when you log into it
 * again, so every login silently kills the pooled copy of that same account —
 * which is exactly how three accounts here ended up `invalid_grant`/dead. We
 * ask /api/oauth/profile who the new credential belongs to and overwrite that
 * account's entry by identity, so a login repairs the pool instead of breaking
 * it. Falls back to the caller's label when the profile call fails.
 *
 * Identity is (account uuid, org uuid). One email can hold SEVERAL
 * subscriptions — a personal Pro org and a team seat share `flex@datecs.bg`
 * but bill and rate-limit separately — so matching on email merged two
 * independent quota pools into one entry and silently dropped one login.
 */
export async function attachCurrentLogin(
	labelHint?: string,
): Promise<
	| {
			label: string;
			matched: "identity" | "label" | "new";
			email?: string;
			plan?: string;
	  }
	| undefined
> {
	const creds = readAnthropicAuth();
	if (!creds) return undefined;
	const store = readStore();
	const owner = store.accounts.find((a) => a.refresh === creds.refresh);
	if (owner && !labelHint) return undefined; // already attached, nothing to repair
	if (owner && labelHint && owner.label !== labelHint) {
		// RENAME, never duplicate: two entries holding one refresh lineage would
		// rotate each other's token away and both end up dead.
		await mutateStore((s) => {
			const entry = s.accounts.find((a) => a.label === owner.label);
			if (!entry) return;
			entry.label = labelHint;
			if (s.active === owner.label) s.active = labelHint;
		});
		invalidateSnapshot();
		return { label: labelHint, matched: "label", email: owner.email, plan: owner.plan };
	}

	let profile: Profile = {};
	try {
		profile = await fetchProfile(creds.access);
	} catch {
		/* identity is a nicety: fall back to the label below */
	}
	// An explicit label WINS over the identity match. Anthropic hands the same
	// account uuid to every subscription it owns and picks the org server-side,
	// so identity alone cannot split a Pro org from a team seat: only the user
	// knows which login they just made. Without a label, identity decides.
	const byLabel = labelHint ? resolveAccount(store.accounts, labelHint) : undefined;
	const target = byLabel ?? (labelHint ? undefined : findByIdentity(store.accounts, profile));
	const label = target?.label ?? labelHint ?? defaultLabel(store.accounts, profile);
	await upsertAccount(label, {
		...creds,
		uuid: profile.uuid,
		orgUuid: profile.orgUuid,
		email: profile.email,
		org: profile.org,
		plan: profile.plan,
	});
	return {
		label,
		matched: byLabel ? "label" : target ? "identity" : "new",
		email: profile.email,
		plan: profile.plan,
	};
}

/**
 * Exact (account, org) match first. A legacy entry stored before orgUuid
 * existed matches on account alone, but only when no entry already claims this
 * org — otherwise a second subscription would overwrite the first.
 */
export function findByIdentity(accounts: Account[], profile: Profile): Account | undefined {
	if (!profile.uuid) return undefined;
	const sameAccount = accounts.filter((a) => a.uuid === profile.uuid);
	if (!profile.orgUuid) return sameAccount[0];
	return (
		sameAccount.find((a) => a.orgUuid === profile.orgUuid) ??
		sameAccount.find((a) => !a.orgUuid)
	);
}

/** `flex@datecs.bg`, or `flex@datecs.bg (team)` when that email is already in
 * the pool under a different subscription. */
function defaultLabel(accounts: Account[], profile: Profile): string {
	const email = profile.email;
	if (!email) return `account-${Date.now()}`;
	if (!accounts.some((a) => a.email === email)) return email;
	const qualified = `${email} (${profile.plan ?? profile.org ?? "alt"})`;
	if (!accounts.some((a) => a.label === qualified)) return qualified;
	return `${qualified.slice(0, -1)} ${(profile.orgUuid ?? "").slice(0, 6)})`;
}

/** Top up the usage cache for the accounts shown in an interactive list. */
async function refreshVisibleUsage(force: boolean): Promise<void> {
	const labels = readStore()
		.accounts.filter((a) => !a.dead)
		.map((a) => a.label);
	// force=true is a user-initiated refresh: allow the whole (small) pool, but
	// the 180s cache floor still protects the endpoint's hourly budget.
	await collectUsage(
		labels,
		async (label) => (await ensureFresh(label))?.access,
		{ max: force ? labels.length : 2, force: false },
	);
}

export function setupCommands(pi: ExtensionAPI): void {
	// SAFETY: Pi's public registerCommand type is generic over its own ctx; the
	// handler only ever touches ctx.ui.{notify,select}, which every Pi build
	// provides. Narrowing to Ui keeps this file independent of the ctx type's
	// version-to-version churn.
	const register = pi.registerCommand as unknown as Register;

	register("claude-pool", {
		description: "Claude accounts: quota status, switch active account",
		handler: async (args, ctx) => {
			const store = readStore();
			if (!store.accounts.length) {
				ctx.ui.notify(
					"No pooled Claude accounts. Run /login anthropic, then /claude-pool-add <label>.",
					"info",
				);
				return;
			}
			// An explicit target skips the menu: /claude-pool 2, /claude-pool work
			if (args.trim()) {
				const target = resolveAccount(store.accounts, args);
				if (!target) {
					ctx.ui.notify(`No account matches "${args.trim()}".`, "warning");
					return;
				}
				await setActive(target.label);
				ctx.ui.notify(await switchReport(target.label), target.dead ? "warning" : "info");
				return;
			}

			await refreshVisibleUsage(false);
			const fresh = readStore();
			const cache = readUsage();
			const active = pickActive(fresh);
			const rows = fresh.accounts.map((a, i) =>
				accountLine(a, i, cache[a.label], a.label === active),
			);
			const REFRESH = "↻ refresh usage now";
			const TOGGLE = "⏸ enable / disable an account…";
			const choice = await ctx.ui.select("Claude accounts — pick one to switch", [
				...rows,
				REFRESH,
				TOGGLE,
			]);
			if (!choice) return; // Esc

			if (choice === REFRESH) {
				await refreshVisibleUsage(true);
				const c2 = readUsage();
				const f2 = readStore();
				ctx.ui.notify(poolTable(f2.accounts, pickActive(f2), c2), "info");
				return;
			}
			if (choice === TOGGLE) {
				const pick = await ctx.ui.select(
					"Toggle account",
					fresh.accounts.map(
						(a, i) => `${i + 1}. ${a.label} — ${a.disabled ? "disabled" : "enabled"}`,
					),
				);
				if (!pick) return;
				const index = Number(pick.split(".")[0]) - 1;
				const target = fresh.accounts[index];
				if (!target) return;
				const next = await toggleDisabled(target.label);
				ctx.ui.notify(
					`"${target.label}" is now ${next ? "disabled" : "enabled"}.`,
					"info",
				);
				return;
			}

			const index = rows.indexOf(choice);
			const target = fresh.accounts[index];
			if (!target) return;
			await setActive(target.label);
			ctx.ui.notify(await switchReport(target.label), target.dead ? "warning" : "info");
		},
	});

	register("claude-pool-status", {
		description: "Show Claude pool accounts with 5h / weekly quota",
		handler: async (_args, ctx) => {
			await refreshVisibleUsage(false);
			const store = readStore();
			ctx.ui.notify(
				`Claude pool (enabled=${store.enabled !== false}, active=${activeAccount()?.label ?? "none"}):\n${poolTable(store.accounts, pickActive(store), readUsage())}`,
				"info",
			);
		},
	});

	register("claude-pool-add", {
		description:
			"Attach the current '/login anthropic' account to the pool (label optional — the account is identified automatically)",
		handler: async (args, ctx) => {
			if (!readAnthropicAuth()) {
				ctx.ui.notify(
					"No anthropic OAuth creds in auth.json — run /login anthropic first.",
					"warning",
				);
				return;
			}
			const attached = await attachCurrentLogin(args.trim() || undefined);
			if (!attached) {
				ctx.ui.notify("This login is already attached to a pool account.", "info");
				return;
			}
			const count = readStore().accounts.length;
			ctx.ui.notify(
				`${attached.matched === "new" ? "Added" : "Re-attached"} "${attached.label}"${
					attached.plan ? ` [${attached.plan}]` : ""
				} — ${count} account${count === 1 ? "" : "s"} in the pool.`,
				"info",
			);
		},
	});

	register("claude-pool-remove", {
		description: "Remove an account from the pool. Usage: /claude-pool-remove <n|label>",
		handler: async (args, ctx) => {
			const target = resolveAccount(readStore().accounts, args);
			if (!target) {
				ctx.ui.notify("Usage: /claude-pool-remove <n|label>", "warning");
				return;
			}
			await mutateStore((store) => {
				store.accounts = store.accounts.filter((a) => a.label !== target.label);
				if (store.active === target.label) store.active = pickActive(store);
			});
			invalidateSnapshot();
			ctx.ui.notify(`Removed "${target.label}" from the pool.`, "info");
		},
	});

	register("claude-pool-disable", {
		description:
			"Hold an account out of rotation (toggle). Usage: /claude-pool-disable <n|label>",
		handler: async (args, ctx) => {
			const target = resolveAccount(readStore().accounts, args);
			if (!target) {
				ctx.ui.notify("Usage: /claude-pool-disable <n|label>", "warning");
				return;
			}
			const next = await toggleDisabled(target.label);
			ctx.ui.notify(`"${target.label}" is now ${next ? "disabled" : "enabled"}.`, "info");
		},
	});
}

export async function toggleDisabled(label: string): Promise<boolean> {
	const next = await mutateStore((store) => {
		const account = store.accounts.find((a) => a.label === label);
		if (!account) return false;
		account.disabled = !account.disabled;
		if (account.disabled && store.active === label) store.active = pickActive(store);
		return !!account.disabled;
	});
	invalidateSnapshot();
	return next;
}

/**
 * What a switch actually did. An explicit pin onto a dead account used to be
 * silent: `pickActive` skipped it, requests went to some other account, and a
 * cap error named an account the user never chose. Now we retry the lineage
 * (dead is our own guess) and, if it stays dead, say who really serves.
 */
async function switchReport(label: string): Promise<string> {
	const account = await ensureFresh(label, { force: true });
	if (!account?.dead) return `Claude account → "${label}". Next request uses it.`;
	const serving = pickActive(readStore());
	return (
		`"${label}" login is revoked (invalid_grant) — Anthropic kills the stored token when you log into that account again.\n` +
		`Fix: /login anthropic (choose ${label}) then /claude-pool-add — it re-attaches by account identity.\n` +
		`Until then requests go to "${serving ?? "nothing usable"}".`
	);
}

/** Upsert by label, preserving the rest of the store (never a blind rewrite). */
export async function upsertAccount(
	label: string,
	creds: {
		refresh: string;
		access: string;
		expires: number;
		uuid?: string;
		orgUuid?: string;
		email?: string;
		org?: string;
		plan?: string;
	},
): Promise<number> {
	const count = await mutateStore((store) => {
		const entry: Account = {
			label,
			...creds,
			lastGrantAt: Date.now(),
			dead: false,
			strikes: 0,
			cooldownUntil: 0,
		};
		const index = store.accounts.findIndex((a) => a.label === label);
		if (index >= 0) store.accounts[index] = { ...store.accounts[index], ...entry };
		else store.accounts.push(entry);
		if (!store.active) store.active = label;
		return store.accounts.length;
	});
	invalidateSnapshot();
	return count;
}
