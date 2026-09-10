import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

export interface AnthropicOAuthCredential {
	type: "oauth";
	refresh: string;
	access: string;
	expires: number;
}

export interface AnthropicOAuthLoginCallbacks {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onManualCodeInput: () => Promise<string>;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}

const CLIENT_ID = Buffer.from("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl", "base64").toString("utf8");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

type AuthorizationResult = { code: string; state: string };

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// Not a URL; continue with the other supported formats.
	}
	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}
	return { code: value };
}

function formatErrorDetails(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	return `${error.name}: ${error.message}${error.stack ? `; stack=${error.stack}` : ""}`;
}

async function startCallbackServer(expectedState: string): Promise<{
	server: ReturnType<typeof createServer>;
	cancelWait: () => void;
	waitForCode: () => Promise<AuthorizationResult | null>;
}> {
	return new Promise((resolve, reject) => {
		let settleWait: (value: AuthorizationResult | null) => void = () => undefined;
		const waitForCode = new Promise<AuthorizationResult | null>((resolveWait) => {
			let settled = false;
			settleWait = (value) => {
				if (settled) return;
				settled = true;
				resolveWait(value);
			};
		});
		const server = createServer((req, res) => {
			try {
				const url = new URL(req.url || "", "http://localhost");
				if (url.pathname !== CALLBACK_PATH) {
					res.writeHead(404);
					res.end("Callback route not found.");
					return;
				}
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");
				if (error) {
					res.writeHead(400);
					res.end(`Anthropic authentication did not complete: ${error}`);
					return;
				}
				if (!code || !state) {
					res.writeHead(400);
					res.end("Missing code or state parameter.");
					return;
				}
				if (state !== expectedState) {
					res.writeHead(400);
					res.end("State mismatch.");
					return;
				}
				res.writeHead(200);
				res.end("Anthropic authentication completed. You can close this window.");
				settleWait({ code, state });
			} catch {
				res.writeHead(500);
				res.end("Internal error");
			}
		});
		server.once("error", reject);
		server.listen(CALLBACK_PORT, CALLBACK_HOST, () =>
			resolve({
				server,
				cancelWait: () => settleWait(null),
				waitForCode: () => waitForCode,
			}),
		);
	});
}

async function postJson(url: string, body: Record<string, unknown>): Promise<string> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	const responseBody = await response.text();
	if (!response.ok) {
		throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`);
	}
	return responseBody;
}

async function exchangeAuthorizationCode(
	code: string,
	state: string,
	verifier: string,
): Promise<AnthropicOAuthCredential> {
	let responseBody: string;
	try {
		responseBody = await postJson(TOKEN_URL, {
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			state,
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
		});
	} catch (error) {
		throw new Error(`Token exchange request failed. details=${formatErrorDetails(error)}`);
	}
	let tokenData: { refresh_token?: string; access_token?: string; expires_in?: number };
	try {
		tokenData = JSON.parse(responseBody) as typeof tokenData;
	} catch (error) {
		throw new Error(`Token exchange returned invalid JSON. body=${responseBody}; details=${formatErrorDetails(error)}`);
	}
	if (!tokenData.refresh_token || !tokenData.access_token || !tokenData.expires_in) {
		throw new Error("Token exchange response did not contain complete OAuth credentials.");
	}
	return {
		type: "oauth",
		refresh: tokenData.refresh_token,
		access: tokenData.access_token,
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
	};
}

export async function loginAnthropicOAuth(
	callbacks: AnthropicOAuthLoginCallbacks,
): Promise<AnthropicOAuthCredential> {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const server = await startCallbackServer(verifier);
	let manualInput: string | undefined;
	let manualError: Error | undefined;
	try {
		const authParams = new URLSearchParams({
			code: "true",
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
		});
		callbacks.onAuth({
			url: `${AUTHORIZE_URL}?${authParams.toString()}`,
			instructions: "Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});
		const manualPromise = callbacks
			.onManualCodeInput()
			.then((input) => {
				manualInput = input;
				server.cancelWait();
			})
			.catch((error: unknown) => {
				manualError = error instanceof Error ? error : new Error(String(error));
				server.cancelWait();
			});
		const result = await server.waitForCode();
		if (manualError) throw manualError;
		const parsed = result ?? (manualInput ? parseAuthorizationInput(manualInput) : {});
		if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
		if (!parsed.code) {
			await manualPromise;
			if (manualError) throw manualError;
			const fallback = parseAuthorizationInput(manualInput ?? "");
			if (fallback.state && fallback.state !== verifier) throw new Error("OAuth state mismatch");
			parsed.code = fallback.code;
		}
		if (!parsed.code) throw new Error("Missing authorization code");
		callbacks.onProgress?.("Exchanging authorization code for tokens...");
		return exchangeAuthorizationCode(parsed.code, parsed.state ?? verifier, verifier);
	} finally {
		server.server.close();
	}
}

export async function refreshAnthropicOAuth(
	credential: Pick<AnthropicOAuthCredential, "refresh">,
): Promise<AnthropicOAuthCredential> {
	const outcome = await refreshGrant(credential.refresh);
	if (!outcome.credential)
		throw new Error(`Anthropic token refresh failed (${outcome.error}).`);
	return outcome.credential;
}

// ─── classified refresh grant ────────────────────────────────────────────────
// Upstream treated any /401|authentication_error/ in the error TEXT as a dead
// account, so one proxy hiccup permanently dropped a live login. RFC 6749 §5.2
// says the verdict is the top-level `error` member of a 4xx JSON body — nothing
// else is permanent. A misclassified transient costs one retry; a misclassified
// permanent throws away a working subscription.

export type RefreshError =
	| "invalid_grant" // this refresh lineage is dead → /login again
	| "invalid_client" // OUR client_id was rejected → systemic, blames no account
	| "no_refresh_token"
	| "transient"; // network/5xx/unparseable → retry later, token may live

export interface RefreshOutcome {
	credential?: AnthropicOAuthCredential;
	error?: RefreshError;
	/** Login (refresh-token) expiry in epoch ms, when the server reports it. */
	refreshExpires?: number;
}

export async function refreshGrant(refresh: string): Promise<RefreshOutcome> {
	if (!refresh) return { error: "no_refresh_token" };
	let response: Response;
	let body: string;
	try {
		response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: refresh,
			}),
			signal: AbortSignal.timeout(30_000),
		});
		body = await response.text();
	} catch {
		return { error: "transient" };
	}
	if (!response.ok) {
		if (response.status === 400 || response.status === 401 || response.status === 403) {
			let err: unknown;
			try {
				err = (JSON.parse(body) as { error?: unknown }).error;
			} catch {
				err = undefined; // unparseable body → stay transient
			}
			if (err === "invalid_grant" || err === "invalid_client")
				return { error: err };
		}
		return { error: "transient" };
	}
	let data: {
		refresh_token?: string;
		access_token?: string;
		expires_in?: number;
		refresh_token_expires_in?: number;
		refresh_expires_in?: number;
	};
	try {
		data = JSON.parse(body) as typeof data;
	} catch {
		return { error: "transient" };
	}
	if (!data.access_token || !data.expires_in) return { error: "transient" };
	const refreshTtl = data.refresh_token_expires_in ?? data.refresh_expires_in;
	return {
		credential: {
			type: "oauth",
			refresh: data.refresh_token ?? refresh,
			access: data.access_token,
			// Raw expiry. The pre-expiry safety margin lives in the pool, so the
			// buffer isn't applied twice (upstream baked 5min in here AND there).
			expires: Date.now() + data.expires_in * 1000,
		},
		refreshExpires: refreshTtl ? Date.now() + refreshTtl * 1000 : undefined,
	};
}

// ─── usage / quota ───────────────────────────────────────────────────────────
// Same endpoint Claude Code and claude-swap read. Budget is ~28-30 requests per
// trailing 60-minute window per identity with NO refill (a burst blocks the
// account for a full hour), so all polling goes through usage.ts's cadence.

export interface UsageWindow {
	pct: number;
	resets_at?: string;
}
export interface UsageSnapshot {
	five_hour?: UsageWindow;
	seven_day?: UsageWindow;
	/** Per-model weekly windows, e.g. { name: "Fable", pct: 12 }. */
	scoped?: { name: string; pct: number; resets_at?: string }[];
	spend?: { used: number; limit: number; pct: number; currency: string };
}

export class UsageHttpError extends Error {
	// Explicit fields, not constructor parameter properties: Node's strip-only
	// TypeScript loader (used by `cpool` and the self-check) rejects those.
	status: number;
	retryAfterS?: number;
	constructor(status: number, retryAfterS?: number) {
		super(`usage http-${status}`);
		this.status = status;
		this.retryAfterS = retryAfterS;
	}
}

/** Who a credential belongs to — used to attach a fresh login to the right
 * pooled account instead of asking the user to remember which one they just
 * signed into. */
export interface Profile {
	uuid?: string;
	email?: string;
	org?: string;
	plan?: string;
}

export async function fetchProfile(access: string): Promise<Profile> {
	const response = await fetch("https://api.anthropic.com/api/oauth/profile", {
		headers: {
			Authorization: `Bearer ${access}`,
			"anthropic-beta": "oauth-2025-04-20",
		},
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new UsageHttpError(response.status);
	const data = (await response.json()) as {
		account?: { uuid?: string; email?: string; has_claude_max?: boolean; has_claude_pro?: boolean };
		organization?: { name?: string };
	};
	return {
		uuid: data.account?.uuid,
		email: data.account?.email,
		org: data.organization?.name,
		plan: data.account?.has_claude_max ? "max" : data.account?.has_claude_pro ? "pro" : undefined,
	};
}

export async function fetchUsage(access: string): Promise<UsageSnapshot> {
	const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
		headers: {
			Authorization: `Bearer ${access}`,
			"anthropic-beta": "oauth-2025-04-20",
		},
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		const raw = response.headers.get("retry-after");
		const retry = raw ? Number(raw) : undefined;
		throw new UsageHttpError(
			response.status,
			Number.isFinite(retry) ? (retry as number) : undefined,
		);
	}
	return parseUsage((await response.json()) as Record<string, unknown>);
}

export function parseUsage(data: Record<string, unknown>): UsageSnapshot {
	const out: UsageSnapshot = {};
	const win = (raw: unknown): UsageWindow | undefined => {
		if (!raw || typeof raw !== "object") return undefined;
		const w = raw as { utilization?: unknown; resets_at?: unknown };
		if (typeof w.utilization !== "number") return undefined;
		return {
			pct: w.utilization,
			resets_at: typeof w.resets_at === "string" ? w.resets_at : undefined,
		};
	};
	out.five_hour = win(data.five_hour);
	out.seven_day = win(data.seven_day);

	if (Array.isArray(data.limits)) {
		const scoped: NonNullable<UsageSnapshot["scoped"]> = [];
		for (const lim of data.limits) {
			if (!lim || typeof lim !== "object") continue;
			const l = lim as {
				scope?: { model?: { display_name?: unknown } };
				percent?: unknown;
				resets_at?: unknown;
			};
			const name = l.scope?.model?.display_name;
			if (typeof name !== "string" || typeof l.percent !== "number") continue;
			scoped.push({
				name,
				pct: l.percent,
				resets_at: typeof l.resets_at === "string" ? l.resets_at : undefined,
			});
		}
		if (scoped.length) out.scoped = scoped;
	}

	const eu = data.extra_usage as
		| {
				is_enabled?: boolean;
				used_credits?: number | null;
				monthly_limit?: number | null;
				utilization?: number | null;
				currency?: string;
		  }
		| undefined;
	if (
		eu?.is_enabled &&
		typeof eu.used_credits === "number" &&
		typeof eu.monthly_limit === "number" &&
		typeof eu.utilization === "number"
	) {
		out.spend = {
			used: eu.used_credits / 100,
			limit: eu.monthly_limit / 100,
			pct: eu.utilization,
			currency: eu.currency ?? "USD",
		};
	}
	return out;
}
