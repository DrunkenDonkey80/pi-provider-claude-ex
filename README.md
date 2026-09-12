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
/claude-pool <n|label>       switch directly
/claude-pool-add <label>     snapshot the current /login anthropic account
/claude-pool-remove <n|label>
/claude-pool-disable <n|label>   hold out of / return to rotation (toggle)
/claude-pool-export          write the logins to a portable file + clipboard
/claude-pool-import [path|json]  load them on another machine
```

### Which account gets picked

Stay pinned while the current account works. When it doesn't, score every
candidate on **quota left minus time left to spend it**, per window:

```text
slack_w = (1 - pct/100) - time_until_reset / window_length
score   = slack_7d + 2 * slack_5h
```

Positive slack means use-it-or-lose-it; negative means ahead of budget, save it.
So a 5h window resetting in 15 minutes with half unspent wins, while "70% of the
week gone with 3 days left" is held back. Weights come from `pick-sim.py`
(4 simulated weeks x 12 seeds: ~10% less wasted weekly quota than picking on
remaining quota alone). They sit on a plateau, not a peak — re-run the sim
before tuning.

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
cpool switch 2             # pin account 2 (bare `switch` rotates)
cpool switch datecs:work   # by label or unique substring
cpool add work             # snapshot auth.json's /login account
cpool disable 3            # toggle out of rotation
cpool refresh [n|label]    # force a token refresh
cpool daemon [--once]      # single-writer keep-alive + usage sweep
```

Run `cpool daemon` (systemd/Task Scheduler/`--once` from cron) if you want the
pool kept warm even when no pi session is open.

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
