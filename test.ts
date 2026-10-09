/**
 * Self-check: the failure modes that killed pooled logins, plus the new
 * quota/backoff logic. Plain asserts, no framework.
 *
 *   node test.ts
 */

import assert from "node:assert/strict";
import fs, {
	mkdtempSync,
	rmSync,
	writeFileSync,
	readFileSync,
	existsSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "cpool-test-"));
process.env.PI_CODING_AGENT_DIR = dir;

const store = await import("./store.ts");
const { parseUsage, refreshGrant } = await import("./oauth.ts");
const authLog = await import("./auth-log.ts");
const usage = await import("./usage.ts");
const format = await import("./format.ts");
const warm = await import("./warm.ts");
const sync = await import("./sync.ts");

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

await check("atomic writes retry transient rename failures", () => {
	const path = join(dir, "retry.json");
	const renameSync = fs.renameSync;
	let attempts = 0;
	fs.renameSync = ((from, to) => {
		if (++attempts < 3) {
			const error = new Error("busy") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		}
		renameSync(from, to);
	}) as typeof fs.renameSync;
	syncBuiltinESMExports();
	try {
		store.writeJsonAtomic(path, { ok: true });
	} finally {
		fs.renameSync = renameSync;
		syncBuiltinESMExports();
	}
	assert.equal(attempts, 3);
	assert.equal(readFileSync(path, "utf8"), '{\n  "ok": true\n}');
});

// 2. A crash between the token POST and the store write must not lose the
//    rotated refresh token (retrying with the spent one is fatal, permanently).
await check(
	"stashed successor is adopted when the store write was lost",
	() => {
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
	},
);

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
			() =>
				store.withDirLock(lock, () => undefined, {
					timeoutMs: 150,
					staleMs: 60_000,
				}),
			/lock busy/,
		);
		// same lock, but now considered stale → taken over instead of failing
		await store.withDirLock(lock, () => undefined, {
			timeoutMs: 500,
			staleMs: 0,
		});
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

// A usable favorite beats any non-favorite pin; once it cools, fallback resumes.
// Weekend account: office-hours reserve, drained in free time down to a floor
// sized for the office hours left before its 7d reset at peak burn (2 days).
// Dates are local: 2026-10-06 is a Tuesday.
// The upcoming night (00:00-08:00 local) is time nobody spends quota in.
await check("ranking subtracts the upcoming night from the week", async () => {
	const { upcomingNightMs } = await import("./usage.ts");
	const at = (day: number, h: number) => new Date(2026, 9, day, h).getTime();
	const H = 3_600_000;
	// 20:00 with 12h left (reset 08:00): really 4h
	assert.equal(upcomingNightMs(at(6, 20), at(7, 8)) / H, 8);
	// 02:00 now: the rest of this night counts
	assert.equal(upcomingNightMs(at(7, 2), at(7, 10)) / H, 6);
	// reset before the night starts: nothing to subtract
	assert.equal(upcomingNightMs(at(6, 10), at(6, 22)), 0);
	// only one night, even across several
	assert.equal(upcomingNightMs(at(6, 10), at(9, 10)) / H, 8);
	// 20:00: rosi (40% free, reset 08:00 = 12h, really 4h) vs evening (5% free,
	// reset 23:00 = 3h). By raw clock evening goes first; minus the night the
	// deadlines are close and rosi's unspent quota wins.
	const now = at(6, 20);
	const iso = (ms: number) => new Date(ms).toISOString();
	const e = (reset: number, pct7: number) => ({
		five_hour: { pct: 50, resets_at: iso(now + 4 * H) },
		seven_day: { pct: pct7, resets_at: iso(reset) },
	});
	assert.deepEqual(
		format
			.sortAccountsForDisplay(
				[acct("evening"), acct("rosi")] as never,
				{ evening: e(at(6, 23), 95), rosi: e(at(7, 8), 60) } as never,
				now,
			)
			.map((a) => a.label),
		["rosi", "evening"],
	);
	// Real pool, Sun 23:36: rgateva 86% used, 13h24m left (5h24m after the night)
	// must beat home 60% used, 30h24m left: under 12h the deadline pulls harder.
	const sun = at(4, 23) + 36 * 60_000;
	const row = (pct7: number, left7: number, left5: number) => ({
		five_hour: { pct: 0, resets_at: iso(sun + left5) },
		seven_day: { pct: pct7, resets_at: iso(sun + left7) },
	});
	assert.deepEqual(
		format
			.sortAccountsForDisplay(
				[acct("home"), acct("rgateva")] as never,
				{
					home: row(60, 30.4 * H, 1.9 * H),
					rgateva: row(86, 13.4 * H, 1.23 * H),
				} as never,
				sun,
			)
			.map((a) => a.label),
		["rgateva", "home"],
	);
	// Real pool, Mon 22:24: home 91% used, 7h38m left (~1h36m after the night)
	// must top everything, even dobrin's 5h window expiring in 18 minutes.
	const mon = at(5, 22) + 24 * 60_000;
	const live = (pct7: number, left7: number, left5?: number) => ({
		five_hour: { pct: 0, resets_at: left5 === undefined ? undefined : iso(mon + left5) },
		seven_day: { pct: pct7, resets_at: iso(mon + left7) },
	});
	assert.deepEqual(
		format
			.sortAccountsForDisplay(
				[acct("dobrin"), acct("flex2"), acct("datecs"), acct("home")] as never,
				{
					dobrin: live(70, 41 * H, 0.3 * H),
					flex2: live(77, 34.6 * H, 1.63 * H),
					datecs: live(81, 27.6 * H, 2.8 * H),
					home: live(91, 7.63 * H),
				} as never,
				mon,
			)
			.map((a) => a.label)[0],
		"home",
	);
});

await check("weekend account drains only outside office hours, above its floor", () => {
	const at = (day: number, h: number) => new Date(2026, 9, day, h).getTime();
	const entry = (pct7: number, reset7: number, reset5?: number) =>
		({
			seven_day: { pct: pct7, resets_at: new Date(reset7).toISOString() },
			five_hour: { pct: 0, resets_at: reset5 && new Date(reset5).toISOString() },
		}) as never;
	const w = (e: never, now: number) => format.weekendState(e, now);
	assert.equal(format.officeMs(at(6, 18), at(7, 12)) / 3_600_000, 3);
	assert.equal(w(entry(10, at(8, 12)), at(6, 12)).state, "reserve", "Tue noon");
	// Tue 18:00, 50% left, reset Wed 12:00 -> floor 3h/18h = 17%: drain
	const tue = w(entry(50, at(7, 12)), at(6, 18));
	assert.equal(tue.state, "drain");
	assert.equal(Math.round(tue.floor ?? -1), 17);
	// same but reset Wed 22:00 -> 9h = 50% floor, 50% left: locked
	assert.equal(w(entry(50, at(7, 22)), at(6, 18)).state, "locked");
	// Wed 18:00, reset 22:00 -> floor 0, drain every bit
	assert.equal(w(entry(95, at(7, 22)), at(7, 18)).floor, 0);
	assert.equal(w(entry(95, at(7, 22)), at(7, 18)).state, "drain");
	// just reset: a fresh week holds itself
	assert.equal(w(entry(0, at(14, 22)), at(7, 22)).state, "locked");
	// stale cache past its reset must not drain the fresh week
	assert.equal(w(entry(30, at(7, 20)), at(7, 21)).state, "locked");
	// Fri 18:00 -> Sun 15:00 reset: drain all weekend
	assert.equal(w(entry(40, at(11, 15)), at(9, 18)).state, "drain");
	// 5h guard: Mon 05:00, no window open -> it would run past 09:00
	assert.equal(w(entry(40, at(13, 10)), at(12, 5)).state, "locked");
	// ...but an open window that resets by 09:00 may keep going
	assert.equal(w(entry(40, at(13, 10), at(12, 8)), at(12, 5)).state, "drain");
});

await check("a held weekend account gives up an automatic pin", async () => {
	const pool = await import("./pool.ts");
	// No usage data = locked (or office hours = reserve): either way held.
	seed([acct("wk", { weekend: true }), acct("a")]);
	await store.mutateStore((s) => {
		s.active = "wk";
		s.manualPin = false;
	});
	assert.equal(pool.pickActive(store.readStore()), "a");
	await store.mutateStore((s) => {
		s.manualPin = true;
	});
	assert.equal(pool.pickActive(store.readStore()), "wk", "a manual switch is the exception");
	pool.invalidateSnapshot();
});

await check("a favorite overrides a non-favorite pin", async () => {
	const pool = await import("./pool.ts");
	seed([acct("a"), acct("fav", { favorite: true })]);
	await store.mutateStore((s) => {
		s.active = "a";
	});
	assert.equal(pool.pickActive(store.readStore()), "fav");
	seed([acct("a"), acct("fav", { favorite: true, cooldownUntil: Date.now() + 600_000 })]);
	await store.mutateStore((s) => {
		s.active = "a";
	});
	assert.equal(pool.pickActive(store.readStore()), "a");
	pool.invalidateSnapshot();
});

// A dead pin turns off stickiness: pickActive re-scores the cache on every
// call, so the account in use drifts every time the numbers move. pickNext
// must write its choice down. One usable candidate = no refresh, no network.
await check("pickNext re-pins when the pinned account is dead", async () => {
	const pool = await import("./pool.ts");
	seed([acct("gone", { dead: true }), acct("live")]);
	await store.mutateStore((s) => {
		s.active = "gone";
	});
	assert.equal(await pool.pickNext(), "live");
	assert.equal(store.readStore().active, "live", "the pick must be persisted");
	pool.invalidateSnapshot();
});

// Automatic selection: on by default, re-picks on its own cadence, and yields
// to a manual pin — but only while that pinned account can still serve. Pin
// "until it's full", not forever, or one manual switch freezes the pool.
await check(
	"autoSwitchDue honours the setting, cadence and manual pin",
	async () => {
		const pool = await import("./pool.ts");
		const now = Date.now();
		const base = { accounts: [acct("a"), acct("b")], active: "a" };
		const due = (over: Record<string, unknown>) =>
			pool.autoSwitchDue({ ...base, ...over } as never, now);

		assert.equal(due({}), true, "default is on, and never-run is due");
		assert.equal(due({ autoSwitch: false }), false, "explicitly off");
		assert.equal(due({ autoSwitchAt: now - 60_000 }), false, "ran a minute ago");
		assert.equal(due({ autoSwitchAt: now - pool.AUTO_SWITCH_MS }), true);
		assert.equal(due({ manualPin: true }), false, "manual pin still usable");
		assert.equal(
			pool.autoSwitchDue(
				{
					accounts: [acct("a", { cooldownUntil: now + 600_000 }), acct("b")],
					active: "a",
					manualPin: true,
				} as never,
				now,
			),
			true,
			"a pinned account that ran out hands control back",
		);
	},
);

// One ranking for the list and the switch: "best" is the top usable row the
// user is looking at, never a second opinion only the code knows.
await check(
	"bestLabel is the top usable row of the displayed list",
	async () => {
		const pool = await import("./pool.ts");
		const now = Date.now();
		const at = now;
		seed([
			acct("pinned-busy"),
			acct("disabled-idle", { disabled: true }),
			acct("best"),
		]);
		await store.mutateStore((s) => {
			s.active = "pinned-busy";
		});
		store.writeJsonAtomic(store.USAGE_PATH, {
			"pinned-busy": {
				at,
				five_hour: { pct: 70, resets_at: new Date(now + 3_600_000).toISOString() },
				seven_day: {
					pct: 20,
					resets_at: new Date(now + 6 * 86_400_000).toISOString(),
				},
			},
			"disabled-idle": {
				at,
				five_hour: { pct: 0, resets_at: new Date(now + 3_600_000).toISOString() },
				seven_day: { pct: 0, resets_at: new Date(now + 86_400_000).toISOString() },
			},
			best: {
				at,
				five_hour: { pct: 10, resets_at: new Date(now + 3_600_000).toISOString() },
				seven_day: {
					pct: 20,
					resets_at: new Date(now + 2 * 86_400_000).toISOString(),
				},
			},
		});
		assert.equal(pool.bestLabel(store.readStore(), now), "best");
		rmSync(store.USAGE_PATH, { force: true });
		pool.invalidateSnapshot();
	},
);

// pi's auth.json is written once by /login and never rotated, so it goes stale
// as soon as the pool refreshes that lineage. Adopting it at session start
// minted `account-<now>` — a ghost that came back under a new name each time it
// was deleted — or worse, overwrote a live refresh token with a spent one.
await check(
	"session-start attach mints no ghost from stale creds",
	async () => {
		const commands = await import("./commands.ts");
		seed([acct("real")]);
		writeFileSync(
			join(dir, "auth.json"),
			JSON.stringify({
				anthropic: {
					refresh: "rt-superseded",
					access: "at-superseded",
					expires: Date.now() + 3_600_000,
				},
			}),
		);
		// Unknown lineage and unidentifiable (the profile call fails on the stale
		// access token): attach nothing rather than invent an account.
		assert.equal(await commands.attachCurrentLogin(), undefined);
		assert.deepEqual(
			store.readStore().accounts.map((a) => a.label),
			["real"],
			"no ghost account may be created",
		);
		rmSync(join(dir, "auth.json"), { force: true });
	},
);

await check(
	"pickActive skips dead/disabled/cooling and prefers most quota",
	async () => {
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
		seed([
			acct("dead", { dead: true }),
			acct("cool", { cooldownUntil: Date.now() + 600_000 }),
		]);
		assert.equal(pool.pickActive(store.readStore()), "cool");
		rmSync(store.USAGE_PATH, { force: true });
	},
);

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
		extra_usage: {
			is_enabled: true,
			used_credits: 250,
			monthly_limit: 5000,
			utilization: 5,
		},
	});
	assert.equal(parsed.five_hour?.pct, 34);
	assert.equal(parsed.five_hour?.resets_at, "2026-01-01T00:00:00Z");
	assert.equal(parsed.seven_day?.pct, 71);
	assert.deepEqual(parsed.scoped, [
		{ name: "Fable", pct: 12, resets_at: undefined },
	]);
	assert.equal(parsed.spend?.used, 2.5);
	assert.equal(parsed.spend?.limit, 50);
	assert.deepEqual(parseUsage({}).five_hour, undefined);
});

await check(
	"usage cache serves within TTL and backs off after a failure",
	async () => {
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
			a: {
				at: Date.now(),
				five_hour: { pct: 42 },
				nextPollAt: 0,
				intervalMs: 180_000,
			},
		});
		await usage.collectUsage(["a"], token);
		assert.equal(usage.readUsage().a.five_hour?.pct, 42);
		assert.equal(
			usage.readUsage().a.intervalMs,
			360_000,
			"interval doubles on failure",
		);
	},
);

await check("switchScore prefers quota that is about to expire", () => {
	const now = Date.now();
	const iso = (ms: number) => new Date(now + ms).toISOString();
	const score = (e: unknown) => usage.switchScore(e as never, now);

	// Half a 5h window unspent with 15 minutes to go: use it or lose it.
	const expiring = score({
		five_hour: { pct: 50, resets_at: iso(15 * 60_000) },
	});
	assert.ok(expiring > 0.5, `expiring 5h should score high, got ${expiring}`);

	// 70% of the week spent with 3 days left = behind budget, hold it back.
	const behind = score({
		seven_day: { pct: 70, resets_at: iso(3 * 24 * 3_600_000) },
	});
	assert.ok(
		behind < 0,
		`week behind budget should score negative, got ${behind}`,
	);

	// Weekly nearly over with quota unspent: spend it before it evaporates.
	const weekEnding = score({
		seven_day: { pct: 40, resets_at: iso(2 * 3_600_000) },
	});
	assert.ok(weekEnding > 0.5, `week about to reset should score high`);
	assert.ok(weekEnding > behind, "unspent-and-expiring beats behind-budget");

	// Unknown accounts are neutral, not best and not worst.
	assert.equal(score(undefined), 0);
	assert.ok(score(undefined) > behind && expiring > score(undefined));
});

await check("fullUntil parks an account that reads full", () => {
	const now = Date.now();
	const resets = new Date(now + 90 * 60_000).toISOString();
	assert.equal(
		usage.fullUntil({ five_hour: { pct: 100, resets_at: resets } }, now),
		Date.parse(resets),
	);
	// Full but silent about the reset: park for an hour, never retry instantly.
	assert.equal(
		usage.fullUntil({ seven_day: { pct: 99 } }, now),
		now + 3_600_000,
	);
	assert.equal(usage.fullUntil({ five_hour: { pct: 80 } }, now), undefined);
	assert.equal(usage.fullUntil(undefined, now), undefined);
});

// 6. Cap-message parsing: a wrong reset epoch either wastes an account or
//    retries into a wall.
await check("cooldown parses Claude's reset epoch (s and ms)", async () => {
	const pool = await import("./pool.ts");
	assert.equal(
		pool.parseResetEpoch("usage limit reached|1750000000"),
		1_750_000_000_000,
	);
	assert.equal(
		pool.parseResetEpoch("usage limit reached|1750000000000"),
		1_750_000_000_000,
	);
	assert.equal(pool.parseResetEpoch("no epoch here"), undefined);
	assert.ok(pool.cooldownFromMessage("429 rate_limit") > Date.now());
	assert.ok(pool.LIMIT_RE.test("429 rate limit"));
	assert.ok(pool.AUTH_RE.test("authentication_error"));
	assert.ok(!pool.AUTH_RE.test("429 usage limit reached"));
});

await check(
	"markRateLimited cools the account and repins the next one",
	async () => {
		const pool = await import("./pool.ts");
		seed([acct("a"), acct("b")]);
		await store.mutateStore((s) => {
			s.active = "a";
		});
		const next = await pool.markRateLimited("a", Date.now() + 600_000);
		assert.equal(next, "b");
		assert.equal(store.readStore().active, "b");
		assert.ok((store.readStore().accounts[0].cooldownUntil ?? 0) > Date.now());
	},
);

// 7. Display numbers are rankings, not stable IDs: commands accept only an
//    exact label or a unique substring.
await check("resolveAccount rejects numbers; takes label or substring", () => {
	const accounts = [acct("datecs:home"), acct("datecs:work")] as never;
	assert.equal(format.resolveAccount(accounts, "1"), undefined);
	assert.equal(
		format.resolveAccount(accounts, "datecs:work")?.label,
		"datecs:work",
	);
	assert.equal(format.resolveAccount(accounts, "HOME")?.label, "datecs:home");
	assert.equal(format.resolveAccount(accounts, "datecs"), undefined); // ambiguous
	assert.equal(format.resolveAccount(accounts, "9"), undefined);
});

await check("display sorts ready accounts first, then useful 5h resets", () => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	const in_ = (ms: number) => new Date(now + ms).toISOString();
	const HOUR = 3_600_000;
	const DAY = 24 * HOUR;
	const accounts = [
		acct("dead", { dead: true }),
		acct("full-late", { cooldownUntil: now + 3 * HOUR }),
		acct("ready-high"),
		acct("weekly-nearly-full", { cooldownUntil: now + HOUR }),
		acct("ready-early7"),
		acct("full-soon", { cooldownUntil: now + HOUR }),
		acct("ready-late7"),
		acct("unknown"),
	] as never;
	const cache = {
		"full-late": {
			five_hour: { pct: 100, resets_at: in_(3 * HOUR) },
			seven_day: { pct: 40, resets_at: in_(2 * DAY) },
		},
		"ready-high": {
			five_hour: { pct: 30, resets_at: in_(3 * HOUR) },
			seven_day: { pct: 20, resets_at: in_(2 * DAY) },
		},
		"weekly-nearly-full": {
			five_hour: { pct: 100, resets_at: in_(HOUR) },
			seven_day: { pct: 95, resets_at: in_(DAY) },
		},
		"ready-early7": {
			five_hour: { pct: 10, resets_at: in_(3 * HOUR) },
			seven_day: { pct: 20, resets_at: in_(DAY) },
		},
		"full-soon": {
			five_hour: { pct: 100, resets_at: in_(HOUR) },
			seven_day: { pct: 40, resets_at: in_(2 * DAY) },
		},
		"ready-late7": {
			five_hour: { pct: 10, resets_at: in_(3 * HOUR) },
			seven_day: { pct: 20, resets_at: in_(3 * DAY) },
		},
	} as never;
	assert.deepEqual(
		format.sortAccountsForDisplay(accounts, cache, now).map((a) => a.label),
		[
			// Usable rows go by soonest 7d reset (1d, 2d, 3d); 5h usage only breaks
			// ties, so ready-high (30% of 5h) outranks ready-late7 (10%).
			"ready-early7",
			"ready-high",
			"ready-late7",
			"full-soon",
			"full-late",
			"unknown",
			"weekly-nearly-full",
			"dead",
		],
	);
});

// 7b. One email, several subscriptions: a personal Pro org and a team seat
//     share an email but bill and rate-limit separately. Matching on email
//     merged them into one entry and silently dropped a login.
// An expiring 5h window is free capacity: drain it and a fresh one opens. So
// among accounts close on the week, the soonest 5h reset goes first — but the
// nudge is capped at two days, so plenty of weekly slack still outranks it.
await check(
	"an expiring 5h window breaks a close 7d race, but can't win one",
	() => {
		const now = Date.parse("2026-01-01T00:00:00Z");
		const in_ = (ms: number) => new Date(now + ms).toISOString();
		const HOUR = 3_600_000;
		const DAY = 24 * HOUR;
		const accounts = [
			acct("wk2d-5h4h"),
			acct("wk3d-5h1h"),
			acct("wk4d-5h15m"),
			acct("wk3d-5h10m-spent"),
		] as never;
		const seven = (d: number) => ({ pct: 20, resets_at: in_(d * DAY) });
		const cache = {
			// Soonest on the week, but 4h of its 5h window still ahead of it.
			"wk2d-5h4h": {
				five_hour: { pct: 20, resets_at: in_(4 * HOUR) },
				seven_day: seven(2),
			},
			// A day further out, 5h nearly over: drain it now, then fall back to the
			// account above.
			"wk3d-5h1h": {
				five_hour: { pct: 20, resets_at: in_(HOUR) },
				seven_day: seven(3),
			},
			// Two extra days of weekly slack: a 15-minute 5h window can't lift it.
			"wk4d-5h15m": {
				five_hour: { pct: 20, resets_at: in_(HOUR / 4) },
				seven_day: seven(4),
			},
			// 5h about to reset, but spent: nothing to drain, so no nudge.
			"wk3d-5h10m-spent": {
				five_hour: { pct: 95, resets_at: in_(HOUR / 6) },
				seven_day: seven(3),
			},
		} as never;
		assert.deepEqual(
			format.sortAccountsForDisplay(accounts, cache, now).map((a) => a.label),
			["wk3d-5h1h", "wk2d-5h4h", "wk4d-5h15m", "wk3d-5h10m-spent"],
		);
	},
);

// A real pool, ordered the way its owner wants it. Time to the weekly reset is
// the spine; unused quota reorders accounts within a day or two of each other
// (dobrin at 23% used beats flex2/datecs despite resetting LATER than both);
// an account six days out stays last however idle it is, because six days is
// plenty of runway to spend it later.
await check("weekly deadline leads, unused quota reorders near ties", () => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	const HOUR = 3_600_000;
	const DAY = 24 * HOUR;
	const MIN = 60_000;
	const at = (ms: number) => new Date(now + ms).toISOString();
	// label, 7d left, 7d pct, 5h pct, 5h left (undefined = window not started)
	const rows: [string, number, number, number, number | undefined][] = [
		["dobrin", 3 * DAY + 20 * HOUR, 23, 83, 4 * HOUR + 12 * MIN],
		["home", 2 * DAY + 10 * HOUR, 53, 82, 4 * HOUR + 42 * MIN],
		["ddenkov", 6 * DAY + 11 * HOUR, 13, 0, undefined],
		["flex2", 3 * DAY + 13 * HOUR, 65, 28, 3 * HOUR + 42 * MIN],
		["datecs", 3 * DAY + 6 * HOUR, 79, 0, undefined],
	];
	const accounts = rows.map(([label]) => acct(label)) as never;
	const cache = Object.fromEntries(
		rows.map(([label, left7, pct7, pct5, left5]) => [
			label,
			{
				five_hour: {
					pct: pct5,
					resets_at: left5 === undefined ? undefined : at(left5),
				},
				seven_day: { pct: pct7, resets_at: at(left7) },
			},
		]),
	) as never;
	assert.deepEqual(
		format.sortAccountsForDisplay(accounts, cache, now).map((a) => a.label),
		["home", "dobrin", "flex2", "datecs", "ddenkov"],
	);
});

// The other side of the same knob. Here the deadline gap is only ~1.5 days but
// the usage gap is 34-40 points, so the idle account wins: 3d15h at 26% used
// has far more going to waste than 2d out at 60-66%. Together with the test
// above this pins WEEKLY_QUOTA_WEIGHT to a narrow band (4.32d < k < 4.50d) —
// if one of these flips, the constant moved.
await check("a much idler account outranks a nearer deadline", () => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	const HOUR = 3_600_000;
	const DAY = 24 * HOUR;
	const MIN = 60_000;
	const at = (ms: number) => new Date(now + ms).toISOString();
	// label, 7d left, 7d pct, 5h pct, 5h left (undefined = window not started)
	const rows: [string, number, number, number, number | undefined][] = [
		["home", 2 * DAY + 5 * HOUR, 60, 45, 4 * HOUR + 52 * MIN],
		["flex1", 2 * DAY + 3 * HOUR, 66, 0, undefined],
		["dobrin", 3 * DAY + 15 * HOUR, 26, 0, undefined],
		["flex2", 3 * DAY + 8 * HOUR, 74, 0, undefined],
	];
	const accounts = rows.map(([label]) => acct(label)) as never;
	const cache = Object.fromEntries(
		rows.map(([label, left7, pct7, pct5, left5]) => [
			label,
			{
				five_hour: {
					pct: pct5,
					resets_at: left5 === undefined ? undefined : at(left5),
				},
				seven_day: { pct: pct7, resets_at: at(left7) },
			},
		]),
	) as never;
	assert.deepEqual(
		format.sortAccountsForDisplay(accounts, cache, now).map((a) => a.label),
		["dobrin", "home", "flex1", "flex2"],
	);
});

// ++ is its own tier ahead, -- its own tier behind; +/- shift the rank by two
// days, so an untouched + week beats a normal one but not one about to lose
// real quota.
await check("priority: ++ first, -- last, +/- bend the rank", () => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	const DAY = 24 * 3_600_000;
	const at = (ms: number) => new Date(now + ms).toISOString();
	// label, priority, 7d left (days), 7d pct
	const rows: [string, number, number, number][] = [
		["mm", -2, 1, 0],
		["m", -1, 4, 0],
		["n", 0, 5, 0],
		["p", 1, 6, 0],
		["exp", 0, 1, 25],
		["pp", 2, 6, 50],
	];
	const accounts = rows.map(([label, priority]) =>
		acct(label, { priority }),
	) as never;
	const cache = Object.fromEntries(
		rows.map(([label, , left7, pct7]) => [
			label,
			{
				five_hour: { pct: 0 },
				seven_day: { pct: pct7, resets_at: at(left7 * DAY) },
			},
		]),
	) as never;
	assert.deepEqual(
		format.sortAccountsForDisplay(accounts, cache, now).map((a) => a.label),
		["pp", "exp", "p", "n", "m", "mm"],
	);
});

// A host that relaunches every saved session at once starts N sweeps in the
// same instant. They all read the same cache snapshot and all see the label as
// due, so without claiming the slot under the lock every one of them spends a
// request on it.
await check(
	"concurrent usage polls claim the slot, so only one fetches",
	async () => {
		rmSync(store.USAGE_PATH, { force: true });
		let polls = 0;
		const token = async () => {
			polls++;
			return undefined; // stop before the network; the claim is what's under test
		};
		await Promise.all([
			usage.collectUsage(["racer"], token, { max: 1 }),
			usage.collectUsage(["racer"], token, { max: 1 }),
			usage.collectUsage(["racer"], token, { max: 1 }),
			usage.collectUsage(["racer"], token, { max: 1 }),
			usage.collectUsage(["racer"], token, { max: 1 }),
		]);
		assert.equal(polls, 1, "only the caller that claimed the slot may poll");
		rmSync(store.USAGE_PATH, { force: true });
	},
);

await check("findByIdentity keys on (account, org), not email", async () => {
	const { findByIdentity } = await import("./commands.ts");
	const pro = {
		...acct("me (pro)"),
		uuid: "u1",
		orgUuid: "o-pro",
		email: "me@x.com",
	};
	const team = {
		...acct("me (team)"),
		uuid: "u1",
		orgUuid: "o-team",
		email: "me@x.com",
	};
	const accounts = [pro, team] as never;
	assert.equal(
		findByIdentity(accounts, { uuid: "u1", orgUuid: "o-team", email: "me@x.com" })
			?.label,
		"me (team)",
	);
	// a third subscription on the same email must NOT hijack either entry
	assert.equal(
		findByIdentity(accounts, { uuid: "u1", orgUuid: "o-max", email: "me@x.com" }),
		undefined,
	);
	// same email, different person → no match at all
	assert.equal(
		findByIdentity(accounts, { uuid: "u2", email: "me@x.com" }),
		undefined,
	);
	// legacy entry with no stored org adopts the login once, then is pinned
	const legacy = [{ ...acct("old"), uuid: "u1" }] as never;
	assert.equal(
		findByIdentity(legacy, { uuid: "u1", orgUuid: "o-pro" })?.label,
		"old",
	);
});

// Pi's tool_addition / tool_removal blocks must name the same alias as the
// declaration, including a removed tool that is no longer declared at all.
await check("tool_reference names are aliased like declarations", async () => {
	const { transformPayload } = await import("./tools.ts");
	const ref = (type: string, name: string) => ({ type, tool: { type: "tool_reference", name } });
	const out = transformPayload(
		{
			tools: [{ name: "compress", input_schema: {} }],
			messages: [
				{
					role: "system",
					content: [
						ref("tool_addition", "compress"),
						ref("tool_removal", "gone"),
						ref("tool_removal", "Read"),
						ref("tool_addition", "mcp__x__y"),
					],
				},
			],
		},
		false,
	) as { messages: { content: { tool: { name: string } }[] }[] };
	assert.deepEqual(
		out.messages[0].content.map((b) => b.tool.name),
		["mcp__pi__compress", "mcp__pi__gone", "Read", "mcp__x__y"],
	);
});

await check("accountLine shows state and quota", () => {
	const line = format.accountLine(
		acct("x", {
			cooldownUntil: Date.now() + 600_000,
			refreshExpires: Date.parse("2026-11-04"),
		}),
		0,
		{
			at: Date.now(),
			five_hour: { pct: 34 },
			seven_day: { pct: 71 },
			scoped: [{ name: "Fable", pct: 12 }],
		},
		true,
	);
	// quota columns first, ragged label last
	assert.match(line, /^▸ 1\. {4}· 5h/); // blank 2-char priority slot
	assert.match(line, /· x$/);
	// fields are padded to a fixed width, so the gaps vary
	assert.match(line, /5h\s+\[███░░░░░\]\s+34%/);
	// the bar carries its own colour now, so the escape sits before "["
	assert.match(line, /7d\s+\u001b\[33m\[██████░░\]\s+71%/);
	assert.match(line, /Fable 12%/);
	assert.match(line, /cooling/);
	assert.match(line, /\[OK\]/);
	assert.match(line, /resets \?/, "no cedar_ember block = unknown, not 0");
});

// Inventory sums resets_left over live grants; ineligible is "?", never "0".
await check("limit resets parse defensively and render by expiry", async () => {
	const { parseUsage } = await import("./oauth.ts");
	const plain = (s: string) => s.replace(/\u001b\[\d+m/g, "");
	const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
	const line = (ce: unknown) =>
		format.accountLine(acct("x"), 0, { at: Date.now(), ...parseUsage({ cedar_ember: ce }) }, false);
	const g = (over: Record<string, unknown>) => ({ resets_left: 1, ends_at: iso(10 * 86_400_000), ...over });
	assert.match(line({ eligible: false, ineligible_reason: "surface" }), /resets \?/);
	assert.match(line({ eligible: true, grants: null }), /resets 0/);
	const ok = line({
		eligible: true,
		grants: [
			g({ resets_left: 2 }),
			g({ paused: true }),
			g({ resets_left: 0 }),
			g({ starts_at: iso(86_400_000) }),
			g({ ends_at: iso(-1000) }),
			g({ resets_left: "1" }),
			"junk",
		],
	});
	assert.match(plain(ok), /resets 2 \(10d  0h\)/);
	assert.ok(!ok.includes("\u001b[31mresets"), "10 days out is not red");
	assert.ok(line({ eligible: true, grants: [g({ ends_at: iso(2 * 86_400_000) })] }).includes("\u001b[31mresets 1"));
	assert.match(format.accountLine(acct("x", { dead: true }), 0, undefined, false), /\[DEAD\]/);
});

// Columns must line up down the list whatever the clock and percent widths
// are: "45m" vs "6d 19h", "7%" vs "100%", and a window with no data at all.
await check("quota columns are fixed width", () => {
	const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
	const plain = (s: string) => s.replace(/\u001b\[\d+m/g, "");
	const rows = [
		{
			at: Date.now(),
			five_hour: { pct: 7, resets_at: iso(45 * 60_000) },
			seven_day: { pct: 100, resets_at: iso(6.8 * 86_400_000) },
		},
		{
			at: Date.now(),
			five_hour: { pct: 100, resets_at: iso(4.25 * 3_600_000) },
			seven_day: { pct: 7, resets_at: iso(12 * 3_600_000) },
		},
		{ at: Date.now() }, // no windows at all
	].map((e, i) => plain(format.accountLine(acct("x"), i, e as never, false)));
	const at7d = rows.map((r) => r.indexOf("7d"));
	const atLabel = rows.map((r) => r.indexOf("· x"));
	assert.equal(new Set(at7d).size, 1, `7d column ragged: ${at7d}`);
	assert.equal(new Set(atLabel).size, 1, `label column ragged: ${atLabel}`);

	const clockText = (ms: number): string => {
		const row = plain(
			format.accountLine(
				acct("x"),
				0,
				{
					at: Date.now(),
					five_hour: { pct: 10, resets_at: iso(ms) },
				} as never,
				false,
			),
		);
		return row.match(/5h\(([^)]*)\)/)?.[1] ?? "";
	};
	assert.equal(clockText(5 * 3_600_000), " 5h  0m");
	assert.equal(clockText(12 * 3_600_000), "12h  0m");
	assert.equal(clockText(49 * 3_600_000), " 2d  1h");
	// Anything past the hour reads as hours. "71m" beside a sibling's "4h 51m"
	// looks like a different unit and can't align in a fixed-width column.
	assert.equal(clockText(71 * 60_000), " 1h 11m");
	// Single-unit values pad on the left, so `59m` lands under the `11m` of
	// `1h 11m` instead of floating at the left edge of the column.
	assert.equal(clockText(59 * 60_000), "    59m");
	assert.equal(clockText(64 * 3_600_000), " 2d 16h");
});

// The reset clock warns on time; the bar warns on quota. A window that is
// already spent gets no clock warning — an imminent reset is good news there.
await check("the reset clock colours by urgency, unless drained", () => {
	const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
	const clock = (
		w: "five_hour" | "seven_day",
		pct: number,
		in_: number,
	): string => {
		const line = format.accountLine(
			acct("x"),
			0,
			{
				at: Date.now(),
				[w]: { pct, resets_at: iso(in_) },
			} as never,
			false,
		);
		// Back up over a colour escape that may sit in front of the label.
		const at = line.indexOf(w === "five_hour" ? "5h" : "7d");
		return line.slice(line.slice(at - 5, at) === "\u001b[31m" ? at - 5 : at);
	};
	const HOUR = 3_600_000;
	const DAY = 24 * HOUR;
	const red = "\u001b[31m(";
	const amber = "\u001b[33m(";

	// 5h: red under an hour, yellow under two, plain beyond
	assert.ok(clock("five_hour", 10, 30 * 60_000).includes(red), "30m → red");
	assert.ok(clock("five_hour", 10, 90 * 60_000).includes(amber), "90m → yellow");
	assert.ok(
		!clock("five_hour", 10, 4 * HOUR).includes("\u001b[3"),
		"4h → no clock colour",
	);
	// 7d: red under a day, yellow under two
	// 20h is never under 12h of real time (at most 8h of night comes off)
	assert.ok(clock("seven_day", 10, 20 * HOUR).includes(red), "20h → red");
	// under 12h real time with quota left: the whole "7d(clock)" is red, even
	// past the 80% that silences a drained clock
	assert.ok(
		clock("seven_day", 88, 5 * HOUR).startsWith("\u001b[31m7d("),
		"urgent 88% → red label",
	);
	assert.ok(clock("seven_day", 10, 36 * HOUR).includes(amber), "36h → yellow");
	assert.ok(
		!clock("seven_day", 10, 5 * DAY).includes("\u001b[3"),
		"5d → no clock colour",
	);
	// drained (>=80%) → the clock stays plain however close the reset is
	assert.ok(
		!clock("five_hour", 80, 5 * 60_000).startsWith("5h\u001b[3"),
		"drained 5h → plain clock",
	);
	assert.ok(
		!clock("seven_day", 100, 60 * 60_000).includes("\u001b[31m7d"),
		"drained 7d → plain clock",
	);
});

// 7b. The public quota() accessor other extensions call.
await check("quota exposes the active account's windows", async () => {
	seed([acct("a")]);
	store.writeJsonAtomic(store.USAGE_PATH, {
		a: { at: Date.now(), five_hour: { pct: 12 }, seven_day: { pct: 34 } },
	});
	const { quota } = await import("./index.ts");
	assert.equal(quota()?.five_hour?.pct, 12);
	assert.equal(quota("a")?.seven_day?.pct, 34);
	assert.equal(quota("missing"), undefined);
});

// 7c. Export/import round-trip: refresh tokens are what must survive a move.
await check("parseExport accepts both shapes and rejects junk", () => {
	const accounts = [acct("a"), acct("b")];
	assert.deepEqual(
		store.parseExport(JSON.stringify({ accounts })).map((a) => a.label),
		["a", "b"],
	);
	assert.equal(
		store.parseExport(JSON.stringify(accounts))[1]?.refresh,
		"rt-b-1",
	);
	assert.throws(() => store.parseExport("not json"), /not valid JSON/);
	assert.throws(
		() => store.parseExport('{"accounts":[{"label":"x"}]}'),
		/refresh/,
	);
});

// 8. The store must never be written world-readable (it holds refresh tokens).
await check("store file is written 0600", () => {
	seed([acct("a")]);
	store.writeJsonAtomic(store.POOL_PATH, {
		enabled: true,
		accounts: [acct("a")],
	});
	assert.ok(readFileSync(store.POOL_PATH, "utf-8").includes("rt-a-1"));
	if (process.platform !== "win32") {
		const { statSync } = require("node:fs") as typeof import("node:fs");
		assert.equal(statSync(store.POOL_PATH).mode & 0o777, 0o600);
	}
});

// 9. Warming spends real quota, so it must never touch an account the user
//    held out of rotation, one that is dead/cooling, one nearly out of its
//    week, or one we have no usage read for (no data != window not started).
await check(
	"warm-up targets only unstarted windows on eligible accounts",
	async () => {
		const now = Date.now();
		const iso = (ms: number) => new Date(now + ms).toISOString();
		const week = (pct: number, leftMs: number) => ({
			pct,
			resets_at: iso(leftMs),
		});
		const cold = (pct7: number, left7: number) => ({
			at: now,
			five_hour: { pct: 0 },
			seven_day: week(pct7, left7),
		});
		seed([
			acct("cold-soon"),
			acct("cold-later"),
			acct("started"),
			acct("off", { disabled: true }),
			acct("gone", { dead: true }),
			acct("cooling", { cooldownUntil: now + 3_600_000 }),
			acct("weekspent"),
			acct("unread"),
		]);
		store.writeJsonAtomic(store.USAGE_PATH, {
			"cold-soon": cold(20, 2 * 86_400_000),
			"cold-later": cold(20, 6 * 86_400_000),
			started: {
				at: now,
				five_hour: { pct: 4, resets_at: iso(4 * 3_600_000) },
				seven_day: week(20, 2 * 86_400_000),
			},
			off: cold(10, 2 * 86_400_000),
			gone: cold(10, 2 * 86_400_000),
			cooling: cold(10, 2 * 86_400_000),
			weekspent: cold(95, 2 * 86_400_000),
			// Never fetched (no `at`): unknown, not "unstarted".
			unread: { five_hour: { pct: 0 }, seven_day: week(10, 2 * 86_400_000) },
		});
		const cache = usage.readUsage();
		const targets = () =>
			warm.warmTargets(store.readStore(), cache, now).map((a) => a.label);

		assert.deepEqual(targets(), [], "off by default");
		await store.mutateStore((s) => {
			s.warm = 2;
		});
		assert.deepEqual(targets(), ["cold-soon", "cold-later"]);
		await store.mutateStore((s) => {
			s.warm = 1;
		});
		assert.deepEqual(targets(), ["cold-soon"], "limit caps the count");
	},
);

// 10. Warm starts must be staggered: N windows opened in one sweep all expire
//     in the same minute, which is the convoy the jittered sweep exists to
//     avoid, one layer up.
await check(
	"warm-up spacing splits the 5h window across the accounts kept warm",
	async () => {
		seed([acct("a"), acct("b"), acct("c"), acct("d")]);
		const spacing = async (value: number | "all") => {
			await store.mutateStore((s) => {
				s.warm = value;
			});
			return warm.warmSpacingMs(store.readStore(), {});
		};
		assert.equal(await spacing(1), 5 * 3_600_000);
		assert.equal(await spacing(2), 2.5 * 3_600_000);
		// `all` spreads across every eligible account, not across infinity.
		assert.equal(await spacing("all"), 1.25 * 3_600_000);

		// An explicit interval wins over the 5h/N phasing, and clears back to it.
		await store.mutateStore((s) => {
			s.warmEveryMs = 30 * 60_000;
		});
		assert.equal(warm.warmSpacingMs(store.readStore(), {}), 30 * 60_000);
		await store.mutateStore((s) => {
			s.warmEveryMs = undefined;
		});
		assert.equal(warm.warmSpacingMs(store.readStore(), {}), 1.25 * 3_600_000);

		assert.equal(warm.parseEvery("30m"), 1_800_000);
		assert.equal(warm.parseEvery("2h"), 7_200_000);
		assert.equal(warm.parseEvery("45"), 2_700_000, "bare number is minutes");
		// Bad input must stay distinguishable from "not given": a NaN interval
		// makes every comparison false, which warms on every single sweep.
		assert.equal(warm.parseEvery("soon"), undefined);
		assert.equal(warm.parseEvery("0"), undefined);
	},
);

// 11b. A dead lineage keeps the expiry of its last good grant, which is often
//      LATER than what a healthy machine published. Ranking on expiry alone
//      made the revoked token win: the dead box adopted nothing and then
//      overwrote the repo with credentials nobody can refresh.
await check("sync never publishes a dead lineage", async () => {
	const pool = await import("./pool.ts");
	const theirs = (label: string, expires: number) => ({
		label,
		refresh: `rt-${label}-remote`,
		access: `at-${label}-remote`,
		expires,
		at: 1,
		by: "other",
	});
	const plan = pool.syncPlan(
		[
			{ ...acct("dead"), expires: 9_000, dead: true },
			{ ...acct("live"), expires: 9_000 },
			{ ...acct("behind"), expires: 1_000 },
			{ ...acct("unpublished"), expires: 9_000 },
			{ ...acct("dead-unpublished"), expires: 9_000, dead: true },
		] as never,
		new Map([
			["dead", theirs("dead", 1_000)],
			["live", theirs("live", 1_000)],
			["behind", theirs("behind", 9_000)],
		]),
	);
	assert.deepEqual(
		plan.publish.map((a) => a.label),
		["live", "unpublished"],
		"a dead lineage must never be published, however late its expiry",
	);
	assert.deepEqual(
		plan.adopt.map((a) => a.label),
		["dead", "behind"],
		"dead takes anything published; live takes only a later rotation",
	);
});

// 12. Credentials leave this machine when sync is on, so the blob must be
//     unreadable without the key and the file NAME must not out the account.
await check("synced credentials are sealed and anonymous on disk", () => {
	const key = sync.newKey();
	const other = sync.newKey();
	assert.equal(key.length, 64, "256-bit key, hex");

	const cred = {
		label: "flex@datecs.bg",
		refresh: "rt-secret",
		access: "at-secret",
		expires: 123,
		at: 1,
		by: "desktop",
	};
	const sealed = sync.seal(cred, key);
	assert.deepEqual(sync.open(sealed, key), cred);
	// Wrong key must fail closed, not throw: a stale key on one machine would
	// otherwise crash every refresh instead of falling back to a normal grant.
	assert.equal(sync.open(sealed, other), undefined);
	assert.equal(sync.open("not-base64-at-all", key), undefined);
	assert.ok(!sealed.includes("secret"), "ciphertext leaks the token");

	const path = sync.credPath(cred.label, key);
	assert.ok(!path.includes("datecs"), `file name leaks the account: ${path}`);
	assert.equal(path, sync.credPath(cred.label, key), "name must be stable");
	assert.notEqual(
		path,
		sync.credPath(cred.label, other),
		"name is keyed, so two pools never collide",
	);
});

// 13. The export is how a second machine gets wired up: it carries the repo and
//     the key, or the whole scheme needs a 64-char secret typed by hand.
await check(
	"an export carries the sync setup, and older exports still load",
	() => {
		const payload = JSON.stringify({
			accounts: [{ label: "a", refresh: "rt-a" }],
			sync: { url: "git@github.com:me/pool.git", key: "ab".repeat(32) },
		});
		const config = store.parseSyncConfig(payload);
		assert.equal(config?.url, "git@github.com:me/pool.git");
		assert.equal(config?.on, true, "an exported setup arrives switched on");
		assert.equal(store.parseExport(payload).length, 1, "accounts still parse");

		// Pre-sync exports, and half-written ones, must not throw on import.
		assert.equal(store.parseSyncConfig('{"accounts":[]}'), undefined);
		assert.equal(store.parseSyncConfig('{"sync":{"url":"x"}}'), undefined);
		assert.equal(store.parseSyncConfig("not json"), undefined);

		assert.equal(sync.syncOn(undefined), false);
		assert.equal(sync.syncOn({ url: "u", key: "k" }), true, "absent on = on");
		assert.equal(sync.syncOn({ url: "u", key: "k", on: false }), false);
		assert.equal(sync.syncReady({ url: "u", key: "" }), false, "key required");
	},
);

await check("auth history is bounded, merges writers and excludes secrets", async () => {
	writeFileSync(authLog.AUTH_LOG_PATH, JSON.stringify(Array.from({ length: authLog.AUTH_LOG_LIMIT }, (_, i) => ({ index: i }))));
	const account = acct("monitor", { refresh: "refresh-secret-canary", access: "access-secret-canary" });
	await Promise.all(Array.from({ length: 4 }, () => authLog.recordAuthEvent("refresh_start", account, {
		cause: "manual", error: Object.assign(new Error("message-secret-canary"), { code: "EIO" }),
		body: "body-secret-canary", access: "access-secret-canary",
	} as never)));
	const text = readFileSync(authLog.AUTH_LOG_PATH, "utf8");
	const history = JSON.parse(text);
	assert.equal(history.length, authLog.AUTH_LOG_LIMIT);
	assert.equal(history.filter((x: { event?: string }) => x.event === "refresh_start").length, 4);
	assert.equal(history[0].index, 4);
	assert.equal(history.at(-1).generation, store.fingerprint(account.refresh));
	assert.equal(history.at(-1).error, "EIO");
	assert.ok(history.at(-1).host && history.at(-1).pid && Date.parse(history.at(-1).at));
	assert.ok(!text.includes("secret-canary"), "credentials, messages and arbitrary details must not be serialized");
});

await check("refresh HTTP diagnostics preserve permanent vs transient classification", async () => {
	const fetch = globalThis.fetch;
	try {
		for (const [status, body, expected] of [
			[400, { error: "invalid_grant", error_description: "secret-canary" }, "invalid_grant"],
			[401, { error: "invalid_client" }, "invalid_client"],
			[401, { error: { type: "invalid_grant" } }, "transient"],
			[429, { error: "invalid_grant" }, "transient"],
			[503, { error: "invalid_grant" }, "transient"],
		] as const) {
			globalThis.fetch = async () => new Response(JSON.stringify(body), { status });
			const result = await refreshGrant("rt-canary");
			assert.equal(result.status, status);
			assert.equal(result.error, expected);
			assert.ok(!JSON.stringify(result).includes("secret-canary"));
		}
		globalThis.fetch = async () => { throw new Error("network-secret-canary"); };
		assert.deepEqual(await refreshGrant("rt-canary"), { error: "transient", status: undefined });
	} finally { globalThis.fetch = fetch; }
});

await check("DEAD records the rejected generation and HTTP failure without extra grants", async () => {
	rmSync(authLog.AUTH_LOG_PATH, { force: true });
	seed([acct("dead-monitor", { expires: 1, refreshExpires: Date.now() + 86_400_000 })]);
	const fetch = globalThis.fetch;
	let grants = 0;
	globalThis.fetch = async () => {
		grants++;
		return new Response(JSON.stringify({ error: "invalid_grant", error_description: "secret-canary" }), { status: 400 });
	};
	try {
		const next = await (await import("./pool.ts")).ensureFresh("dead-monitor");
		assert.equal(next?.dead, true);
		assert.equal(grants, 1);
		const text = readFileSync(authLog.AUTH_LOG_PATH, "utf8");
		const history = JSON.parse(text);
		assert.deepEqual(history.map((x: { event: string }) => x.event), ["refresh_start", "refresh_failed", "dead"]);
		assert.equal(history[1].status, 400);
		assert.equal(history[2].error, "invalid_grant");
		assert.equal(history[2].generation, store.fingerprint("rt-dead-monitor-1"));
		assert.ok(history[2].refreshExpires > Date.now());
		assert.ok(!text.includes("secret-canary") && !text.includes("rt-dead-monitor-1"));
	} finally { globalThis.fetch = fetch; }
});

await check("sync fetch failure remains visible when rescue finds only the rejected token", async () => {
	rmSync(authLog.AUTH_LOG_PATH, { force: true });
	const account = acct("sync-monitor", { expires: 1 });
	const config = { url: "unused-test-remote", key: sync.newKey() };
	writeFileSync(store.POOL_PATH, JSON.stringify({ accounts: [account], sync: config }));
	fs.mkdirSync(join(sync.SYNC_DIR, ".git"), { recursive: true });
	fs.mkdirSync(join(sync.SYNC_DIR, "accounts"), { recursive: true });
	writeFileSync(join(sync.SYNC_DIR, sync.credPath(account.label, config.key)), sync.seal(sync.credOf(account), config.key));
	const fetch = globalThis.fetch;
	const exec = childProcess.execFileSync;
	childProcess.execFileSync = ((_file: string, args: string[]) => {
		assert.ok(!args.includes("push"), "this failure path must not publish or run real git");
		if (args[0] === "fetch") throw Object.assign(new Error("stderr-secret-canary"), { status: 128 });
		return "";
	}) as typeof exec;
	syncBuiltinESMExports();
	globalThis.fetch = async () => new Response('{"error":"invalid_grant"}', { status: 400 });
	try {
		const next = await (await import("./pool.ts")).ensureFresh(account.label);
		assert.equal(next?.dead, true);
		const text = readFileSync(authLog.AUTH_LOG_PATH, "utf8");
		const history = JSON.parse(text);
		assert.ok(history.some((x: { event: string; error?: number }) => x.event === "sync_fetch_failed" && x.error === 128));
		assert.equal(history.filter((x: { result?: string }) => x.result === "same_generation").length, 2);
		assert.equal(history.at(-1).event, "dead");
		assert.ok(!text.includes("secret-canary") && !text.includes(config.key));
	} finally {
		globalThis.fetch = fetch;
		childProcess.execFileSync = exec;
		syncBuiltinESMExports();
		rmSync(sync.SYNC_DIR, { recursive: true, force: true });
	}
});

await check("auth history identifies successful rotations and sync rescue without extra POSTs", async () => {
	const fetch = globalThis.fetch;
	const exec = childProcess.execFileSync;
	try {
		rmSync(authLog.AUTH_LOG_PATH, { force: true });
		seed([acct("ok-monitor", { expires: 1 })]);
		globalThis.fetch = async () => new Response(JSON.stringify({ access_token: "access-canary", refresh_token: "refresh-canary", expires_in: 3600 }));
		await (await import("./pool.ts")).ensureFresh("ok-monitor", { force: true, cause: "manual" });
		let history = JSON.parse(readFileSync(authLog.AUTH_LOG_PATH, "utf8"));
		assert.equal(history[0].cause, "manual");
		assert.equal(history.at(-1).event, "refresh_ok");
		assert.equal(history.at(-1).status, 200);
		assert.equal(history.at(-1).fromGeneration, store.fingerprint("rt-ok-monitor-1"));
		assert.equal(history.at(-1).generation, store.fingerprint("refresh-canary"));
		assert.ok(!JSON.stringify(history).includes("canary"));

		childProcess.execFileSync = (() => "") as typeof exec; // No live git, including pushes.
		syncBuiltinESMExports();
		fs.mkdirSync(join(sync.SYNC_DIR, ".git"), { recursive: true });
		fs.mkdirSync(join(sync.SYNC_DIR, "accounts"), { recursive: true });
		for (const readyBeforePost of [true, false]) {
			rmSync(authLog.AUTH_LOG_PATH, { force: true });
			const account = acct("rescue-monitor", { expires: 1 });
			const config = { url: "unused-test-remote", key: sync.newKey() };
			writeFileSync(store.POOL_PATH, JSON.stringify({ accounts: [account], sync: config }));
			const file = join(sync.SYNC_DIR, sync.credPath(account.label, config.key));
			const remote = { ...sync.credOf(account), refresh: "remote-refresh-canary", access: "remote-access-canary", expires: Date.now() + 3_600_000, by: "other-host" };
			writeFileSync(file, sync.seal(readyBeforePost ? remote : sync.credOf(account), config.key));
			let posts = 0;
			globalThis.fetch = async () => {
				posts++;
				writeFileSync(file, sync.seal(remote, config.key));
				return new Response('{"error":"invalid_grant"}', { status: 400 });
			};
			const next = await (await import("./pool.ts")).ensureFresh(account.label);
			assert.equal(next?.dead, false);
			assert.equal(posts, readyBeforePost ? 0 : 1);
			history = JSON.parse(readFileSync(authLog.AUTH_LOG_PATH, "utf8"));
			assert.equal(history.at(-1).event, "sync_adopt");
			assert.equal(history.at(-1).by, "other-host");
			assert.equal(history.at(-1).generation, store.fingerprint(remote.refresh));
			assert.ok(!history.some((x: { event: string }) => x.event === "dead"));
			assert.ok(!JSON.stringify(history).includes("canary"));
		}
	} finally {
		globalThis.fetch = fetch;
		childProcess.execFileSync = exec;
		syncBuiltinESMExports();
		rmSync(sync.SYNC_DIR, { recursive: true, force: true });
	}
});

await check("auth log write failure cannot lose a successfully refreshed credential", async () => {
	seed([acct("write-monitor", { expires: 1 })]);
	const fetch = globalThis.fetch;
	const write = fs.writeFileSync;
	fs.writeFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
		if (String(path).startsWith(authLog.AUTH_LOG_PATH)) throw Object.assign(new Error("disk-secret-canary"), { code: "EIO" });
		return (write as (...args: unknown[]) => void)(path, ...args);
	}) as typeof write;
	syncBuiltinESMExports();
	globalThis.fetch = async () => new Response(JSON.stringify({ access_token: "new-access-canary", refresh_token: "new-refresh-canary", expires_in: 3600 }));
	try {
		const next = await (await import("./pool.ts")).ensureFresh("write-monitor");
		assert.equal(next?.refresh, "new-refresh-canary");
		assert.equal(next?.dead, false);
		assert.equal(store.readStore().accounts[0].refresh, "new-refresh-canary");
		assert.equal(existsSync(`${authLog.AUTH_LOG_PATH}.lock`), false);
	} finally {
		globalThis.fetch = fetch;
		fs.writeFileSync = write;
		syncBuiltinESMExports();
	}
});

console.log(results.join("\n"));
rmSync(dir, { recursive: true, force: true });
console.log(
	process.exitCode ? "\nFAILED" : `\nall ${results.length} checks passed`,
);
