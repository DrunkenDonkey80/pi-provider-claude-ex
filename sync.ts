/**
 * Credential sync over a shared git repo.
 *
 * The problem: Anthropic's refresh tokens are single-use. Two machines holding
 * the same generation means the first to refresh revokes the other's copy, and
 * that copy is then permanently `invalid_grant`. Exporting again only restarts
 * the race.
 *
 * The fix is NOT to sync refresh tokens faster — it is to share the ACCESS
 * token, which is valid for hours. A machine that needs one pulls it instead of
 * POSTing, so per rotation only one machine ever calls the token endpoint.
 * Same principle as the lazy-refresh model in pool.ts: fewer grants, longer
 * life.
 *
 * Shape:
 *   - one encrypted file per account, so two machines rotating two different
 *     accounts touch two different paths and can never conflict
 *   - `expires` IS the version. A rotation always yields a later access expiry,
 *     so "newest wins" needs no counter to keep in sync
 *   - file names are keyed hashes, so a repo read leaks no account emails
 *   - every operation is best-effort: sync failing must never break a refresh
 *
 * Races are not eliminated (two machines can still POST in the same second),
 * but they stop being terminal: the loser pulls the winner's credential
 * instead of dying. See adoptRemote() in pool.ts.
 */

import { execFileSync } from "node:child_process";
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { AGENT_DIR, type SyncConfig, withLock } from "./store.ts";

export const SYNC_DIR = join(AGENT_DIR, "claude-pool-sync");

/** One account's credential as it travels between machines. */
export interface SyncedCred {
	label: string;
	refresh: string;
	access: string;
	expires: number;
	refreshExpires?: number;
	/** When the machine that rotated it wrote this, epoch ms. */
	at: number;
	/** Which machine rotated it — for the status line only. */
	by: string;
}

export const newKey = (): string => randomBytes(32).toString("hex");

export const syncReady = (config?: SyncConfig): config is SyncConfig =>
	Boolean(config?.url && config.key);

export const syncOn = (config?: SyncConfig): config is SyncConfig =>
	syncReady(config) && config.on !== false;

/**
 * File name for an account: a hash keyed with the shared secret. The contents
 * are encrypted anyway, but plain `flex@datecs.bg.json` in a repo listing
 * would hand over the account roster to anyone who can read it.
 */
export const credPath = (label: string, key: string): string =>
	`accounts/${createHash("sha256").update(`${key}\0${label}`).digest("hex").slice(0, 16)}.bin`;

/** AES-256-GCM: iv | tag | ciphertext, base64. */
export function seal(value: unknown, key: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv, {
		authTagLength: 16,
	});
	const body = Buffer.concat([
		cipher.update(JSON.stringify(value), "utf-8"),
		cipher.final(),
	]);
	return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/** Undefined on a wrong key or a corrupt blob — never throws at a call site. */
export function open<T>(text: string, key: string): T | undefined {
	try {
		const raw = Buffer.from(text.trim(), "base64");
		const decipher = createDecipheriv(
			"aes-256-gcm",
			Buffer.from(key, "hex"),
			raw.subarray(0, 12),
			{ authTagLength: 16 },
		);
		decipher.setAuthTag(raw.subarray(12, 28));
		return JSON.parse(
			Buffer.concat([
				decipher.update(raw.subarray(28)),
				decipher.final(),
			]).toString("utf-8"),
		) as T;
	} catch {
		return undefined;
	}
}

// ─── git ────────────────────────────────────────────────────────────────────

const git = (args: string[], cwd = SYNC_DIR): string =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		timeout: 60_000,
		stdio: ["ignore", "pipe", "pipe"],
		// Never block on a credential prompt: a hung git would hang a refresh.
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});

function fetchLatest(): void {
	try {
		git(["fetch", "--quiet", "--depth", "1", "origin"]);
		git(["reset", "--quiet", "--hard", "FETCH_HEAD"]);
		git(["clean", "-qfd"]);
	} catch {
		// An empty remote has nothing to fetch — that is the first-push case.
	}
}

function ensureRepo(config: SyncConfig): void {
	if (!existsSync(join(SYNC_DIR, ".git"))) {
		mkdirSync(AGENT_DIR, { recursive: true });
		rmSync(SYNC_DIR, { recursive: true, force: true });
		git(["clone", "--quiet", "--depth", "1", config.url, SYNC_DIR], AGENT_DIR);
		git(["config", "user.email", "claude-pool@localhost"]);
		git(["config", "user.name", "claude-pool"]);
		return;
	}
	git(["remote", "set-url", "origin", config.url]);
	fetchLatest();
}

function readLocalCopy(
	label: string,
	config: SyncConfig,
): SyncedCred | undefined {
	const file = join(SYNC_DIR, credPath(label, config.key));
	if (!existsSync(file)) return undefined;
	const cred = open<SyncedCred>(readFileSync(file, "utf-8"), config.key);
	return typeof cred?.refresh === "string" && typeof cred.expires === "number"
		? cred
		: undefined;
}

/**
 * Newest credential for one account, or undefined when sync is off, the repo
 * is unreachable, or nothing has been pushed yet. Never throws.
 */
export async function pullCred(
	label: string,
	config: SyncConfig,
): Promise<SyncedCred | undefined> {
	try {
		return await withLock(
			SYNC_DIR,
			() => {
				ensureRepo(config);
				return readLocalCopy(label, config);
			},
			{ timeoutMs: 20_000 },
		);
	} catch {
		return undefined;
	}
}

/**
 * Publish one credential. Returns a remote credential that beat ours, so the
 * caller can adopt it instead — a push conflict means another machine rotated
 * the same lineage first, and its token is the live one.
 */
export async function pushCred(
	cred: SyncedCred,
	config: SyncConfig,
): Promise<SyncedCred | undefined> {
	try {
		return await withLock(
			SYNC_DIR,
			() => {
				ensureRepo(config);
				const file = join(SYNC_DIR, credPath(cred.label, config.key));
				for (let attempt = 0; attempt < 3; attempt++) {
					// `expires` is the version: a later access expiry is a later
					// rotation, so anything newer than ours wins and we adopt it.
					const remote = readLocalCopy(cred.label, config);
					if (remote && remote.expires > cred.expires) return remote;

					mkdirSync(join(SYNC_DIR, "accounts"), { recursive: true });
					writeFileSync(file, `${seal(cred, config.key)}\n`, { mode: 0o600 });
					git(["add", "--", file]);
					try {
						git(["commit", "--quiet", "-m", `sync ${credPath(cred.label, config.key).slice(9, 17)}`]);
					} catch {
						return undefined; // identical content: already published
					}
					try {
						git(["push", "--quiet", "origin", "HEAD"]);
						return undefined;
					} catch {
						fetchLatest(); // rejected: someone pushed first, re-read and retry
					}
				}
				return readLocalCopy(cred.label, config);
			},
			{ timeoutMs: 30_000 },
		);
	} catch {
		return undefined;
	}
}

/**
 * Every published credential for these labels, in ONE fetch. pullCred per
 * account would be one git round trip each.
 */
export async function pullAll(
	labels: string[],
	config: SyncConfig,
): Promise<Map<string, SyncedCred>> {
	try {
		return await withLock(
			SYNC_DIR,
			() => {
				ensureRepo(config);
				const found = new Map<string, SyncedCred>();
				for (const label of labels) {
					const cred = readLocalCopy(label, config);
					if (cred) found.set(label, cred);
				}
				return found;
			},
			{ timeoutMs: 20_000 },
		);
	} catch {
		return new Map();
	}
}

/** Publish several credentials as one commit and one push. */
export async function pushAll(
	creds: SyncedCred[],
	config: SyncConfig,
): Promise<number> {
	if (!creds.length) return 0;
	try {
		return await withLock(
			SYNC_DIR,
			() => {
				ensureRepo(config);
				for (let attempt = 0; attempt < 3; attempt++) {
					mkdirSync(join(SYNC_DIR, "accounts"), { recursive: true });
					let written = 0;
					for (const cred of creds) {
						const remote = readLocalCopy(cred.label, config);
						if (remote && remote.expires >= cred.expires) continue;
						writeFileSync(
							join(SYNC_DIR, credPath(cred.label, config.key)),
							`${seal(cred, config.key)}\n`,
							{ mode: 0o600 },
						);
						written++;
					}
					if (!written) return 0;
					git(["add", "--all", "accounts"]);
					try {
						git(["commit", "--quiet", "-m", `sync ${written} account(s)`]);
					} catch {
						return 0; // nothing actually changed
					}
					try {
						git(["push", "--quiet", "origin", "HEAD"]);
						return written;
					} catch {
						fetchLatest(); // lost the push race: re-read and retry
					}
				}
				return 0;
			},
			{ timeoutMs: 40_000 },
		);
	} catch {
		return 0;
	}
}

export const credOf = (account: {
	label: string;
	refresh: string;
	access: string;
	expires: number;
	refreshExpires?: number;
}): SyncedCred => ({
	label: account.label,
	refresh: account.refresh,
	access: account.access,
	expires: account.expires,
	refreshExpires: account.refreshExpires,
	at: Date.now(),
	by: hostname(),
});

/** First contact: clone and report what is in there. Throws so setup can show why. */
export async function checkRepo(config: SyncConfig): Promise<number> {
	return withLock(
		SYNC_DIR,
		() => {
			ensureRepo(config);
			const dir = join(SYNC_DIR, "accounts");
			if (!existsSync(dir)) return 0;
			return readdirSync(dir).filter((f) => f.endsWith(".bin")).length;
		},
		{ timeoutMs: 30_000 },
	);
}
