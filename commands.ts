/** Slash commands: list accounts with quota, switch, add, remove, enable/disable. */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	AGENT_DIR,
	type Account,
	type SyncConfig,
	mutateStore,
	parseExport,
	parseSyncConfig,
	readStore,
	writeJsonAtomic,
} from "./store.ts";
import {
	autoSwitchEnabled,
	ensureFresh,
	invalidateSnapshot,
	pickActive,
	setActive,
	syncNow,
} from "./pool.ts";
import { checkRepo, newKey, syncReady } from "./sync.ts";
import {
	accountLine,
	relative,
	resolveAccount,
	sortAccountsForDisplay,
} from "./format.ts";
import { parseEvery, warmSpacingMs, warmTargets } from "./warm.ts";
import { collectUsage, readUsage } from "./usage.ts";
import { type Profile, fetchProfile } from "./oauth.ts";

/** Minimal structural types for ctx.ui.custom — keeps this file independent of
 *  pi-tui's type tree, which is unresolvable outside pi. */
interface UiTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}
interface CustomComponent {
	render: (width: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
}
interface Ui {
	notify: (m: string, level?: string) => void;
	confirm?: (title: string, body?: string) => Promise<boolean>;
	input?: (prompt: string, initial?: string) => Promise<string | undefined>;
	custom?: <T>(
		build: (
			tui: { requestRender: () => void },
			theme: UiTheme,
			keybindings: unknown,
			done: (value: T) => void,
		) => CustomComponent,
	) => Promise<T>;
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
export async function attachCurrentLogin(labelHint?: string): Promise<
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
		return {
			label: labelHint,
			matched: "label",
			email: owner.email,
			plan: owner.plan,
		};
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
	const byLabel = labelHint
		? resolveAccount(store.accounts, labelHint)
		: undefined;
	const target =
		byLabel ?? (labelHint ? undefined : findByIdentity(store.accounts, profile));
	const label =
		target?.label ?? labelHint ?? defaultLabel(store.accounts, profile);
	// pi's auth.json is written once by /login and never rotated; the pool rotates
	// the lineage on every refresh. So a leftover file is usually a SPENT
	// generation, and adopting it silently does damage:
	//   - unidentifiable (profile call fails on the stale access token) it mints
	//     `account-<now>`, a ghost that returns with a new name every session;
	//   - identifiable it overwrites a LIVE refresh token with a spent one, which
	//     is invalid_grant — the account goes dead.
	// An explicit label means the user just logged in and said so: always honor
	// it. Otherwise only adopt credentials newer than the ones we already hold.
	if (!labelHint) {
		if (target && !target.dead && creds.expires <= (target.expires ?? 0))
			return undefined;
		if (!target && !profile.uuid) return undefined;
	}
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
export function findByIdentity(
	accounts: Account[],
	profile: Profile,
): Account | undefined {
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

/** Where /claude-pool-export drops the portable copy of the logins. */
const EXPORT_PATH = join(AGENT_DIR, "claude-pool-export.json");

/** Best effort: the clipboard is a convenience, never a failure path. */
function copyToClipboard(text: string): boolean {
	const byPlatform: Record<string, string[]> = {
		win32: ["clip"],
		darwin: ["pbcopy"],
	};
	const [cmd, ...cmdArgs] = byPlatform[process.platform] ?? [
		"xclip",
		"-selection",
		"clipboard",
	];
	try {
		return spawnSync(cmd, cmdArgs, { input: text }).status === 0;
	} catch {
		return false;
	}
}

/**
 * Top up the usage cache for every live account. Only ever user-initiated (`r`
 * in the pool list), so it covers the whole (small) pool — the 180s cache floor
 * still protects the endpoint's hourly budget.
 */
async function refreshVisibleUsage(): Promise<void> {
	const labels = readStore()
		.accounts.filter((a) => !a.dead)
		.map((a) => a.label);
	await collectUsage(
		labels,
		async (label) => (await ensureFresh(label))?.access,
		{ max: labels.length, force: false },
	);
}

export function setupCommands(pi: ExtensionAPI): void {
	// SAFETY: Pi's public registerCommand type is generic over its own ctx; the
	// handlers only ever touch the Ui members declared below, which TUI builds
	// provide. Narrowing to Ui keeps this file independent of the ctx type's
	// version-to-version churn.
	const register = pi.registerCommand as unknown as Register;

	register("claude-pool", {
		description: "Open the Claude account pool",
		handler: async (_args, ctx) => {
			const store = readStore();
			if (!store.accounts.length) {
				ctx.ui.notify(
					"No pooled Claude accounts. Run /login anthropic, then /claude-pool-add <label>.",
					"info",
				);
				return;
			}
			if (!ctx.ui.custom) {
				ctx.ui.notify("Interactive menu needs a TUI — use cpool.", "warning");
				return;
			}
			// Dynamic: cpool and tests load this module without pi's node_modules.
			const { Container, SelectList, Text } = await import(
				"@earendil-works/pi-tui"
			);
			type MenuAction = {
				act: "switch" | "refresh" | "toggle" | "remove";
				label: string;
			};
			// The list stays up: refresh / enable-disable / remove re-present it with
			// current data. Only a switch or esc closes it.
			for (;;) {
				const fresh = readStore();
				if (!fresh.accounts.length) return;
				const cache = readUsage();
				const active = pickActive(fresh);
				const visible = sortAccountsForDisplay(fresh.accounts, cache);
				const pick = await ctx.ui.custom<MenuAction | null>(
					(tui, theme, _kb, done) => {
						const list = new SelectList(
							visible.map((a, i) => ({
								value: a.label,
								label: accountLine(a, i, cache[a.label], a.label === active),
							})),
							Math.min(visible.length, 12),
							{
								selectedPrefix: (t: string) => theme.fg("accent", t),
								selectedText: (t: string) => theme.fg("accent", t),
								description: (t: string) => theme.fg("muted", t),
								scrollInfo: (t: string) => theme.fg("dim", t),
								noMatch: (t: string) => theme.fg("warning", t),
							},
						);
						list.onSelect = (item: { value: string }) =>
							done({ act: "switch", label: item.value });
						list.onCancel = () => done(null);
						const box = new Container();
						box.addChild(
							new Text(theme.fg("accent", theme.bold("Claude accounts")), 1, 0),
						);
						box.addChild(list);
						box.addChild(
							new Text(
								theme.fg(
									"dim",
									"enter switch • r refresh usage • d enable/disable • - remove • esc close",
								),
								1,
								0,
							),
						);
						const onKey = (act: MenuAction["act"]) => {
							const item = list.getSelectedItem();
							if (item) done({ act, label: item.value });
						};
						return {
							render: (w: number) => box.render(w),
							invalidate: () => box.invalidate(),
							handleInput: (data: string) => {
								if (data === "-") return onKey("remove");
								if (data === "r") return onKey("refresh");
								if (data === "d") return onKey("toggle");
								list.handleInput(data);
								tui.requestRender();
							},
						};
					},
				);
				if (!pick) return; // Esc
				if (pick.act === "switch") {
					const target = fresh.accounts.find((a) => a.label === pick.label);
					// Human choice: hold it until this account runs out, then auto resumes.
					await setActive(pick.label, { manual: true });
					ctx.ui.notify(
						await switchReport(pick.label),
						target?.dead ? "warning" : "info",
					);
					return;
				}
				if (pick.act === "refresh") await refreshVisibleUsage();
				else if (pick.act === "toggle") await toggleDisabled(pick.label);
				else if (
					!ctx.ui.confirm ||
					(await ctx.ui.confirm(`Remove "${pick.label}" from the pool?`))
				)
					await removeFromPool(pick.label);
			}
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
		description:
			"Remove an account from the pool. Usage: /claude-pool-remove <label>",
		handler: async (args, ctx) => {
			const target = resolveAccount(readStore().accounts, args);
			if (!target) {
				ctx.ui.notify("Usage: /claude-pool-remove <label>", "warning");
				return;
			}
			await removeFromPool(target.label);
			ctx.ui.notify(`Removed "${target.label}" from the pool.`, "info");
		},
	});

	register("claude-pool-export", {
		description:
			"Write the pooled Claude logins to a portable file (and the clipboard)",
		handler: async (_args, ctx) => {
			const accounts = readStore().accounts;
			if (!accounts.length) {
				ctx.ui.notify("No pooled accounts to export.", "warning");
				return;
			}
			// The sync repo+key ride along: one export, and the other machine is
			// wired to the shared repo without retyping a 64-char secret.
			const payload = { accounts, sync: readStore().sync };
			writeJsonAtomic(EXPORT_PATH, payload);
			const copied = copyToClipboard(JSON.stringify(payload, null, 2));
			ctx.ui.notify(
				`Exported ${accounts.length} account(s). This holds refresh tokens — treat it like a password.\n${EXPORT_PATH}${
					copied ? "\nContents copied to the clipboard." : ""
				}\nOn the other machine: /claude-pool-import`,
				"info",
			);
		},
	});

	register("claude-pool-import", {
		description:
			"Import pooled Claude logins from an export file path or pasted JSON",
		handler: async (args, ctx) => {
			const answer = (
				args.trim() ||
				(await ctx.ui.input?.("Export file path or pasted JSON:", EXPORT_PATH)) ||
				""
			).trim();
			if (!answer) return;
			let imported: Account[];
			try {
				const path = answer.replace(/^["']|["']$/g, "");
				imported = parseExport(
					answer.startsWith("{") || answer.startsWith("[")
						? answer
						: readFileSync(path, "utf-8"),
				);
			} catch (e) {
				ctx.ui.notify(`Import failed: ${(e as Error).message}`, "warning");
				return;
			}
			const syncConfig = parseSyncConfig(
				answer.startsWith("{") || answer.startsWith("[")
					? answer
					: readFileSync(answer.replace(/^["']|["']$/g, ""), "utf-8"),
			);
			await mutateStore((store) => {
				for (const account of imported) {
					const i = store.accounts.findIndex((a) => a.label === account.label);
					// Merge over an existing label: the imported refresh token wins,
					// local cooldown/usage bookkeeping is irrelevant on a new machine.
					if (i >= 0) store.accounts[i] = { ...store.accounts[i], ...account };
					else store.accounts.push(account);
				}
				if (syncConfig) store.sync = syncConfig;
				if (!store.active) store.active = pickActive(store);
			});
			invalidateSnapshot();
			ctx.ui.notify(
				`Imported ${imported.length} account(s): ${imported
					.map((a) => a.label)
					.join(", ")}.\nRun /claude-pool to check them.`,
				"info",
			);
		},
	});

	register("claude-pool-disable", {
		description:
			"Hold an account out of rotation, still refreshed (toggle). Usage: /claude-pool-disable <label>",
		handler: async (args, ctx) => {
			const target = resolveAccount(readStore().accounts, args);
			if (!target) {
				ctx.ui.notify("Usage: /claude-pool-disable <label>", "warning");
				return;
			}
			const next = await toggleDisabled(target.label);
			ctx.ui.notify(
				`"${target.label}" is now ${next ? "disabled" : "enabled"}${
					next ? " (still kept logged in)." : "."
				}`,
				"info",
			);
		},
	});

	register("claude-pool-auto", {
		description:
			"Toggle automatic account selection (on by default, re-picks every 20m)",
		handler: async (_args, ctx) => {
			const on = await mutateStore((store) => {
				store.autoSwitch = !autoSwitchEnabled(store);
				if (store.autoSwitch) store.manualPin = false; // stop holding the pin
				return store.autoSwitch;
			});
			invalidateSnapshot();
			ctx.ui.notify(
				on
					? "Automatic selection ON — the best account is re-picked every 20m."
					: "Automatic selection OFF — the pool only switches when an account runs out.",
				"info",
			);
		},
	});

	register("claude-pool-sync", {
		description:
			"Share logins with your other machines through a private git repo. Usage: /claude-pool-sync [<git-url>|on|off|now]",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg) {
				ctx.ui.notify(await applySync(arg), "info");
				return;
			}
			if (!ctx.ui.custom) {
				ctx.ui.notify(
					`${syncStatus()}\nUsage: /claude-pool-sync <git-url> | on | off | now`,
					"info",
				);
				return;
			}
			const { Container, SelectList, Text } = await import(
				"@earendil-works/pi-tui"
			);
			// Stays up after an action, like the account menu: set the url, flip it
			// on, sync once, all without reopening.
			for (;;) {
				const config = readStore().sync;
				const rows = [
					{ value: "url", label: `Repo   ${config?.url || "(not set)"}` },
					{
						value: "toggle",
						label: `Sync   ${syncReady(config) ? (config.on === false ? "OFF" : "ON") : "needs a repo url"}`,
					},
					{ value: "now", label: "Sync now (pull newer, publish ours)" },
				];
				const pick = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
					const list = new SelectList(rows, rows.length, {
						selectedPrefix: (t: string) => theme.fg("accent", t),
						selectedText: (t: string) => theme.fg("accent", t),
						description: (t: string) => theme.fg("muted", t),
						scrollInfo: (t: string) => theme.fg("dim", t),
						noMatch: (t: string) => theme.fg("warning", t),
					});
					list.onSelect = (item: { value: string }) => done(item.value);
					list.onCancel = () => done(null);
					const box = new Container();
					box.addChild(new Text(theme.fg("accent", theme.bold("Login sync")), 1, 0));
					box.addChild(list);
					box.addChild(
						new Text(
							theme.fg(
								"dim",
								"A private repo, one encrypted file per account. Export carries the key.",
							),
							1,
							0,
						),
					);
					return {
						render: (w: number) => box.render(w),
						invalidate: () => box.invalidate(),
						handleInput: (data: string) => {
							list.handleInput(data);
							tui.requestRender();
						},
					};
				});
				if (!pick) return; // Esc
				if (pick === "url") {
					const url = (
						(await ctx.ui.input?.(
							"Private git repo (git@github.com:you/claude-pool.git):",
							config?.url ?? "",
						)) ?? ""
					).trim();
					if (url) ctx.ui.notify(await applySync(url), "info");
				} else {
					ctx.ui.notify(await applySync(pick), "info");
				}
			}
		},
	});

	register("claude-pool-warm", {
		description:
			"Keep unstarted 5h windows already running, off by default (bare cycles off/1/2/all). Usage: /claude-pool-warm [off|1|2|all] [30m|2h|auto]",
		handler: async (args, ctx) => {
			// A count and an optional interval. Never row numbers — no account is
			// addressed positionally.
			const cycle: (number | "all" | undefined)[] = [undefined, 1, 2, "all"];
			const usage = "Usage: /claude-pool-warm [off|1|2|all] [30m|2h|auto]";
			const [want = "", every = ""] = args.trim().toLowerCase().split(/\s+/);
			let next: number | "all" | undefined;
			if (!want) {
				const current = readStore().warm || undefined;
				next = cycle[(cycle.indexOf(current) + 1) % cycle.length];
			} else if (want === "off") next = undefined;
			else if (want === "all") next = "all";
			else if (/^[1-9]\d*$/.test(want)) next = Number(want);
			else {
				ctx.ui.notify(usage, "warning");
				return;
			}
			const everyMs = every === "auto" ? undefined : parseEvery(every);
			if (every && every !== "auto" && everyMs === undefined) {
				ctx.ui.notify(usage, "warning");
				return;
			}
			await mutateStore((s) => {
				s.warm = next;
				if (every) s.warmEveryMs = everyMs;
			});
			if (next === undefined) {
				ctx.ui.notify("5h warm-up OFF.", "info");
				return;
			}
			const store = readStore();
			const cache = readUsage();
			const cold = warmTargets(store, cache).map((a) => a.label);
			ctx.ui.notify(
				`5h warm-up ON for ${next} account(s), one every ${relative(
					warmSpacingMs(store, cache),
				)}${store.warmEveryMs ? " (set)" : " (5h/N)"} — not started yet: ${
					cold.join(", ") || "none"
				}`,
				"info",
			);
		},
	});
}

export function syncStatus(): string {
	const config = readStore().sync;
	if (!syncReady(config)) return "Login sync: not set up.";
	return `Login sync: ${config.on === false ? "OFF" : "ON"} → ${config.url}`;
}

/**
 * Apply one sync argument — a repo url, `on`, `off`, or `now` — and return the
 * line to show. Shared by the slash command, its menu, and `cpool sync`.
 */
export async function applySync(arg: string): Promise<string> {
	const word = arg.toLowerCase();
	if (word === "now") {
		if (!syncReady(readStore().sync)) return "No repo set — add one first.";
		const { adopted, pushed } = await syncNow();
		return `Synced: adopted ${adopted}, published ${pushed}.`;
	}
	if (word === "on" || word === "off") {
		if (!syncReady(readStore().sync)) return "No repo set — add one first.";
		await mutateStore((store) => {
			if (store.sync) store.sync.on = word === "on";
		});
		return `Login sync ${word.toUpperCase()}.`;
	}
	// Anything else is a git url. A key is minted only when there is none:
	// changing it orphans every file already published to the repo.
	const config = await mutateStore((store): SyncConfig => {
		store.sync = { url: arg, key: store.sync?.key ?? newKey(), on: true };
		return store.sync;
	});
	try {
		const found = await checkRepo(config);
		return `Login sync ON → ${arg}\n${found} account file(s) already in the repo.\nRun /claude-pool-export and import that on the other machines — it carries the key.`;
	} catch (e) {
		return `Saved, but cloning failed: ${(e as Error).message.split("\n")[0]}`;
	}
}

/** Drop an account from the pool (shared by /claude-pool-remove and the menu). */
async function removeFromPool(label: string): Promise<void> {
	await mutateStore((store) => {
		store.accounts = store.accounts.filter((a) => a.label !== label);
		if (store.active === label) store.active = pickActive(store);
	});
	invalidateSnapshot();
}

export async function toggleDisabled(label: string): Promise<boolean> {
	const next = await mutateStore((store) => {
		const account = store.accounts.find((a) => a.label === label);
		if (!account) return false;
		account.disabled = !account.disabled;
		if (account.disabled && store.active === label)
			store.active = pickActive(store);
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
	if (!account?.dead)
		return `Claude account → "${label}". Next request uses it.`;
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
		if (index >= 0)
			store.accounts[index] = { ...store.accounts[index], ...entry };
		else store.accounts.push(entry);
		if (!store.active) store.active = label;
		return store.accounts.length;
	});
	invalidateSnapshot();
	return count;
}
