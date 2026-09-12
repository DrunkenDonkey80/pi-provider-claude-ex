/**
 * pi-provider-claude-plus
 * ────────────────────────────────────────────────────────────────────────────
 * Claude (Anthropic OAuth / subscription) layer for pi-coding-agent:
 *   1. tool-name compatibility  → tools.ts   (from @zgltyq/pi-provider-claude)
 *   2. multi-account pool       → pool.ts + store.ts (rewritten: crash-safe,
 *      cross-process locked, lazy refresh, keep-alive — see store.ts header for
 *      why upstream's pooled logins kept dying)
 *   3. quota status + switching → commands.ts, usage.ts, bin/cpool.ts
 *
 * ENV
 *   PI_CLAUDE_PROVIDER_DEBUG_LOG=/path   append before/after payloads + pool log
 *   PI_CLAUDE_PROVIDER_DISABLE=1         pass tools through flat (debug)
 *   PI_CLAUDE_PROVIDER_POOL_DISABLE=1    disable the account pool
 */

import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loginAnthropicOAuth } from "./oauth.ts";
import { isPlainObject, transformPayload, unaliasToolCalls } from "./tools.ts";
import { attachCurrentLogin, setupCommands } from "./commands.ts";
import {
	AUTH_RE,
	LIMIT_RE,
	TICK_MS,
	activeAccount,
	cooldownFromMessage,
	daemonAlive,
	ensureFresh,
	invalidateSnapshot,
	markRateLimited,
	pickActive,
	pickNext,
	poolEnabled,
	setPoolLogger,
	snapshot,
	tick,
} from "./pool.ts";
import { readStore } from "./store.ts";
import { readUsage, type UsageEntry } from "./usage.ts";

/** Random spread added to each sweep, so parallel sessions don't stay in step. */
const SWEEP_JITTER_MS = 10_000;

/**
 * 5h / 7d quota for the pooled account in use (or `label`), read from the
 * shared on-disk cache — no network, safe to call as often as you like.
 * The pool refreshes the active account every 5 minutes.
 *
 *   const { quota } = await import("pi-provider-claude-plus/index.ts");
 *   quota()?.five_hour?.pct // 34
 */
export function quota(
	label?: string,
):
	| ({ label: string } & Pick<UsageEntry, "at" | "five_hour" | "seven_day">)
	| undefined {
	const l = label ?? pickActive(readStore());
	const entry = l ? readUsage()[l] : undefined;
	if (!l || !entry) return undefined;
	return {
		label: l,
		at: entry.at,
		five_hour: entry.five_hour,
		seven_day: entry.seven_day,
	};
}

const debugLogPath = process.env.PI_CLAUDE_PROVIDER_DEBUG_LOG;
function writeDebugLog(payload: unknown): void {
	if (!debugLogPath) return;
	try {
		appendFileSync(
			debugLogPath,
			`${new Date().toISOString()}\n${JSON.stringify(payload, null, 2)}\n---\n`,
			"utf-8",
		);
	} catch {
		/* logging must never break a request */
	}
}

function setupPool(pi: ExtensionAPI): void {
	setPoolLogger((msg) => writeDebugLog({ stage: "pool", msg }));
	if (!poolEnabled()) return;
	const labels = readStore().accounts.map((a) => a.label);
	writeDebugLog({ stage: "pool", msg: `pool active: ${labels.join(", ")}` });

	// Before each turn: make sure the account we're about to use has a live
	// token. Lock + consume gate make this a no-op when it's already fresh, so
	// concurrent sessions can all call it without racing a rotation.
	const prepare = async () => {
		invalidateSnapshot();
		// A fresh `/login anthropic` REVOKES the pooled copy of that same account,
		// so an unattached credential means one pool entry just died. Re-attach it
		// by account identity before anything routes around the "dead" entry.
		try {
			const attached = await attachCurrentLogin();
			if (attached)
				writeDebugLog({ stage: "pool", msg: `attached login → ${attached.label}` });
		} catch {
			/* best effort: never block a session on identity lookup */
		}
		// Free when the pinned account still works; re-reads quota only when a
		// switch is actually pending.
		const label = await pickNext();
		if (label) await ensureFresh(label);
	};
	pi.on("session_start", prepare);
	pi.on("before_agent_start", prepare);

	// Full sweep (keep-alive grants + usage cache) only when no `cpool daemon`
	// is running — a single writer is cheaper and races less.
	//
	// Spread the sweeps out. A host that relaunches every saved session at once
	// (Herdr after a reboot) starts N of these in the same instant, and a fixed
	// interval keeps them locked in that formation forever — every lock and
	// claim contended by all N, every time. A random first wake breaks up the
	// convoy and per-tick jitter stops it re-forming. The claims are correct
	// without this; jitter just keeps them uncontended.
	let sweep: ReturnType<typeof setTimeout> | undefined;
	const scheduleSweep = (delay: number): void => {
		sweep = setTimeout(() => {
			if (!daemonAlive()) void tick();
			scheduleSweep(TICK_MS + Math.random() * SWEEP_JITTER_MS);
		}, delay);
		sweep.unref?.(); // never keep short-lived CLI invocations alive
	};
	scheduleSweep(Math.random() * TICK_MS);

	// PRIMARY cap detector: the Anthropic SDK throws on 429/529 before pi-ai's
	// onResponse callback runs, so the error lands on the assistant message.
	pi.on("message_end", async (event, ctx) => {
		try {
			const model = ctx.model;
			if (
				!model ||
				model.provider !== "anthropic" ||
				!ctx.modelRegistry.isUsingOAuth(model)
			)
				return undefined;
			const msg = event.message as {
				role?: string;
				stopReason?: string;
				errorMessage?: string;
			};
			if (
				msg.role !== "assistant" ||
				msg.stopReason !== "error" ||
				typeof msg.errorMessage !== "string"
			)
				return undefined;

			const previous = activeAccount()?.label;
			if (!previous) return undefined;

			// 401: the server rejected a token we thought was live. Force-refresh
			// in place (the consume gate still declines to POST a spent grant).
			if (AUTH_RE.test(msg.errorMessage) && !LIMIT_RE.test(msg.errorMessage)) {
				const account = await ensureFresh(previous, { force: true });
				ctx.ui.notify(
					account && !account.dead
						? `Claude account "${previous}" had a stale token — refreshed. Resend to continue.`
						: `Claude account "${previous}" login is dead — run /login anthropic then /claude-pool-add ${previous}.`,
					account && !account.dead ? "info" : "warning",
				);
				return undefined;
			}

			if (!LIMIT_RE.test(msg.errorMessage)) return undefined;
			const next = await markRateLimited(
				previous,
				cooldownFromMessage(msg.errorMessage),
			);
			if (next && next !== previous) {
				await ensureFresh(next);
				ctx.ui.notify(
					`Claude account "${previous}" hit its limit → switched to "${next}". Resend to continue.`,
					"warning",
				);
			} else {
				ctx.ui.notify(
					`Claude account "${previous}" hit its limit and every pooled account is cooling down. /claude-pool shows the reset times.`,
					"warning",
				);
			}
		} catch {
			/* detection must never break the message path */
		}
		return undefined;
	});

	// Secondary detector for transports that do surface response headers.
	pi.on("after_provider_response", (event: unknown) => {
		try {
			const e = event as {
				status?: number;
				statusCode?: number;
				headers?: Record<string, string>;
			};
			const status = e.status ?? e.statusCode;
			if (status !== 429 && status !== 529) return undefined;
			const label = activeAccount()?.label;
			if (!label) return undefined;
			const raw =
				e.headers?.["retry-after"] ??
				e.headers?.["anthropic-ratelimit-unified-reset"];
			const n = raw ? Number(raw) : Number.NaN;
			const until = Number.isFinite(n)
				? n > 1e9
					? n * 1000
					: Date.now() + n * 1000
				: Date.now() + 5 * 60_000;
			void markRateLimited(label, until);
		} catch {
			/* observation only */
		}
		return undefined;
	});

	// Supply the active pooled account's token to Pi's Anthropic transport.
	// Subscription billing is preserved: Pi detects the OAuth path from the
	// token's shape, so a pooled OAuth token still gets Claude Code headers.
	// SAFETY: registerProvider's declared config type churns between Pi
	// versions; the cfg we pass only uses the stable oauth shape below.
	const register = pi.registerProvider as unknown as (
		id: string,
		cfg: unknown,
	) => void;
	register("anthropic", {
		oauth: {
			name: `Claude (pool: ${labels.join("+")})`,
			login: loginAnthropicOAuth,
			async refreshToken(credentials: {
				access?: string;
				refresh?: string;
				expires?: number;
			}) {
				const label = pickActive(readStore());
				const account = label ? await ensureFresh(label) : undefined;
				return account
					? {
							refresh: account.refresh,
							access: account.access,
							expires: account.expires,
						}
					: credentials;
			},
			getApiKey(credentials: { access?: string } | undefined) {
				// Sync + hot: reads the on-disk store through a 2s memo, so a switch
				// made in another session or by `cpool switch` is picked up without
				// a restart.
				const label = pickActive(snapshot());
				const account = label
					? snapshot().accounts.find((a) => a.label === label)
					: undefined;
				return account?.access || credentials?.access || "";
			},
		},
	});
}

export default function piProviderClaude(pi: ExtensionAPI): void {
	// mcp__pi__* → flat, before the agent loop resolves the tool.
	pi.on("message_end", async (event) => {
		const rewritten = unaliasToolCalls(event.message);
		if (!rewritten) return undefined;
		return { message: rewritten as typeof event.message };
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (
			!model ||
			model.provider !== "anthropic" ||
			!ctx.modelRegistry.isUsingOAuth(model)
		)
			return undefined;
		if (!isPlainObject(event.payload)) return undefined;

		writeDebugLog({ stage: "before", payload: event.payload });
		const transformed = transformPayload(
			event.payload as Record<string, unknown>,
			process.env.PI_CLAUDE_PROVIDER_DISABLE === "1",
		);
		writeDebugLog({ stage: "after", payload: transformed });
		return transformed;
	});

	setupCommands(pi);
	setupPool(pi);
}
