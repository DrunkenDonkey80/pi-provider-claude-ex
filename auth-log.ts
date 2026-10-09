/** Local auth history only: never credentials, response bodies or prompts. */
import { hostname } from "node:os";
import { join } from "node:path";
import {
	AGENT_DIR, type Account, fingerprint, readJson, withLock, writeJsonAtomic,
} from "./store.ts";

export const AUTH_LOG_PATH = join(AGENT_DIR, "claude-pool-auth.json");
export const AUTH_LOG_LIMIT = 500;
export type RefreshCause = "expiry" | "manual" | "auth_error" | "keepalive" | "forced";
type AuthEvent = "refresh_start" | "refresh_ok" | "refresh_failed" | "dead"
	| "local_adopt" | "sync_check" | "sync_adopt" | "refresh_exception"
	| "sync_fetch_failed" | "sync_failed" | "sync_push_failed" | "sync_published";
interface Details {
	cause?: RefreshCause;
	status?: number;
	error?: unknown;
	stage?: "lock" | "sync" | "grant" | "persist" | "publish";
	result?: "unavailable" | "same_generation" | "not_newer" | "expiring";
	fromGeneration?: string;
	by?: string;
	syncEnabled?: boolean;
}

export async function recordAuthEvent(
	event: AuthEvent,
	account: Partial<Account> & Pick<Account, "label">,
	details: Details = {},
): Promise<void> {
	try {
		// Whitelist fields even when a caller passes a full credential or an Error.
		const failure = details.error as { code?: unknown; status?: unknown } | null;
		const code = typeof failure === "object" && failure !== null
			? failure.code ?? failure.status : details.error;
		const row = {
			at: new Date().toISOString(), host: hostname(), pid: process.pid,
			event, label: account.label,
			generation: account.refresh ? fingerprint(account.refresh) : undefined,
			accessExpires: account.expires, refreshExpires: account.refreshExpires,
			dead: account.dead, cause: details.cause, status: details.status,
			error: typeof code === "number" || (typeof code === "string" && /^[a-zA-Z0-9_]{1,40}$/.test(code))
				? code : undefined,
			stage: details.stage, result: details.result,
			fromGeneration: details.fromGeneration, by: details.by, syncEnabled: details.syncEnabled,
		};
		await withLock(AUTH_LOG_PATH, () => {
			const history = readJson<unknown>(AUTH_LOG_PATH, []);
			writeJsonAtomic(AUTH_LOG_PATH, [...(Array.isArray(history) ? history.slice(-(AUTH_LOG_LIMIT - 1)) : []), row]);
		}, { timeoutMs: 500 });
	} catch {
		// Diagnostics must never break a refresh or lose its durable successor.
	}
}
