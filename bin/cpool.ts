#!/usr/bin/env node
/**
 * `cpool` — run the Claude account pool directly, without pi.
 *
 * Safe to run while pi sessions are live: every mutation goes through the same
 * cross-process file locks, and a switch is picked up by running sessions
 * within ~2s (see pool.ts getApiKey memo).
 *
 *   cpool list [--json]          accounts with 5h / weekly quota
 *   cpool status                 alias of list
 *   cpool switch <label>         pin the active account
 *   cpool switch                 rotate to the next usable account
 *   cpool add <label>            snapshot auth.json's /login account
 *   cpool remove <label>
 *   cpool disable <label>        toggle out of / into rotation
 *   cpool refresh [label]        force a token refresh (all, or one)
 *   cpool daemon [--once]        single-writer keep-alive + usage sweep
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR, mutateStore, readStore } from "../store.ts";
import {
	KEEPALIVE_MS,
	ensureFresh,
	pickActive,
	runDaemon,
	setActive,
	setPoolLogger,
	usable,
} from "../pool.ts";
import { collectUsage, readUsage } from "../usage.ts";
import {
	accountState,
	poolTable,
	relative,
	resolveAccount,
} from "../format.ts";
import { attachCurrentLogin, toggleDisabled } from "../commands.ts";

const args = process.argv.slice(2);
const command = (args[0] ?? "list").replace(/^--?/, "");
const rest = args.slice(1).filter((a) => !a.startsWith("--"));
const flag = (name: string) => args.includes(`--${name}`);
const target = rest.join(" ");

const die = (msg: string): never => {
	console.error(msg);
	process.exit(1);
};

async function fetchAll(force: boolean): Promise<void> {
	const labels = readStore()
		.accounts.filter((a) => !a.dead)
		.map((a) => a.label);
	await collectUsage(labels, async (l) => (await ensureFresh(l))?.access, {
		max: labels.length,
		force,
	});
}

if (flag("verbose")) setPoolLogger((m) => console.error(`[pool] ${m}`));

switch (command) {
	case "list":
	case "status": {
		await fetchAll(false);
		const store = readStore();
		const cache = readUsage();
		if (flag("json")) {
			console.log(
				JSON.stringify(
					{
						enabled: store.enabled !== false,
						active: pickActive(store),
						accounts: store.accounts.map((a) => ({
							label: a.label,
							state: accountState(a),
							disabled: !!a.disabled,
							dead: !!a.dead,
							cooldownUntil: a.cooldownUntil ?? 0,
							accessExpires: a.expires,
							loginExpires: a.refreshExpires ?? null,
							lastGrantAt: a.lastGrantAt ?? null,
							usage: cache[a.label] ?? null,
						})),
					},
					null,
					2,
				),
			);
			break;
		}
		console.log(poolTable(store.accounts, pickActive(store), cache));
		break;
	}

	case "switch": {
		const store = readStore();
		if (!store.accounts.length) die("no accounts in the pool");
		let pick = target ? resolveAccount(store.accounts, target) : undefined;
		if (target && !pick) die(`no account matches "${target}"`);
		if (!pick) {
			// bare `switch` = rotate to the next usable account after the active one
			const current = pickActive(store);
			const index = store.accounts.findIndex((a) => a.label === current);
			for (let i = 1; i <= store.accounts.length; i++) {
				const candidate = store.accounts[(index + i) % store.accounts.length];
				if (usable(candidate)) {
					pick = candidate;
					break;
				}
			}
			if (!pick) die("every account is disabled, dead, or cooling down");
		}
		await setActive(pick!.label);
		const account = await ensureFresh(pick!.label);
		console.log(
			`active → ${pick!.label}${account?.dead ? " (login dead — /login anthropic then cpool add)" : ""}`,
		);
		break;
	}

	case "add": {
		const path = join(AGENT_DIR, "auth.json");
		if (!existsSync(path)) die(`no ${path} — run '/login anthropic' in pi first`);
		let auth: { refresh?: string; access?: string; expires?: number } | undefined;
		try {
			auth = (
				JSON.parse(readFileSync(path, "utf-8")) as {
					anthropic?: { refresh?: string; access?: string; expires?: number };
				}
			).anthropic;
		} catch (e) {
			die(`could not read ${path}: ${(e as Error).message}`);
		}
		if (!auth?.refresh || !auth?.access)
			die("auth.json has no anthropic OAuth credential — run '/login anthropic'");
		// Label optional: the account is identified via /api/oauth/profile, so a
		// re-login lands back on its own entry instead of creating a duplicate.
		const attached = await attachCurrentLogin(target || undefined);
		if (!attached) {
			console.log("this login is already attached to a pool account");
			break;
		}
		console.log(
			`${attached.matched === "new" ? "added" : "re-attached"} "${attached.label}"${
				attached.email ? ` (${attached.email})` : ""
			} — ${readStore().accounts.length} accounts`,
		);
		break;
	}

	case "remove": {
		const pick = resolveAccount(readStore().accounts, target);
		if (!pick) die("usage: cpool remove <label>");
		await mutateStore((store) => {
			store.accounts = store.accounts.filter((a) => a.label !== pick!.label);
			if (store.active === pick!.label) store.active = pickActive(store);
		});
		console.log(`removed "${pick!.label}"`);
		break;
	}

	case "disable":
	case "enable": {
		const pick = resolveAccount(readStore().accounts, target);
		if (!pick) die(`usage: cpool ${command} <label>`);
		const disabled = await toggleDisabled(pick!.label);
		console.log(`"${pick!.label}" is now ${disabled ? "disabled" : "enabled"}`);
		break;
	}

	case "refresh": {
		const store = readStore();
		const picks = target
			? [
					resolveAccount(store.accounts, target) ??
						die(`no account matches "${target}"`),
				]
			: store.accounts;
		for (const account of picks) {
			const next = await ensureFresh(account.label, { force: true });
			console.log(
				`${account.label}: ${
					next?.dead
						? "login dead — /login anthropic then cpool add"
						: `ok, access expires in ${relative((next?.expires ?? 0) - Date.now())}`
				}`,
			);
		}
		break;
	}

	case "daemon": {
		console.log(
			`cpool daemon: pid ${process.pid}, keep-alive every ${relative(KEEPALIVE_MS)} per idle account. Ctrl-C to stop.`,
		);
		if (!flag("quiet")) setPoolLogger((m) => console.log(`[pool] ${m}`));
		await runDaemon({ once: flag("once") });
		break;
	}

	default:
		console.log(
			[
				"cpool list [--json]        accounts with 5h / weekly quota",
				"cpool switch [label]       pin active account (bare = rotate)",
				"cpool add <label>          snapshot auth.json's /login account",
				"cpool remove <label>",
				"cpool disable <label>      toggle out of / into rotation",
				"cpool refresh [label]      force a token refresh",
				"cpool daemon [--once]      keep-alive + usage sweep",
			].join("\n"),
		);
		if (command !== "help") process.exitCode = 1;
}
