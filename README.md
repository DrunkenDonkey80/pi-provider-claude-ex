# pi-provider-claude-plus

Claude (Anthropic **OAuth / subscription**) layer for [pi-coding-agent](https://pi.dev).

Fork of [`@zgltyq/pi-provider-claude`](https://github.com/ZGltYQ/pi-provider-claude) (MIT,
itself a fork of `@benvargas/pi-claude-code-use`). The tool-compatibility half is
kept as-is; the account pool is rewritten around the token-liveness model used by
[claude-swap](https://github.com/realiti4/claude-swap), and quota status + account
switching are new.

## What it does

1. **Keeps every extension tool usable** on the subscription path — unknown flat
   tool names are renamed on the wire to `mcp__pi__<name>` (not dropped) and
   renamed back before Pi executes them.
2. **Multi-account pool that stops expiring** (see below).
3. **Quota status + switching** — 5-hour, 7-day and per-model weekly windows,
   from `/claude-pool` in pi or `cpool` in a terminal.

## Why upstream's pooled logins kept dying

Anthropic **rotates** refresh tokens: every successful grant returns a new
`refresh_token` and invalidates the one you POSTed. Upstream kept the pool in
process memory and rewrote the whole file with `writeFileSync`, with a 4-minute
refresh sweep per session. So:

| upstream | this fork |
|---|---|
| no locking; whole-file write from a process-local snapshot | directory (mkdir) lock + read-modify-write on every mutation |
| refresh token POSTed from a stale snapshot | consume-gate re-read **inside** a per-lineage lock; a generation that someone else already rotated is never POSTed |
| rotated token lived only in memory until the write; failures swallowed | successor **stash** written before the store write and adopted on next read, so a crash can't lose a lineage |
| any `401`/`authentication_error` in the error *text* → account marked invalid | permanent only on a parsed top-level `invalid_grant` (RFC 6749 §5.2); transient failures get a short quarantine and a strike |
| eager 4-min sweep of every account, every session | lazy: a grant only within 10 min of expiry, plus one deliberate keep-alive grant per lineage idle >20 days |
| cooldown/active account in memory, lost on restart | persisted (`active`, `cooldownUntil`, `disabled`, `dead`) |
| — | best-effort cooperation with Claude Code's own `~/.claude/.oauth_refresh.lock` |
| — | optional single-writer `cpool daemon` so N sessions don't sweep in parallel |

Net effect: far fewer grants, and no two writers ever spending the same
generation — which is what actually keeps a login alive.

## Commands (in pi)

```
/claude-pool                 list accounts with quota → pick one to switch to
/claude-pool-add <label>     snapshot the current /login anthropic account
/claude-pool-remove <label>
/claude-pool-disable <label>     hold out of / return to rotation (toggle)
/claude-pool-export          write the logins to a portable file + clipboard
/claude-pool-import [path|json]  load them on another machine
/claude-pool-auto            toggle automatic account selection (on by default)
/claude-pool-warm [off|1|2|all]   keep unstarted 5h windows running (off)
```

### Which account gets picked

**Automatic selection is on by default.** Every 20 minutes the background sweep
re-reads every candidate's usage and moves to whatever sits at the top of the
list. Two rules keep it from fighting you:

* **A manual switch wins — until that account runs out.** Picking an account in
  `/claude-pool` (or `cpool switch <label>`) pins it and the sweep leaves it
  alone. The moment it goes full or starts cooling, automatic selection resumes.
* **An exhausted account always jumps to the best one**, whether automatic
  selection is on or off. Being out of quota is not a preference to respect.

Toggle it with `/claude-pool-auto` or `cpool auto [on|off]`. Off means the pool
only switches when the account in use runs out.

"Best" is defined once: the **top usable row of the list you see**, so the list
and the switch can never disagree. When nothing is usable, the score below picks
the stand-in:

```text
slack_w = (1 - pct/100) - time_until_reset / window_length
score   = slack_7d  +  2 * max(0, slack_5h)  +  0.5 * (1 - pct_5h/100)
```

Three terms, because "should I use this account" is three questions:

* `slack_7d` — **strategic**: is this week's quota going to waste? Positive slack
  means use-it-or-lose-it, negative means ahead of budget, save it. "70% of the
  week gone with 3 days left" scores negative and gets held back.
* `max(0, slack_5h)` — **opportunistic**: a 5h window about to reset with quota
  still on it. A bonus only. Being out of 5h quota is temporary (the pool
  benches such an account separately), so it must never subtract: signed, it
  buried an account sitting on 87% of its week with 2 days to burn it at -1.12,
  behind accounts with nothing left to give.
* `0.5 * free_5h` — **practical**: can it serve right now, or stall in ten
  minutes? Capped well under the weekly term, so it breaks ties rather than
  driving the choice.

Weights come from `pick-sim.py` (4 simulated weeks x 12 seeds: ~10% less wasted
weekly quota than picking on remaining quota alone). They sit on a plateau, not
a peak — re-run the sim before tuning.

Stale numbers are the real hazard — another machine or pi session can drain an
account between our reads — so the pool:

* **re-reads every candidate before switching** (`pickNext`), never on the
  hot path: if the pinned account still works, the switch costs zero requests;
* **parks anything that comes back full** until its stated reset, so all
  sessions skip it instead of each discovering the wall themselves;
* **asks the server on a cap hit** — a forced usage read after a 429 gives the
  real reset time rather than a 5-minute guess, and an account that reads full
  with no stated reset is parked for an hour;
* **falls back to cached numbers** if a read fails, and skips lineages that
  fail to refresh (dead) entirely.

In the `/claude-pool` list, keys act on the hovered row: `enter` switch,
`r` refresh usage, `d` enable/disable, `-` remove, `esc` close. Refresh, toggle
and remove re-present the updated list instead of closing it.

The list is sorted for human scanning, and automatic selection takes its pick
from the same order. Usable accounts rank by:

```text
rank = time_left_7d  -  4.4d * free_7d  -  2d * gate * (1 - time_left_5h / 5h)
gate = min(1, free_5h / 0.5)
```

**The weekly deadline is the spine**, because that is when unspent quota dies.
Unused quota then pulls an account earlier: a week 20% spent has more going to
waste than one 80% spent, so among accounts resetting around the same time, the
idle one goes first.

The weight on unused quota is the part that took tuning, and two real orderings
pin it from both sides (both are tests):

| ordering | implies |
| --- | --- |
| 3d15h out at 26% used beats peers 2d out at 60-66% — 40 points of unspent week outweighs a day of deadline | `k > 4.32d` |
| 2d10h out at 53% beats 3d20h out at 23% — there the deadline gap is wide enough to win | `k < 4.50d` |

**4.4 days** sits between them. Charging a **full week** — the natural "slack"
form, `free_7d - time_left_7d/7d` — lets idleness dominate outright: an account
resetting in *six days* at 13% used outranked accounts with half the time left,
and six days is ample runway to spend it later. Raise `k` toward `7d` to favour
draining under-used accounts, lower it toward `1d` to rank almost purely by
deadline — but the window above is narrow, so re-run both tests.

An expiring 5h window is free capacity: drain it and a fresh one opens
immediately. So among accounts close on the week, the one whose 5h window is
nearly over goes first, and you fall back to the other afterwards. Capping the
nudge at two days keeps it a tie-breaker: an account with days of runway can't
reach the top on a 15-minute 5h window alone. `gate` is a threshold, not a factor
— scaling by remaining 5h quota would make the right cap depend on 5h usage, so
no single constant could order every case; a spent window simply earns no nudge.

Note the list and the fallback `switchScore` above weigh the week differently on
purpose: the fallback runs only when *nothing* is usable, where use-it-or-lose-it
is the only question left.

Then come 5h-full accounts with under 90% weekly usage by soonest 5h reset; then
other healthy, cooling, and dead/disabled accounts. Row numbers are rankings
only, never command targets — commands accept labels or unique substrings.

A **disabled** account is held out of rotation but still kept logged in: the
keep-alive sweep refreshes its token like any other, so it is ready the moment
you re-enable it. Only a `dead` lineage is left alone.

### Keeping 5h windows warm (off by default)

The 5h window is created by an account's **first billable request** and ends
exactly 5h later — an account you have never used shows no reset clock at all
(the blank `5h` column). That makes an untouched account a liability for burst
work: start it, drain the quota in 30 minutes, and you wait out the remaining
4h30m. An account whose window opened hours ago costs the same 30 minutes and
then resets almost immediately.

So the sweep can send one minimal request (`max_tokens: 1`) to the top few
accounts whose window has not started, and you arrive mid-window instead of at
its start:

```sh
/claude-pool-warm   # bare cycles off → 1 → 2 → all
/claude-pool-warm 2

cpool warm          # show current setting and which windows are still cold
cpool warm 2        # keep the top 2 unstarted windows running
cpool warm all
cpool warm off      # default
```

`1`/`2`/`all` are **counts, not row numbers** — targets are the top N of the
same ranking the list uses.

This is the only request the extension makes that **spends quota**; everything
else reads `/api/oauth/*`. Three deliberate limits:

* **Warm starts are staggered 5h/N apart.** N windows opened in one sweep all
  expire in the same minute, which trades one convoy for another — the same
  failure the jittered sweep exists to prevent, one layer up.
* **Disabled, dead, cooling, and nearly-spent-weekly accounts are skipped.**
  Disabled means out of rotation, and weekly quota spent on a window you never
  use is the one cost here that does not come back.
* **Never warms blind.** An account with no usage read has an *unknown* window;
  a missing reset clock there means "no data", not "not started". After a
  warm-up its usage is re-read immediately, so the started window is visible to
  every session and cannot be warmed twice off a stale cache.

Worth knowing before turning it on: this is automated traffic whose only purpose
is to start rate-limit windows, and on a **shared team seat it starts someone
else's 5h window** and spends a sliver of their weekly quota. It also removes
stalls rather than adding capacity — the weekly cap is still the ceiling. Hence
off by default.

### Moving accounts to another computer

`/claude-pool-export` writes `~/.pi/agent/claude-pool-export.json` (path shown,
contents copied to the clipboard) and `/claude-pool-import` takes either a file
path or pasted JSON. What travels is the **refresh token** per account, which is
all a new machine needs — no `/login anthropic` per account. Existing labels are
merged over, so re-importing is safe.

That file is as sensitive as the store itself: it grants access to the Claude
subscriptions. Delete it once imported.

A row looks like:

```
▸ 2. datecs:flex1 · 5h(2h 11m) [███░░░░░] 34% · 7d(3d 4h) [██████░░] 71% · Fable 12% · login exp 2026-11-04
```

## CLI (`cpool`) — works outside pi

Safe to run while pi sessions are live (same locks); a switch is picked up by
running sessions within ~2s, no restart.

```bash
cpool list [--json]        # accounts with 5h / weekly quota
cpool switch datecs:work   # label/unique substring (bare `switch` rotates)
cpool add work             # snapshot auth.json's /login account
cpool disable datecs:work  # toggle out of rotation
cpool refresh [label]      # force a token refresh
cpool daemon [--once]      # single-writer keep-alive + usage sweep
cpool warm [off|1|2|all]   # keep that many 5h windows already running (off)
```

Run `cpool daemon` (systemd/Task Scheduler/`--once` from cron) if you want the
pool kept warm even when no pi session is open. Live sessions detect its
heartbeat and skip their own sweeps, leaving a single writer.

**Many sessions at once** costs about the same as one. Grants are deduplicated by
a per-lineage lock with a consume-gate, usage polls are claimed under the cache
lock, and the auto-switch window is claimed inside the store lock — so N sessions
make one refresh, one poll, and one re-pick between them, not N. Sweeps also
start at a random offset and jitter each tick, because a host that relaunches
every saved session after a reboot would otherwise keep them firing in lockstep
forever.

## Enrolling accounts

`/login anthropic` only keeps one credential, so snapshot each login:

```
/login anthropic          → sign in with account A
/claude-pool-add personal
/login anthropic          → sign in with account B (overwrites auth.json — fine)
/claude-pool-add work
/claude-pool              → verify both, pick the active one
```

Do **not** `/logout` between logins — current Claude Code revokes the refresh
token of the account you leave.

## Quota reads

`GET https://api.anthropic.com/api/oauth/usage` (`anthropic-beta:
oauth-2025-04-20`) — the same endpoint Claude Code and claude-swap use. Its
budget is ~28–30 requests per identity per *trailing* 60-minute window with no
gradual refill, so a burst blocks an account for a full hour. All reads therefore
go through one shared on-disk cache: 180s serve TTL, 180s minimum interval, at
most 2 accounts per sweep, `Retry-After` + 60s margin on a 429. Repainting a list
costs zero requests. Only the account in use is polled in the background, every
5 minutes (`ACTIVE_USAGE_MS`); the rest refresh on demand — `r` in `/claude-pool`
or `cpool list --refresh`.

### For other extensions

```ts
const { quota } = await import("pi-provider-claude-plus/index.ts");
const q = quota();          // active pooled account; quota("label") for a specific one
q?.five_hour?.pct           // 34
q?.seven_day?.resets_at     // ISO string
q?.at                       // when it was fetched (epoch ms)
```

Cache read only — no network, no rate-limit budget, safe to call on every
render. Returns `undefined` when the account has no cached read yet.

## Files (in `$PI_CODING_AGENT_DIR`, default `~/.pi/agent`)

| file | contents |
|---|---|
| `claude-pool.json` | accounts, active pin, cooldowns (mode 0600) |
| `claude-pool.stash.json` | rotated successor awaiting its store write |
| `claude-pool-usage.json` | quota cache + per-account poll schedule |
| `claude-pool-daemon.json` | daemon heartbeat |

## Environment variables

| variable | effect |
|---|---|
| `PI_CLAUDE_PROVIDER_DEBUG_LOG=/path` | append request payloads + pool events |
| `PI_CLAUDE_PROVIDER_DISABLE=1` | pass tools through flat (debug) |
| `PI_CLAUDE_PROVIDER_POOL_DISABLE=1` | disable the pool entirely |

## Test

```bash
node test.ts     # 15 asserts: locking, stash adoption, selection, backoff, parsing
```

## Not ported from claude-swap

macOS Keychain storage, parallel per-terminal sessions (`cswap run`), the Textual
TUI, the menu bar, and the `consume-first` weekly-quota strategy. The switching
strategy here is the slack score below.

MIT. Credit: `@zgltyq/pi-provider-claude`, `@benvargas/pi-claude-code-use`,
and `realiti4/claude-swap` for the liveness and cadence model.
