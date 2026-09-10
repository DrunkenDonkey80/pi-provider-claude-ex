/**
 * @zgltyq/pi-provider-claude
 * ────────────────────────────────────────────────────────────────────────────
 * Claude (Anthropic OAuth / subscription) compatibility layer for pi-coding-agent.
 * Self-contained fork of the tool-handling half of `@benvargas/pi-claude-code-use`
 * (MIT). Credit to Ben Vargas for the original approach.
 *
 * WHY THIS EXISTS
 *   Anthropic's OAuth (subscription) request path appears to fingerprint tool
 *   names: tools that are neither part of the Claude Code core set nor prefixed
 *   `mcp__` can be classified as "extra usage". The upstream extension defends
 *   against this by DROPPING every unknown flat-named tool — which silently
 *   hides legitimate extension tools (ask_user_question, todo, subagent,
 *   ast_grep_search, ctx_*, web_search, …) from Claude.
 *
 * WHAT THIS DOES DIFFERENTLY (the "map all my tools" fix)
 *   Instead of dropping unknown flat tools, it RENAMES them in place on the
 *   wire to `mcp__pi__<name>` so they pass the classifier (subscription-safe)
 *   AND remain visible to Claude. On the way back, tool calls to `mcp__pi__*`
 *   are rewritten to their original flat name before Pi executes them, so the
 *   real tool (and its closure-bound state) runs unchanged.
 *
 * DESIGN NOTES
 *   - The tool's full JSON schema already rides inside the outbound payload,
 *     so we just rename — NO jiti capture, NO tool re-registration, NO typebox.
 *     The only import is a TYPE (erased at runtime), so this extension has zero
 *     runtime dependencies and minimal chance of a load failure.
 *   - Native Anthropic tools (objects with a `type` field, e.g. web_search) and
 *     anything already `mcp__`-prefixed are passed through untouched. Core
 *     Claude Code tools are passed through untouched.
 *   - Only ACTIVATES for Anthropic + OAuth. API-key and non-Anthropic providers
 *     are left completely unchanged.
 *
 * ENV (optional)
 *   PI_CLAUDE_PROVIDER_DEBUG_LOG=/path  → append before/after payloads
 *   PI_CLAUDE_PROVIDER_DISABLE=1        → pass everything through flat (debug)
 */

import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	loginAnthropicOAuth,
	refreshAnthropicOAuth,
} from "./oauth.ts";

// Prefix used to disguise flat tools as MCP tools. Kept short so
// `mcp__pi__<name>` stays well under Anthropic's 64-char tool-name limit.
const ALIAS_PREFIX = "mcp__pi__";

// Core Claude Code tool names that always pass through (lowercased).
// Mirrors Pi core's `claudeCodeTools` in packages/ai/src/providers/anthropic.ts.
const CORE_TOOL_NAMES = new Set([
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"glob",
	"askuserquestion",
	"enterplanmode",
	"exitplanmode",
	"killshell",
	"notebookedit",
	"skill",
	"task",
	"taskoutput",
	"todowrite",
	"webfetch",
	"websearch",
]);

const lower = (s: string): string => s.toLowerCase();
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

// ─── System prompt rewrite (parity with upstream) ────────────────────────────
// Keep Pi's identity out of the system prompt on the OAuth path.
function rewritePromptText(text: string): string {
	return text
		.replaceAll("pi itself", "the cli itself")
		.replaceAll("pi .md files", "cli .md files")
		.replaceAll("pi packages", "cli packages");
}

function rewriteSystemField(system: unknown): unknown {
	if (typeof system === "string") return rewritePromptText(system);
	if (!Array.isArray(system)) return system;
	return system.map((block) => {
		if (
			!isPlainObject(block) ||
			block.type !== "text" ||
			typeof block.text !== "string"
		)
			return block;
		const rewritten = rewritePromptText(block.text);
		return rewritten === block.text ? block : { ...block, text: rewritten };
	});
}

// True for tools that must NOT be renamed: native typed tools, core tools,
// already-mcp__ tools, or nameless entries.
function shouldRename(tool: Record<string, unknown>): boolean {
	if (typeof tool.type === "string" && tool.type.trim().length > 0)
		return false; // native (web_search, …)
	const name = typeof tool.name === "string" ? tool.name : "";
	if (!name) return false;
	const lc = lower(name);
	if (CORE_TOOL_NAMES.has(lc)) return false;
	if (lc.startsWith("mcp__")) return false;
	return true;
}

// Transform tools[]; returns the surviving tools plus the flat→alias map of
// exactly what was renamed (so tool_choice / message history stay consistent).
function transformTools(tools: unknown[]): {
	tools: unknown[];
	renamed: Map<string, string>;
} {
	const renamed = new Map<string, string>(); // lower(flat) → alias
	const emitted = new Set<string>();
	const result: unknown[] = [];

	for (const tool of tools) {
		if (!isPlainObject(tool)) continue;

		if (!shouldRename(tool)) {
			const key =
				typeof tool.name === "string"
					? lower(tool.name)
					: `__native_${result.length}`;
			if (emitted.has(key)) continue;
			emitted.add(key);
			result.push(tool);
			continue;
		}

		const name = tool.name as string;
		const alias = ALIAS_PREFIX + name;
		renamed.set(lower(name), alias);
		if (emitted.has(lower(alias))) continue;
		emitted.add(lower(alias));
		const compatible: Record<string, unknown> = { ...tool, name: alias };
		delete compatible.strict; // Anthropic OAuth rejects valid Pi schemas in strict mode.
		result.push(compatible);
	}

	return { tools: result, renamed };
}

// Rewrite tool_use block names in message history to match the renamed tools.
function remapMessages(
	messages: unknown[],
	renamed: Map<string, string>,
): unknown[] {
	if (renamed.size === 0) return messages;
	let changed = false;
	const next = messages.map((msg) => {
		if (!isPlainObject(msg) || !Array.isArray(msg.content)) return msg;
		let blockChanged = false;
		const content = msg.content.map((block) => {
			if (
				!isPlainObject(block) ||
				block.type !== "tool_use" ||
				typeof block.name !== "string"
			)
				return block;
			const alias = renamed.get(lower(block.name));
			if (!alias || alias === block.name) return block;
			blockChanged = true;
			return { ...block, name: alias };
		});
		if (!blockChanged) return msg;
		changed = true;
		return { ...msg, content };
	});
	return changed ? next : messages;
}

function remapToolChoice(
	toolChoice: Record<string, unknown>,
	renamed: Map<string, string>,
): Record<string, unknown> {
	if (toolChoice.type !== "tool" || typeof toolChoice.name !== "string")
		return toolChoice;
	const alias = renamed.get(lower(toolChoice.name));
	return alias ? { ...toolChoice, name: alias } : toolChoice;
}

function transformPayload(
	raw: Record<string, unknown>,
	disable: boolean,
): Record<string, unknown> {
	const payload = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;

	// 1. System prompt rewrite always applies.
	if (payload.system !== undefined)
		payload.system = rewriteSystemField(payload.system);

	if (disable) return payload;

	// 2. Rename unknown flat tools → mcp__pi__<name>.
	if (Array.isArray(payload.tools)) {
		const { tools, renamed } = transformTools(payload.tools as unknown[]);
		payload.tools = tools;

		// 3. Keep tool_choice consistent.
		if (isPlainObject(payload.tool_choice)) {
			payload.tool_choice = remapToolChoice(payload.tool_choice, renamed);
		}

		// 4. Keep historical tool_use names consistent with the renamed tools.
		if (Array.isArray(payload.messages)) {
			payload.messages = remapMessages(payload.messages, renamed);
		}
	}

	return payload;
}

// ─── Reverse mapping on execution ────────────────────────────────────────────
// Rewrite mcp__pi__<name> tool calls back to <name> in the finalized assistant
// message, BEFORE Pi resolves which tool to run. Only touches our own prefix,
// so foreign mcp__ tools (other extensions) are untouched.
function unaliasToolCalls(message: unknown): unknown {
	if (
		!isPlainObject(message) ||
		message.role !== "assistant" ||
		!Array.isArray(message.content)
	)
		return undefined;
	let changed = false;
	const content = message.content.map((block) => {
		if (
			!isPlainObject(block) ||
			block.type !== "toolCall" ||
			typeof block.name !== "string"
		)
			return block;
		if (!block.name.startsWith(ALIAS_PREFIX)) return block;
		changed = true;
		return { ...block, name: block.name.slice(ALIAS_PREFIX.length) };
	});
	return changed ? { ...message, content } : undefined;
}

// ─── Debug logging (optional) ─────────────────────────────────────────────────
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

// ════════════════════════════════════════════════════════════════════════════
// Multi-account failover (OPT-IN)
//
// Inert unless <agentDir>/claude-pool.json exists with >=2 accounts and
// "enabled" !== false. Kill switch: PI_CLAUDE_PROVIDER_POOL_DISABLE=1.
//
// Mechanism: override the anthropic provider's OAuth credential supply so the
// per-request token is the *currently active* pooled account. On a 429/529
// (rate / usage cap) the active account is put on cooldown and the pointer
// flips to the other account, so the next turn uses it. Tokens are refreshed in
// an async before_agent_start hook because getApiKey() is synchronous.
//
// Subscription billing is preserved: Pi's transport detects the OAuth path from
// the token's SHAPE (isOAuthToken), so any genuine pooled OAuth token still gets
// the Claude Code identity headers automatically.
// ════════════════════════════════════════════════════════════════════════════

interface PoolAccount {
	label: string;
	refresh: string;
	access: string;
	expires: number;
}
interface PoolConfig {
	enabled?: boolean;
	accounts: PoolAccount[];
}

const POOL_PATH = join(
	process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
	"claude-pool.json",
);
// Refresh an access token this long BEFORE it actually expires, so we never
// hand a request a token that's about to die. Generous because OAuth access
// tokens are short-lived and the failover target may have sat idle for days.
const POOL_REFRESH_BUFFER_MS = 5 * 60_000;
const POOL_DEFAULT_COOLDOWN_MS = 5 * 60_000;
// Background keep-warm cadence: re-check every account on this interval even
// when idle / not the active one, so an account is never stale when we switch.
const POOL_BG_REFRESH_INTERVAL_MS = 4 * 60_000;

let poolAccounts: PoolAccount[] = [];
let poolActive = 0;
let poolCooldownUntil: number[] = [];
let poolInvalid: boolean[] = [];
let poolBgTimer: ReturnType<typeof setInterval> | undefined;
let poolRefreshInFlight = false;

function poolLog(msg: string): void {
	writeDebugLog({ stage: "pool", time: new Date().toISOString(), msg });
}

function loadPool(): boolean {
	try {
		if (!existsSync(POOL_PATH)) return false;
		const cfg = JSON.parse(readFileSync(POOL_PATH, "utf-8")) as PoolConfig;
		if (cfg.enabled === false) return false;
		const accts = (cfg.accounts || []).filter(
			(a) => a && a.refresh && a.access,
		);
		if (accts.length < 2) return false;
		poolAccounts = accts;
		poolCooldownUntil = accts.map(() => 0);
		poolInvalid = accts.map(() => false);
		poolActive = 0;
		return true;
	} catch {
		return false;
	}
}

function persistPool(): void {
	try {
		writeFileSync(
			POOL_PATH,
			JSON.stringify({ enabled: true, accounts: poolAccounts }, null, 2),
			{
				mode: 0o600,
			},
		);
	} catch {
		/* persistence is best-effort */
	}
}

function poolSelectActive(): void {
	const now = Date.now();
	// Priority = array order: always prefer the LOWEST-index account that is
	// not cooling down (accounts[0] is the primary, e.g. "work"). This makes
	// failover non-sticky: as soon as the primary's cooldown expires, we
	// return to it instead of staying on the fallback account.
	let pick = -1;
	for (let i = 0; i < poolAccounts.length; i++) {
		if (!poolInvalid[i] && poolCooldownUntil[i] <= now) {
			pick = i;
			break;
		}
	}
	if (pick === -1) {
		// All usable accounts are cooling down: pick the one that frees up soonest.
		let min = Number.POSITIVE_INFINITY;
		for (let i = 0; i < poolCooldownUntil.length; i++) {
			if (!poolInvalid[i] && poolCooldownUntil[i] < min) {
				min = poolCooldownUntil[i];
				pick = i;
			}
		}
	}
	if (pick === -1) {
		poolLog("all pooled accounts have invalid OAuth credentials");
		return;
	}
	if (pick !== poolActive) {
		poolActive = pick;
		poolLog(`switched active → ${poolAccounts[poolActive].label}`);
	}
}

// Low-level refresh of account `i`. Returns true on success. When `force` is
// false it skips accounts whose token is still comfortably valid.
async function poolRefreshAccount(i: number, force: boolean): Promise<boolean> {
	const acct = poolAccounts[i];
	if (!acct) return false;
	if (!force && acct.expires > Date.now() + POOL_REFRESH_BUFFER_MS) return true;
	try {
		const next = await refreshAnthropicOAuth({ refresh: acct.refresh });
		acct.access = next.access;
		acct.expires = next.expires;
		if (next.refresh) acct.refresh = next.refresh;
		poolInvalid[i] = false;
		persistPool();
		poolLog(`refreshed ${acct.label} (exp ${new Date(acct.expires).toISOString()})`);
		return true;
	} catch (e) {
		const message = (e as Error)?.message ?? String(e);
		poolLog(`refresh FAILED ${acct.label}: ${message}`);
		if (/invalid_grant|refresh token (?:expired|revoked)|authentication_error|\b401\b/i.test(message)) {
			poolInvalid[i] = true;
			poolSelectActive();
		}
		return false;
	}
}

// Refresh account `i` only if it is near (or past) expiry.
async function poolEnsureFresh(i: number): Promise<void> {
	await poolRefreshAccount(i, false);
}

// Force a refresh of account `i` regardless of expiry (used on a 401, when the
// server rejected the token even though we thought it was still valid).
async function poolForceRefresh(i: number): Promise<boolean> {
	return poolRefreshAccount(i, true);
}

// Background keep-warm: refresh EVERY pooled account whose token is near expiry,
// not just the active one. This is what guarantees the failover target is never
// stale when we switch to it after it sat unused for a long time.
async function poolRefreshAll(): Promise<void> {
	if (poolRefreshInFlight) return; // never overlap refresh sweeps
	poolRefreshInFlight = true;
	try {
		for (let i = 0; i < poolAccounts.length; i++) {
			await poolEnsureFresh(i);
		}
	} finally {
		poolRefreshInFlight = false;
	}
}

function poolMarkRateLimited(headers?: Record<string, string>): void {
	const now = Date.now();
	let until = now + POOL_DEFAULT_COOLDOWN_MS;
	const ra =
		headers?.["retry-after"] ?? headers?.["anthropic-ratelimit-unified-reset"];
	if (ra) {
		const n = Number(ra);
		if (Number.isFinite(n)) until = n > 1e9 ? n * 1000 : now + n * 1000; // epoch-seconds vs delta-seconds
	}
	poolMarkRateLimitedUntil(until);
}

function poolMarkRateLimitedUntil(until: number): void {
	poolCooldownUntil[poolActive] = until;
	poolLog(
		`rate-limited ${poolAccounts[poolActive].label} until ${new Date(until).toISOString()}`,
	);
	poolSelectActive();
}

// Rate/usage-cap detection from ERROR MESSAGES.
//
// pi-ai's anthropic provider only invokes onResponse (→ after_provider_response)
// for SUCCESSFUL requests — on a 429/529 the Anthropic SDK throws before that
// callback, so the header-based hook above never sees rate limits in practice.
// The thrown error instead lands on the assistant message as stopReason:"error"
// + errorMessage, which flows through message_end. We pattern-match it there.
const POOL_LIMIT_RE =
	/\b429\b|\b529\b|rate[ _-]?limit|usage[ _-]?limit|overloaded_error|quota/i;

// Expired / rejected credential detection (401). When the active account's
// token is rejected we force-refresh it in place so the resend succeeds — this
// is the symptom of switching to an account that sat idle until its access
// token died. Anchored to avoid colliding with the 429 message.
const POOL_AUTH_RE =
	/authentication_error|invalid authentication credentials|\b401\b/i;

// Claude subscription cap messages often carry a reset epoch after a pipe,
// e.g. "Claude AI usage limit reached|1750000000".
function poolParseResetEpoch(message: string): number | undefined {
	const m = message.match(/\|(\d{9,13})\b/);
	if (!m) return undefined;
	const n = Number(m[1]);
	return n > 1e12 ? n : n * 1000;
}

// Returns true if the error was a rate/usage cap and the pool reacted.
function poolHandleErrorMessage(errorMessage: string): boolean {
	if (!POOL_LIMIT_RE.test(errorMessage)) return false;
	const until =
		poolParseResetEpoch(errorMessage) ?? Date.now() + POOL_DEFAULT_COOLDOWN_MS;
	poolMarkRateLimitedUntil(until);
	return true;
}

// Read the current single-slot anthropic OAuth creds from auth.json.
function readAnthropicAuth():
	| { refresh: string; access: string; expires: number }
	| undefined {
	try {
		const authPath = join(
			process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
			"auth.json",
		);
		if (!existsSync(authPath)) return undefined;
		const a = (
			JSON.parse(readFileSync(authPath, "utf-8")) as { anthropic?: PoolAccount }
		).anthropic;
		if (!a || !a.access || !a.refresh) return undefined;
		return { refresh: a.refresh, access: a.access, expires: a.expires ?? 0 };
	} catch {
		return undefined;
	}
}

// Upsert an account (by label) into claude-pool.json. Returns total count.
function poolUpsert(
	label: string,
	creds: { refresh: string; access: string; expires: number },
): number {
	let cfg: PoolConfig = { enabled: true, accounts: [] };
	try {
		if (existsSync(POOL_PATH))
			cfg = JSON.parse(readFileSync(POOL_PATH, "utf-8")) as PoolConfig;
	} catch {
		/* start fresh on a corrupt file */
	}
	if (!Array.isArray(cfg.accounts)) cfg.accounts = [];
	const entry: PoolAccount = { label, ...creds };
	const idx = cfg.accounts.findIndex((x) => x.label === label);
	if (idx >= 0) cfg.accounts[idx] = entry;
	else cfg.accounts.push(entry);
	cfg.enabled = cfg.enabled !== false;
	writeFileSync(POOL_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });

	// Keep a running session in sync with /claude-pool-add. Previously the file
	// changed but getApiKey() kept serving the stale in-memory token until restart.
	const activeLabel = poolAccounts[poolActive]?.label;
	const previousCooldown = new Map(
		poolAccounts.map((account, i) => [account.label, poolCooldownUntil[i] ?? 0]),
	);
	const previousInvalid = new Map(
		poolAccounts.map((account, i) => [account.label, poolInvalid[i] ?? false]),
	);
	poolAccounts = cfg.accounts;
	poolCooldownUntil = poolAccounts.map((account) =>
		account.label === label ? 0 : (previousCooldown.get(account.label) ?? 0),
	);
	poolInvalid = poolAccounts.map((account) =>
		account.label === label ? false : (previousInvalid.get(account.label) ?? false),
	);
	poolActive = Math.max(
		0,
		poolAccounts.findIndex((account) => account.label === activeLabel),
	);
	poolSelectActive();
	return cfg.accounts.length;
}

// /login enrollment + inspection. Always registered (touches files only, not
// the request path), so you can bootstrap the pool with the native /login.
function setupPoolCommands(pi: ExtensionAPI): void {
	const register = pi.registerCommand as unknown as (
		name: string,
		def: {
			description: string;
			handler: (
				args: string,
				ctx: { ui: { notify: (m: string, l?: string) => void } },
			) => Promise<void>;
		},
	) => void;

	register("claude-pool-add", {
		description:
			"Snapshot the current '/login anthropic' account into the Claude failover pool. Usage: /claude-pool-add <label>",
		handler: async (args, ctx) => {
			const label = (args || "").trim() || `account-${Date.now()}`;
			const creds = readAnthropicAuth();
			if (!creds) {
				ctx.ui.notify(
					"No anthropic OAuth creds in auth.json — run /login anthropic first.",
					"warning",
				);
				return;
			}
			const n = poolUpsert(label, creds);
			ctx.ui.notify(
				`Added "${label}" to Claude pool (${n} account${n === 1 ? "" : "s"}). ${n >= 2 ? "Restart to activate failover." : "Now /login the other account and run this again."}`,
				"info",
			);
		},
	});

	register("claude-pool-status", {
		description: "Show the Claude failover pool accounts",
		handler: async (_args, ctx) => {
			if (!existsSync(POOL_PATH)) {
				ctx.ui.notify(
					"No claude-pool.json yet. Use /claude-pool-add <label> after /login.",
					"info",
				);
				return;
			}
			try {
				const cfg = JSON.parse(readFileSync(POOL_PATH, "utf-8")) as PoolConfig;
				const lines = (cfg.accounts || []).map(
					(a, i) =>
						`  ${i}. ${a.label} (exp ${a.expires ? new Date(a.expires).toISOString() : "?"})`,
				);
				ctx.ui.notify(
					`Claude pool (enabled=${cfg.enabled !== false}):\n${lines.join("\n") || "  (none)"}`,
					"info",
				);
			} catch (e) {
				ctx.ui.notify(`pool read error: ${(e as Error).message}`, "warning");
			}
		},
	});
}

function setupPool(pi: ExtensionAPI): void {
	if (process.env.PI_CLAUDE_PROVIDER_POOL_DISABLE === "1") return;
	if (!loadPool()) return; // inert unless a valid claude-pool.json exists
	poolLog(`pool active: ${poolAccounts.map((a) => a.label).join(", ")}`);

	const prep = async () => {
		poolSelectActive();
		// Keep ALL accounts warm, not just the active one, so the failover target
		// is ready the instant we switch to it.
		await poolRefreshAll();
	};
	pi.on("session_start", async () => {
		await prep();
	});
	pi.on("before_agent_start", async () => {
		await prep();
	});

	// Background keep-warm loop: refresh every account before it expires even
	// while idle / not active. This is the core fix — the failover target is kept
	// fresh continuously so it's never expired when we switch to it.
	//
	// unref() is CRITICAL: an active timer handle keeps the Node event loop alive
	// and would prevent short-lived CLI commands (e.g. `pi update`) from exiting.
	// We also do NOT fire an immediate refresh here — interactive sessions warm
	// via session_start; firing at module load would add network I/O to the CLI
	// path. The first tick lands one interval later, only in long-lived sessions.
	poolBgTimer = setInterval(() => {
		void poolRefreshAll();
	}, POOL_BG_REFRESH_INTERVAL_MS);
	if (typeof poolBgTimer.unref === "function") poolBgTimer.unref();

	// PRIMARY rate/usage-cap detector: provider errors surface on the assistant
	// message (stopReason "error"), not via after_provider_response (the SDK
	// throws on 429/529 before pi-ai's onResponse callback runs).
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
			const prev = poolAccounts[poolActive]?.label;

			// 401 / expired-credential path: the server rejected the ACTIVE token.
			// Force-refresh it in place (don't switch accounts) so the resend works.
			if (
				POOL_AUTH_RE.test(msg.errorMessage) &&
				!POOL_LIMIT_RE.test(msg.errorMessage)
			) {
				const ok = await poolForceRefresh(poolActive);
				ctx.ui.notify(
					ok
						? `Claude account "${prev}" had an expired token — refreshed it. Resend your message to continue.`
						: `Claude account "${prev}" token is invalid and refresh FAILED — its refresh token was likely revoked. Run /login anthropic then /claude-pool-add ${prev}.`,
					ok ? "info" : "warning",
				);
				return undefined;
			}

			if (!poolHandleErrorMessage(msg.errorMessage)) return undefined;
			const next = poolAccounts[poolActive]?.label;
			if (next !== prev) {
				await poolEnsureFresh(poolActive);
				ctx.ui.notify(
					`Claude account "${prev}" hit its limit → switched to "${next}". Resend your message to continue.`,
					"warning",
				);
			} else {
				ctx.ui.notify(
					`Claude account "${prev}" hit its limit and all pooled accounts are cooling down — retrying on the one that frees up soonest.`,
					"warning",
				);
			}
		} catch {
			/* detection must never break the message path */
		}
		return undefined;
	});

	// Secondary detector (kept for transports that DO surface response headers).
	pi.on("after_provider_response", (event: unknown) => {
		try {
			const e = event as {
				status?: number;
				statusCode?: number;
				headers?: Record<string, string>;
			};
			const status = e.status ?? e.statusCode;
			if (status === 429 || status === 529) poolMarkRateLimited(e.headers);
		} catch {
			/* observation only — never break the response path */
		}
		return undefined;
	});

	// Supply the active pooled account's token to Pi's Anthropic transport.
	const register = pi.registerProvider as unknown as (
		id: string,
		cfg: unknown,
	) => void;
	register("anthropic", {
		oauth: {
			name: `Claude (pooled: ${poolAccounts.map((a) => a.label).join("+")})`,
			login: loginAnthropicOAuth,
			async refreshToken(_creds: unknown) {
				await poolEnsureFresh(poolActive);
				const a = poolAccounts[poolActive];
				return { refresh: a.refresh, access: a.access, expires: a.expires };
			},
			getApiKey(creds: { access?: string } | undefined) {
				const a = poolAccounts[poolActive];
				return (a && a.access) || creds?.access || "";
			},
		},
	});
}

export default function piProviderClaude(pi: ExtensionAPI): void {
	// mcp__pi__* → flat, before the agent loop resolves the tool.
	pi.on("message_end", async (event, _ctx) => {
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
		) {
			return undefined; // only Anthropic OAuth
		}
		if (!isPlainObject(event.payload)) return undefined;

		writeDebugLog({ stage: "before", payload: event.payload });
		const disable = process.env.PI_CLAUDE_PROVIDER_DISABLE === "1";
		const transformed = transformPayload(
			event.payload as Record<string, unknown>,
			disable,
		);
		writeDebugLog({ stage: "after", payload: transformed });
		return transformed;
	});

	// Multi-account failover.
	setupPoolCommands(pi); // /claude-pool-add, /claude-pool-status (always available)
	setupPool(pi); // failover provider override (active once >=2 accounts exist)
}
