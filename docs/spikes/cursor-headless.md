# Spike: Cursor provider on T3 Code's headless control surface

Build-to-learn spike (kanban #655). Question: does the Cursor provider work on
the same headless control surface the t3-headless spike proved for the claude
driver, including the escalation question path? Every step was executed against
an isolated T3 0.0.36 server on `127.0.0.1:3801` with a fresh base-dir and the
`cursor` driver, model `default`.

Scripts: `scripts/spike/` (shared with the t3-headless spike; cursor-specific
additions are `cursor-acp-shim.mjs` and `acp-probe.mjs`). Server, tokens, the
local cursor build, and scratch repos live under `.spike-scratch/` (gitignored).

## Verdict: NO-GO for the question path today, GO for drive/observe/steer

The whole T3-side surface works for the cursor driver — auth, decomposed HTTP
start, shell-snapshot observation, approvals, user-input round-trip, and
settle-on-stop are all identical to the claude driver. Two things outside T3
block a production question path:

1. **Session start deadlocks under headless (API-key) auth** unless the ACP
   `authenticate` call is intercepted (details below). Fixable with a thin
   wrapper today; properly a T3 upstream fix.
2. **Cursor's backend did not grant the AskQuestion tool to any session in
   this spike**, in agent or plan mode, on either the stable or lab CLI build.
   The model itself reports "AskQuestion tool is not available in the current
   agent session tool definitions". Tool availability is decided server-side
   per session (`ask_question_all_modes` statsig gate in the CLI bundle);
   nothing Heddle can flip locally. The full T3 round-trip was proven by
   emitting the exact `cursor/ask_question` wire request from a shim instead.

## Version drift

| Surface | Version |
|---|---|
| Latest released npm `t3` (what this spike ran) | 0.0.36 |
| Source checkout `/workspaces/references/t3code` | 0.0.35 (commit `b0ae3f3a8`, 2026-08-27) |
| `cursor-agent` on PATH (untouched) | 2026.08.11-e8db854 |
| Spike-local lab build (what the server drove) | 2026.08.25-3e8eec8, `.spike-scratch/cursor-local/` |
| Cursor model used | `default` (T3's own adapter tests use the same slug) |

## Per-step verdicts

### 1. Isolated server — PASS

`npm install t3@0.0.36` in `.spike-scratch/t3-local` (plus `npm rebuild
node-pty`), fresh `--base-dir`, port 3801. The s6 server on :3773, the global
`t3`, and `/home/vscode/.t3` were untouched. Cursor is **off by default**
(contracts `settings.ts`: `enabled` decodes to `false`, "Users opt in from
Settings"), so `00-setup.sh` writes
`<base-dir>/userdata/settings.json` before first start:

```json
{ "providers": { "cursor": { "enabled": true, "binaryPath": "<wrapper>" } } }
```

With that, the instance registry hydrates a `cursor` instance (instanceId =
driver kind, same rule as `claudeAgent`). Auth (CLI `session issue` and
pair + RFC 8693 exchange with the required `requested_token_type`) behaves
exactly as on 0.0.35.

### 2. Cursor CLI availability — PASS with an auth caveat

`cursor-agent` (and alias `cursor`) 2026.08.11-e8db854 on PATH, but its
interactive login state was not usable headlessly: raw ACP `session/new`
returns `-32000 Authentication required`. Auth that works headlessly is the
`CURSOR_API_KEY` env var, supplied via a wrapper script the server's
`binaryPath` points at. The spike also fetched the current lab build
(2026.08.25-3e8eec8) as a plain tarball into `.spike-scratch/cursor-local/`
(no global change): `https://downloads.cursor.com/lab/<version>/linux/x64/agent-cli-package.tar.gz`.

**Deadlock found:** T3's `AcpSessionRuntime.startOnce` sends
`authenticate {methodId:"cursor_login"}` unconditionally after `initialize`.
With API-key auth the cursor agent **never answers** that request, and the T3
session sits in `starting` forever — no timeout, no error, `latestTurn` never
appears. Verified both through T3 and with a direct ACP probe
(`acp-probe.mjs`): `authenticate` hangs, while skipping it makes
`session/new` + `session/prompt` work fine under the API key.

Workaround, validated end to end: `cursor-acp-shim.mjs` sits at `binaryPath`,
answers `authenticate` locally with `{}`, and passes everything else through.
With the shim the provider probe goes `ready`/`authenticated` and ACP model
discovery works (the earlier "model discovery timed out after 15000ms" was
the same authenticate hang). Heddle upstreamable finding: authenticate should
be skipped or timed out when the agent advertises auth it does not need.

### 3. START + OBSERVE — PASS

Same decomposed-HTTP sequence as the claude driver, only the
`modelSelection` differs:

```json
{"type":"thread.create", ..., "modelSelection":{"instanceId":"cursor","model":"default"},
 "runtimeMode":"auto-accept-edits","interactionMode":"default",
 "branch":"spike/wt-N","worktreePath":"<abs>","createdAt":"<iso>"}
```
```json
{"type":"thread.turn.start", ..., "message":{"messageId":"<uuid>","role":"user","text":"...","attachments":[]},
 "modelSelection":{"instanceId":"cursor","model":"default"}, "runtimeMode":"auto-accept-edits",
 "interactionMode":"default","createdAt":"<iso>"}
```

Trivial prompt: `running` at 3s, `completed` at 9s on the shell poll
(`agentAwareness` derivation unchanged); `notes.txt` contained exactly
`hello`; `session.status:"ready"`, `latestTurn.state:"completed"`.

Bonus (not in DoD): a cursor `dynamic_tool_call` ("Searched files") raised
`approval.requested` on the thread activities and `thread.approval.respond`
`accept` over HTTP unblocked it — the approval path is driver-agnostic too.

### 4. Question round-trip — PASS at the T3 contract layer, FAIL end-to-end with the real model

What the real agent does: prompted to use its question tool (many phrasings,
agent and plan `interactionMode`, stable and lab builds), cursor either asks
**in plain text and completes the turn** or reports the tool is missing:

> AskQuestion tool is not available in the current agent session tool
> definitions. No AskQuestion, ask_question, or cursor/ask_question MCP tool
> was provided in the callable tool list for this turn.

Asked to enumerate its tools, the session lists Shell, Read, Write, Grep,
Glob, Task, TodoWrite, SwitchMode, WebSearch... and no question tool. The CLI
bundle contains the tool (`askQuestionToolCall` proto, `ask_question_all_modes`
gate) and its ACP handler calls the `cursor/ask_question` ext method with a
fallback to `session/request_permission` — the backend simply did not put the
tool in this account's session toolset. This is a Cursor-side rollout switch,
not a T3 or Heddle defect.

The T3 surface itself, proven by having the shim emit the byte-exact ext
request the agent would send
(`{"method":"cursor/ask_question","params":{"toolCallId":"...","title":"...","questions":[{"id":"q1","prompt":"...","options":[{"id":"opt-a","label":"Option A"},{"id":"opt-b","label":"Option B"}]}]}}`):

- `user-input.requested` lands in the thread activities with `requestId` and
  the mapped questions (labels doubled into `description`, header
  `"Question"`, `multiSelect:false`);
- the shell poll flips `hasPendingUserInput:true` while the turn stays
  `running` (awareness phase `waiting_for_input`);
- HTTP dispatch answers it — answers record is keyed by **question id** with
  the **option label** (or label array when `multiSelect`), matching the web
  client:

  ```json
  {"type":"thread.user-input.respond","commandId":"<uuid>","threadId":"<uuid>",
   "requestId":"<from activities>","answers":{"q1":"Option B"},"createdAt":"<iso>"}
  ```

- the agent-side JSON-RPC response is
  `{"result":{"answers":{"q1":"Option B"}}}`, and `user-input.resolved` with
  the same answers lands in the thread history; `hasPendingUserInput` clears.

Contract surprise to re-verify when the tool ships: T3 returns the raw
`answers` record (id → label). The cursor CLI's own reply mapping speaks
`{questionId, selectedOptionIds}` — whether the real agent accepts T3's
label-keyed record could not be tested without the tool. File under "check on
first real ask_question".

### 5. Settle-on-stop — PASS

With a shim-emitted question pending (`hasPendingUserInput:true`),
`thread.session.stop` over HTTP settled it: `user-input.resolved` recorded
with `"answers": {}` (empty, exactly as `CursorAdapter`'s pending-user-input
settlement promises), `hasPendingUserInput:false`,
`session.status:"stopped"`, `latestTurn.state:"completed"`.

### 6. runtimeMode / version drift — PASS (notes)

- All four runtime modes ran a file-writing turn to completion on cursor:
  `auto`, `auto-accept-edits`, `full-access`, `approval-required`. Notably
  **`auto` works on cursor** while it kills claude-driver sessions under
  claude CLI 2.1.250 — runtime-mode capability really is per-driver, per
  version; Heddle must not assume a shared mode matrix.
- Cursor runtime modes are resolved by alias against the agent's ACP mode
  list (`agent`, `plan`, `ask`); `approval-required` still auto-approved a
  plain file write (cursor's approval mode gates commands/searches, not
  edits). Approval semantics are coarser than claude's.
- `interactionMode:"plan"` maps to cursor's plan mode and works headlessly
  (the turn produced a plan; `cursor/create_plan` would surface as
  `turn.proposed.completed`).
- Model discovery (`server.getConfig` over WS) returns the full cursor
  catalog (`default`, `composer-2.5`, `claude-*`, `gpt-*`, `grok-*`,
  `gemini-*`) once the authenticate deadlock is shimmed away; `default` is
  the safe pin.
- T3's provider probe parses `agent about` for a "User Email" line; under
  API-key auth the field is absent and one probe variant reports
  `unauthenticated`, which suppresses model discovery. The shim path avoids
  this; upstream, probing should account for API-key auth.

## What Heddle's control plane looks like for cursor

Identical to the claude driver (own the worktree; `thread.create` +
`thread.turn.start` over HTTP; poll `/api/orchestration/shell`; respond to
approvals/user-input by `requestId` from thread activities; stop/interrupt to
tear down), plus three cursor-specific provisions:

1. ship or require a `binaryPath` wrapper that injects `CURSOR_API_KEY` and
   neutralizes the ACP `authenticate` deadlock (until fixed upstream in T3);
2. treat the question path as **not yet available** on cursor: awareness can
   trust `hasPendingUserInput` when it fires, but cursor today asks questions
   in plain text and completes the turn — done-vs-needs-me derivation cannot
   distinguish that from a finished turn. Gate cursor sessions to
   non-escalating workflows, or post-process final messages, until Cursor
   enables the AskQuestion tool;
3. pin model `default` unless discovery is wired through the WS
   `server.getConfig` call.
