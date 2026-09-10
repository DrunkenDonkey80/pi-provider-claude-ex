# @zgltyq/pi-provider-claude

Claude (Anthropic **OAuth / subscription**) compatibility layer for
[pi-coding-agent](https://pi.dev). Keeps **all** your extension tools usable
under the Claude subscription.

It is a self-contained fork of the tool-handling half of
[`@benvargas/pi-claude-code-use`](https://www.npmjs.com/package/@benvargas/pi-claude-code-use)
(MIT) — credit to Ben Vargas for the original approach.

## Problem

Anthropic's OAuth (subscription) request path appears to fingerprint tool names.
Tools that are **not** part of the Claude Code core set and are **not** prefixed
`mcp__` can be classified as *extra usage*. The upstream extension defends against
this by **dropping every unknown flat-named tool** before the request is sent —
which silently hides legitimate extension tools from Claude:

`ask_user_question`, `todo`, `subagent`, `ast_grep_search`, `lsp_diagnostics`,
`ctx_*`, `web_search`, `ralph_*`, `preview_export`, … all disappear, even though
they work fine for non-Anthropic models.

## What this does

Instead of dropping unknown flat tools, it **renames them in place on the wire**
to `mcp__pi__<name>`:

- ✅ `mcp__*` shape passes Anthropic's classifier → **no extra-usage charge**
- ✅ the tool stays **visible to Claude** → it can actually call it
- ✅ on the way back, calls to `mcp__pi__*` are rewritten to the original flat
  name **before Pi executes them**, so the real tool (and its closure-bound
  state) runs unchanged

Untouched: native Anthropic tools (objects with a `type` field, e.g.
`web_search`), anything already `mcp__`-prefixed, and the Claude Code core tools.
The extension only activates for **Anthropic + OAuth** — API-key auth and
non-Anthropic providers pass through completely unchanged.

It also applies the upstream system-prompt rewrite (`pi itself` → `the cli
itself`, etc.) on the OAuth path.

## Why it's lightweight

The tool's full JSON schema already rides inside the outbound payload, so the fix
is a pure rename — **no jiti capture, no tool re-registration, no typebox**. The
only import is a TypeScript type (erased at runtime), so the extension has **zero
runtime dependencies**.

## Install

```bash
pi install npm:@zgltyq/pi-provider-claude
```

Then remove the upstream one so they don't both transform the payload:

```bash
pi remove npm:@benvargas/pi-claude-code-use
```

Restart Pi (or `/reload`) and continue using the normal `anthropic` provider with
your OAuth login.

## Verify

```bash
PI_CLAUDE_PROVIDER_DEBUG_LOG=/tmp/claude-provider.log pi
# send one message, then quit
```

In `/tmp/claude-provider.log`, the `"after"` payload's `tools[]` should show your
extension tools as `mcp__pi__<name>` and **nothing dropped**.

## Multi-account failover (opt-in)

If you have **two subscription accounts** (e.g. personal + work), the extension can
fail over between them: when the active account hits its rate / usage cap (429/529),
it's put on cooldown and the next turn transparently continues on the other account.
Subscription billing is preserved (Pi detects the OAuth path from the token shape).

**Priority:** array order in `claude-pool.json` IS the priority. `accounts[0]` is the
primary — failover is non-sticky, so as soon as the primary's cooldown expires the
pool returns to it automatically. Put your preferred account first.

**Detection (v1.2.0):** pi-ai's anthropic transport only emits
`after_provider_response` for *successful* requests — the Anthropic SDK throws on
429/529 before that callback runs, so header-based detection alone never fires.
Since v1.2.0 the primary detector pattern-matches the provider error that lands on
the assistant message (`stopReason: "error"`) via `message_end`, including Claude's
`"usage limit reached|<epoch>"` reset timestamps for accurate cooldowns. When a cap
is hit, the turn errors once, the pool flips (with a UI notification), and you just
resend your message to continue on the other account.

**OAuth compatibility and background token refresh (v1.3.3):** The pool now
uses its own Anthropic OAuth login/refresh adapter and the login callback bridge
matches pi 0.81.x, where the old runtime OAuth export is no longer available.
OAuth access tokens are short-lived. An account that sat idle (e.g. your fallback)
would have a dead access token by the time failover switched to it — producing a
`401 authentication_error`. v1.3.3 also applies `/claude-pool-add` immediately to
the running session and excludes accounts whose refresh token is expired or revoked:

- A `setInterval` keep-warm loop that refreshes **every** pooled account before it
  expires, even when idle and not the active account (the timer is `unref()`'d so
  it never blocks CLI commands like `pi update` from exiting).
- A wider 5-minute pre-expiry refresh buffer, and a full-pool refresh on
  `session_start` / `before_agent_start` (not just the active account).
- Reactive 401 handling: if the server rejects the active token anyway, it is
  force-refreshed in place (no account switch) so the resend succeeds. If the
  refresh token itself was revoked, you're told to re-run `/login` +
  `/claude-pool-add <label>`.

It is **inert** unless `<agentDir>/claude-pool.json` exists with ≥2 accounts and
`"enabled" !== false`.

### Enroll accounts with the native `/login` (recommended)

`/login anthropic` only keeps ONE credential (a second login overwrites the first),
so the extension adds a command to snapshot each login into the pool:

```
/login anthropic          → sign in with account A
/claude-pool-add personal → stash account A in the pool
/login anthropic          → sign in with account B (overwrites auth.json — fine)
/claude-pool-add work      → stash account B in the pool
/claude-pool-status        → verify both are present
```

Restart after initially creating the pool to activate failover. Once active,
`/claude-pool-add <label>` updates both `claude-pool.json` and the running session,
so replacing a revoked credential no longer requires another restart.

### Alternative: harvest via separate profiles

```bash
PI_CODING_AGENT_DIR=~/.pi-personal pi    # /login anthropic  (personal)
PI_CODING_AGENT_DIR=~/.pi-work     pi    # /login anthropic  (work)
./harvest-claude-pool.sh                 # writes ~/.pi/agent/claude-pool.json
```

`claude-pool.json` shape:

```json
{ "enabled": true, "accounts": [
  { "label": "personal", "refresh": "...", "access": "...", "expires": 0 },
  { "label": "work",     "refresh": "...", "access": "...", "expires": 0 }
] }
```

Kill switch: `PI_CLAUDE_PROVIDER_POOL_DISABLE=1` (or `"enabled": false`).

## Environment variables

| Variable | Effect |
|---|---|
| `PI_CLAUDE_PROVIDER_DEBUG_LOG=/path` | Append `before`/`after`/`pool` events for debugging. |
| `PI_CLAUDE_PROVIDER_DISABLE=1` | Pass all tools through with flat names (no renaming). Debug escape hatch. |
| `PI_CLAUDE_PROVIDER_POOL_DISABLE=1` | Disable multi-account failover even if `claude-pool.json` exists. |

## How it differs from `@benvargas/pi-claude-code-use`

| | upstream | this fork |
|---|---|---|
| Unknown flat tools | **dropped** | **renamed** `mcp__pi__<name>` (kept) |
| Alias scheme | per-tool config + jiti capture + re-registration | generic in-place rename (deterministic prefix) |
| Runtime deps | `@mariozechner/jiti` | none |
| Scope | tool filtering + companion aliases + system-prompt rewrite | tool renaming + system-prompt rewrite |

## License

MIT. Based on `@benvargas/pi-claude-code-use` (MIT).
