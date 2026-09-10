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
	let responseBody: string;
	try {
		responseBody = await postJson(TOKEN_URL, {
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: credential.refresh,
		});
	} catch (error) {
		throw new Error(`Anthropic token refresh request failed. details=${formatErrorDetails(error)}`);
	}
	const data = JSON.parse(responseBody) as {
		refresh_token?: string;
		access_token?: string;
		expires_in?: number;
	};
	if (!data.access_token || !data.expires_in) {
		throw new Error("Anthropic token refresh response did not contain complete OAuth credentials.");
	}
	return {
		type: "oauth",
		refresh: data.refresh_token ?? credential.refresh,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}
