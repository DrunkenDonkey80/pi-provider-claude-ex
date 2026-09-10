/**
 * Self-check: the failure modes that killed pooled logins, plus the new
 * quota/backoff logic. Plain asserts, no framework.
 *
 *   node test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "cpool-test-"));
process.env.PI_CODING_AGENT_DIR = dir;

const store = await import("./store.ts");
const { parseUsage } = await import("./oauth.ts");
const usage = await import("./usage.ts");
const format = await import("./format.ts");

const results: string[] = [];
const check = async (name: string, fn: () => Promise<void> | void) => {
	try {
		await fn();
		results.push(`ok   ${name}`);
	} catch (e) {
		results.push(`FAIL ${name}: ${(e as Error).message}`);
		process.exitCode = 1;
	}
};

const seed = (accounts: unknown[]) =>
	writeFileSync(store.POOL_PATH, JSON.stringify({ enabled: true, accounts }));
const acct = (label: string, over: Record<string, unknown> = {}) => ({
	label,
	refresh: `rt-${label}-1`,
	access: `at-${label}-1`,
	expires: Date.now() + 3_600_000,
	...over,
});

// 1. Concurrent mutations must merge, not clobber. Upstream's whole-file
//    writeFileSync from a process-local snapshot lost the other writer's
//    rotated token — the core reason accounts "expired".
await check("concurrent mutateStore keeps both writers' changes", async () => {
	seed([acct("a"), acct("b")]);
	await Promise.all([
		store.mutateStore((s) => {
			const x = s.accounts.find((a) => a.label === "a");
			if (x) x.refresh = "rt-a-2";
		}),
		store.mutateStore((s) => {
			const x = s.accounts.find((a) => a.label === "b");
			if (x) x.refresh = "rt-b-2";
		}),
	]);
	const after = store.readStore();
	assert.equal(after.accounts.find((a) => a.label === "a")?.refresh, "rt-a-2");
	assert.equal(after.accounts.find((a) => a.label === "b")?.refresh, "rt-b-2");
});

// 2. A crash between the token POST and the store write must not lose the
//    rotated refresh token (retrying with the spent one is fatal, permanently).
await check("stashed successor is adopted when the store write was lost", () => {
	seed([acct("a")]);
	store.stashPut("a", {
		refresh: "rt-a-2",
		access: "at-a-2",
		expires: Date.now() + 7_200_000,
		refreshExpires: Date.now() + 30 * 86_400_000,
	});
	const adopted = store.readStore().accounts[0];
	assert.equal(adopted.refresh, "rt-a-2");
	assert.equal(adopted.access, "at-a-2");
	assert.ok(adopted.refreshExpires);
});

await check("stashDrop only retires the generation it persisted", () => {
	seed([acct("a")]);
	store.stashPut("a", { refresh: "rt-a-2", access: "at-a-2", expires: 1 });
	store.stashDrop("a", "rt-a-OLD"); // a stale retire must not delete a newer row
	assert.equal(store.readStore().accounts[0].refresh, "rt-a-2");
	store.stashDrop("a", "rt-a-2");
	assert.equal(store.readStore().accounts[0].refresh, "rt-a-1");
});

// 3. Lock mutual exclusion (the property everything else rests on).
await check("withDirLock serializes and releases", async () => {
	const lock = join(dir, "probe.lock");
	let inside = 0;
	let maxInside = 0;
	const body = async () => {
		inside++;
		maxInside = Math.max(maxInside, inside);
		await new Promise((r) => setTimeout(r, 30));
		inside--;
	};
	await Promise.all([
		store.withDirLock(lock, body),
		store.withDirLock(lock, body),
		store.withDirLock(lock, body),
	]);
	assert.equal(maxInside, 1);
	assert.equal(existsSync(lock), false);
});

await check("a stale lock is taken over, a live one is not", async () => {
	const lock = join(dir, "stale.lock");
	await store.withDirLock(lock, async () => {
		await assert.rejects(
			() => store.withDirLock(lock, () => undefined, { timeoutMs: 150, staleMs: 60_000 }),
			/lock busy/,
		);
		// same lock, but now considered stale → taken over instead of failing
		await store.withDirLock(lock, () => undefined, { timeoutMs: 500, staleMs: 0 });
	});
});

// 4. Selection: sticky while usable, quota-aware otherwise, never a dead or
//    disabled account (unless explicitly targeted).
await check("pickActive stays pinned while the pin is usable", async () => {
	seed([acct("a"), acct("b")]);
	await store.mutateStore((s) => {
		s.active = "b";
	});
	assert.equal((await import("./pool.ts")).pickActive(store.readStore()), "b");
});

await check("pickActive skips dead/disabled/cooling and prefers most quota", async () => {
	const pool = await import("./pool.ts");
	seed([
		acct("dead", { dead: true }),
		acct("off", { disabled: true }),
		acct("cool", { cooldownUntil: Date.now() + 600_000 }),
		acct("low"),
		acct("high"),
	]);
	store.writeJsonAtomic(store.USAGE_PATH, {
		low: { at: Date.now(), five_hour: { pct: 90 }, seven_day: { pct: 10 } },
		high: { at: Date.now(), five_hour: { pct: 5 }, seven_day: { pct: 20 } },
	});
	assert.equal(pool.pickActive(store.readStore()), "high");
	// everything unusable → the one that frees up soonest, never a dead one
	seed([acct("dead", { dead: true }), acct("cool", { cooldownUntil: Date.now() + 600_000 })]);
	assert.equal(pool.pickActive(store.readStore()), "cool");
	rmSync(store.USAGE_PATH, { force: true });
});

// 5. Usage parsing + cadence.
await check("parseUsage reads 5h, 7d, per-model and spend", () => {
	const parsed = parseUsage({
		five_hour: { utilization: 34, resets_at: "2026-01-01T00:00:00Z" },
		seven_day: { utilization: 71 },
		limits: [
			{ scope: { model: { display_name: "Fable" } }, percent: 12 },
			{ scope: {}, percent: 3 },
			{ scope: { model: { display_name: "Bad" } } },
		],
		extra_usage: { is_enabled: true, used_credits: 250, monthly_limit: 5000, utilization: 5 },
	});
	assert.equal(parsed.five_hour?.pct, 34);
	assert.equal(parsed.five_hour?.resets_at, "2026-01-01T00:00:00Z");
	assert.equal(parsed.seven_day?.pct, 71);
	assert.deepEqual(parsed.scoped, [{ name: "Fable", pct: 12, resets_at: undefined }]);
	assert.equal(parsed.spend?.used, 2.5);
	assert.equal(parsed.spend?.limit, 50);
	assert.deepEqual(parseUsage({}).five_hour, undefined);
});

await check("usage cache serves within TTL and backs off after a failure", async () => {
	rmSync(store.USAGE_PATH, { force: true });
	let calls = 0;
	const token = async () => {
		calls++;
		return undefined; // forces the no-access-token path: no network in tests
	};
	await usage.collectUsage(["a"], token);
	assert.equal(calls, 1);
	const first = usage.readUsage().a;
	assert.equal(first.error, "no-access-token");
	assert.ok(first.nextPollAt! > Date.now() + 60_000, "next poll is throttled");
	await usage.collectUsage(["a"], token); // still inside the interval
	assert.equal(calls, 1, "a due-check must not re-fetch inside the interval");
	// error passes keep the last-known windows (fail safe, never blank)
	store.writeJsonAtomic(store.USAGE_PATH, {
		a: { at: Date.now(), five_hour: { pct: 42 }, nextPollAt: 0, intervalMs: 180_000 },
	});
	await usage.collectUsage(["a"], token);
	assert.equal(usage.readUsage().a.five_hour?.pct, 42);
	assert.equal(usage.readUsage().a.intervalMs, 360_000, "interval doubles on failure");
});

await check("headroom uses the tightest window", () => {
	assert.equal(usage.headroom({ five_hour: { pct: 90 }, seven_day: { pct: 10 } }), 10);
	assert.equal(usage.headroom(undefined), undefined);
});

// 6. Cap-message parsing: a wrong reset epoch either wastes an account or
//    retries into a wall.
await check("cooldown parses Claude's reset epoch (s and ms)", async () => {
	const pool = await import("./pool.ts");
	assert.equal(pool.parseResetEpoch("usage limit reached|1750000000"), 1_750_000_000_000);
	assert.equal(pool.parseResetEpoch("usage limit reached|1750000000000"), 1_750_000_000_000);
	assert.equal(pool.parseResetEpoch("no epoch here"), undefined);
	assert.ok(pool.cooldownFromMessage("429 rate_limit") > Date.now());
	assert.ok(pool.LIMIT_RE.test("429 rate limit"));
	assert.ok(pool.AUTH_RE.test("authentication_error"));
	assert.ok(!pool.AUTH_RE.test("429 usage limit reached"));
});

await check("markRateLimited cools the account and repins the next one", async () => {
	const pool = await import("./pool.ts");
	seed([acct("a"), acct("b")]);
	await store.mutateStore((s) => {
		s.active = "a";
	});
	const next = await pool.markRateLimited("a", Date.now() + 600_000);
	assert.equal(next, "b");
	assert.equal(store.readStore().active, "b");
	assert.ok((store.readStore().accounts[0].cooldownUntil ?? 0) > Date.now());
});

// 7. Target resolution used by both the slash command and the CLI.
await check("resolveAccount takes index, exact label and unique substring", () => {
	const accounts = [acct("datecs:home"), acct("datecs:work")] as never;
	assert.equal(format.resolveAccount(accounts, "1")?.label, "datecs:home");
	assert.equal(format.resolveAccount(accounts, "datecs:work")?.label, "datecs:work");
	assert.equal(format.resolveAccount(accounts, "HOME")?.label, "datecs:home");
	assert.equal(format.resolveAccount(accounts, "datecs"), undefined); // ambiguous
	assert.equal(format.resolveAccount(accounts, "9"), undefined);
});

await check("accountLine shows state and quota", () => {
	const line = format.accountLine(
		acct("x", { cooldownUntil: Date.now() + 600_000, refreshExpires: Date.parse("2026-11-04") }),
		0,
		{ at: Date.now(), five_hour: { pct: 34 }, seven_day: { pct: 71 }, scoped: [{ name: "Fable", pct: 12 }] },
		true,
	);
	assert.match(line, /▸ 1\. x/);
	assert.match(line, /5h 34%/);
	assert.match(line, /7d 71%/);
	assert.match(line, /Fable 12%/);
	assert.match(line, /cooling/);
	assert.match(line, /login exp 2026-11-04/);
});

// 8. The store must never be written world-readable (it holds refresh tokens).
await check("store file is written 0600", () => {
	seed([acct("a")]);
	store.writeJsonAtomic(store.POOL_PATH, { enabled: true, accounts: [acct("a")] });
	assert.ok(readFileSync(store.POOL_PATH, "utf-8").includes("rt-a-1"));
	if (process.platform !== "win32") {
		const { statSync } = require("node:fs") as typeof import("node:fs");
		assert.equal(statSync(store.POOL_PATH).mode & 0o777, 0o600);
	}
});

console.log(results.join("\n"));
rmSync(dir, { recursive: true, force: true });
console.log(process.exitCode ? "\nFAILED" : `\nall ${results.length} checks passed`);
