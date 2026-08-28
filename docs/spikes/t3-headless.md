# Spike: driving T3 Code headlessly for Heddle

Build-to-learn spike (kanban #652). Question: does T3 Code's dispatch API
support Heddle's control plane as described in the desk research
(`t3-code-analysis.md`, section 3), which was written from source and never
executed? Every step below was executed for real against an isolated T3 0.0.35
server on `127.0.0.1:3799` with a fresh base-dir, the `claudeAgent` driver, and
`claude-haiku-4-5`.

Scripts: `scripts/spike/`. The isolated server, tokens, and scratch repos live
under `.spike-scratch/` (gitignored).

## Verdict: GO WITH CAVEATS

The full loop — auth, start, observe, steer, approve, interrupt, stop — works
headlessly. But not entirely over plain HTTP: the one-call worktree bootstrap
is a WebSocket-layer feature, and HTTP error reporting is too opaque to build
on blind. Details in the caveats section.

## Version drift

| Surface | Version |
|---|---|
| Latest released npm `t3` (what this spike ran) | 0.0.35 |
| Source checkout `/workspaces/references/t3code` | 0.0.35 (commit `b0ae3f3a8`, 2026-08-27) |
| Running s6 server on :3773 (untouched) | 0.0.33 |
| `claude` CLI on this box | 2.1.250 |

Checkout and released build match, so source line references in the analysis
were reliable. The interesting drift is T3-vs-claude-CLI (see runtimeMode
caveat).

## Per-step verdicts

### 1. AUTH — PASS (both paths)

- `t3 auth session issue --base-dir <dir> --label spike-admin --json` prints a
  bearer token directly (writes to the auth store; server picks it up live).
  Scopes: `orchestration:read orchestration:operate terminal:operate
  review:write relay:read access:read access:write relay:write`, 30-day expiry.
- Service path: `t3 pair --base-dir <dir> --ttl 10m --label spike` prints a
  one-time token; exchange at `POST /oauth/token` (form-encoded):

  ```
  grant_type=urn:ietf:params:oauth:grant-type:token-exchange
  subject_token=<pair token>
  subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap
  requested_token_type=urn:ietf:params:oauth:token-type:access_token
  client_label=spike-service
  ```

  Response: `{"token_type":"Bearer","expires_in":2591999,"scope":
  "orchestration:read orchestration:operate terminal:operate review:write
  relay:read", ...}`. Narrower than the CLI-issued admin token (no `access:*`),
  and everything Heddle needs.

  Surprise vs analysis: `requested_token_type` is **required** (the analysis
  omitted it).

### 2. START — PARTIAL over HTTP, PASS over WS

The analysis's headline claim — "`POST /api/orchestration/dispatch` takes the
same command union" — is true for the schema and **false for behavior**.
Sending `thread.turn.start` with a `bootstrap` block over HTTP returns:

```json
{"_tag":"EnvironmentInternalError","code":"internal_error",
 "reason":"orchestration_dispatch_failed","traceId":"..."}
```

Server log: `OrchestrationCommandInvariantError: Thread '<id>' does not exist
for command 'thread.turn.start'`. Root cause: bootstrap expansion (create
thread, prepare worktree, run setup script) lives in the **WS handler**
(`apps/server/src/ws.ts`, `dispatchNormalizedCommand`), while the HTTP route
(`apps/server/src/orchestration/http.ts`) calls the orchestration engine
directly and never expands bootstrap.

Two working alternatives, both validated:

a) **Decomposed HTTP** (Heddle owns worktree prep): `git worktree add` yourself,
   then dispatch `thread.create` (with `worktreePath` + `branch`), then a bare
   `thread.turn.start`. Turn ran, session went `running → completed`,
   `notes.txt` contained exactly `hello`.

   ```json
   {"type":"thread.create","commandId":"<uuid>","threadId":"<uuid>",
    "projectId":"<uuid>","title":"spike thread",
    "modelSelection":{"instanceId":"claudeAgent","model":"claude-haiku-4-5"},
    "runtimeMode":"auto-accept-edits","interactionMode":"default",
    "branch":"spike/wt-1","worktreePath":"<abs path>","createdAt":"<iso>"}
   ```
   ```json
   {"type":"thread.turn.start","commandId":"<uuid>","threadId":"<same uuid>",
    "message":{"messageId":"<uuid>","role":"user","text":"...","attachments":[]},
    "modelSelection":{"instanceId":"claudeAgent","model":"claude-haiku-4-5"},
    "runtimeMode":"auto-accept-edits","interactionMode":"default",
    "createdAt":"<iso>"}
   ```

b) **One-call WS bootstrap**, exactly the analysis payload
   (`projectThreadStartTurnGoal` shape), sent as an Effect-RPC `Request` frame
   with tag `orchestration.dispatchCommand` on `/ws`: T3 created the worktree
   itself under `<base-dir>/worktrees/target-repo/spike-ws-bs`, ran the turn,
   wrote the file. The hand-rolled WS client is ~40 lines
   (`scripts/spike/ws-dispatch.mjs`): connect with `Authorization: Bearer` as
   an upgrade header (works with Node >= 22 native WebSocket), send
   `[{"_tag":"Request","id":"1","tag":"<rpc>","payload":{...},"headers":[]}]`,
   read `Exit`/`Chunk` frames, `Ack` after each `Chunk`.

`project.create` over HTTP works fine — only bootstrap is WS-gated.

Provider/model discovery: there is **no REST equivalent of
`server.getConfig`** (checked the full REST endpoint table in
`packages/contracts/src/environmentHttp.ts`). Over WS it works and returns
`providers[].{instanceId, models[].slug}` plus capability flags and
`serverVersion`. For a fresh install the default claude instance is
auto-provisioned with `instanceId = "claudeAgent"` (instance id defaults to
the driver kind) — no settings file needed when `claude` is on PATH. Model
slugs also appear in `<base-dir>/userdata/model-manifest.json`.

### 3. OBSERVE — PASS

Polled `GET /api/orchestration/shell` (~3-5s interval) and reimplemented
`resolveThreadAwarenessPhase` from `packages/shared/src/agentAwareness.ts`
in jq (`lib.sh:awareness_phase`). The derivation tracked reality:

- trivial turn: `running` at 5s, `completed` at 10s; snapshot showed
  `session.status:"ready"`, `latestTurn.state:"completed"`, `completedAt` set;
- approval turn: `running` → `waiting_for_approval` (via `hasPendingApprovals`);
- failed session: `failed` (via `session.status:"error"`).

The shell thread entry carries everything the wake-up logic needs:
`hasPendingApprovals`, `hasPendingUserInput`, `session.status`,
`latestTurn.{state,completedAt}`.

### 4. STEER — PASS

Second `thread.turn.start` on the same threadId (no bootstrap, no
modelSelection) while a long turn was `running`: accepted (`{"sequence":41}`),
no error. It surfaces as an additional `user` message inside the running turn,
and the agent obeyed it — the 300-line poem was abandoned and `poem.txt`
ended up containing exactly the steer's requested `done`.

### 5. APPROVAL — PASS

Thread with `runtimeMode:"approval-required"`, prompt forcing a shell command:

- shell snapshot flipped `hasPendingApprovals:true` while the turn stayed
  `running`;
- the `requestId` is in the thread snapshot's activities
  (`GET /api/orchestration/threads/:threadId`), kind `approval.requested`:

  ```json
  {"kind":"approval.requested","tone":"approval",
   "payload":{"requestId":"<uuid>","requestKind":"command",
    "requestType":"command_execution_approval",
    "detail":"Bash: date > timestamp.txt"}}
  ```

- `thread.approval.respond` with `decision:"accept"` over HTTP dispatch
  unblocked the turn; it completed and `timestamp.txt` was written.

Note the analysis said requestIds "arrive on the thread event stream" — true,
but polling the thread snapshot's activities works without any subscription.

### 6. LIFECYCLE — PASS with a semantics surprise

- `thread.turn.interrupt` on a running turn stopped the work mid-flight
  (20 of 500 requested lines written), but the read model recorded
  `latestTurn.state:"completed"` (with `completedAt`) and — unexpectedly —
  `session.status:"stopped"` immediately. There was no observable
  `interrupted` state and no still-ready session. The analysis's own note
  ("interrupted-with-completedAt counts as completed") hints this is by
  design, but Heddle must not rely on distinguishing "finished" from
  "interrupted" via the shell snapshot.
- `thread.session.stop` on an idle `ready` session: `ready → stopped`,
  awareness stays `completed`. On the already-stopped thread it was a
  silent no-op (still returns a sequence).

## Caveats behind the GO

1. **Bootstrap is WS-only.** Either Heddle owns worktree prep + `thread.create`
   (pure HTTP, fully validated, and arguably better for a deterministic
   workflow service that wants to control worktree placement), or it keeps a
   minimal WS client for the one-call path. The 40-line hand-rolled client
   worked on the first try, so this is a small tax either way.
2. **HTTP errors are opaque.** Invariant violations (thread missing, etc.)
   come back as a generic `internal_error` + traceId; the actual reason is
   only in server logs. Heddle needs defensive preconditions rather than
   error-message parsing.
3. **T3-to-claude-CLI version coupling.** `runtimeMode:"auto"` maps to claude
   permission mode `"auto"`, which claude CLI 2.1.250 rejects — the session
   dies with `lastError:"turn/setPermissionMode failed"` and the thread is
   unusable (state `error`, no turn). `auto-accept-edits`, `full-access`, and
   `approval-required` all work. T3 assumes a claude CLI newer than what is
   installed here; Heddle must treat runtime modes as capability-dependent and
   have a fallback.
4. **No protocol versioning / private contracts** (as the analysis said).
   Version pinning of the `t3` npm package per Heddle release is the sane
   posture; `server.getConfig` capabilities are the de-facto handshake, and
   reading them requires WS.
5. **Auth is not migration-safe** (known from the box's own history: a past
   upgrade wiped pairings). Heddle must detect 401s and re-run
   `auth session issue`/pair-exchange.

## Other findings for the analysis errata

- `requested_token_type` is required in the `/oauth/token` exchange.
- Dispatch success responses are `{"sequence": <n>}` — a monotone event
  sequence number, useful as a write cursor.
- Thread snapshot shape is `{snapshotSequence, thread}` with `thread.messages`,
  `thread.activities` (kind/payload), `thread.turns` absent — turn state comes
  from `latestTurn` on the shell/thread, not a turn list.
- `getConfig` model entries use `slug`, not `id`.
- `runSetupScript:true` with no `t3.json` in the repo is tolerated (no-op).
- npm installs of `t3` need `npm rebuild node-pty` when install scripts are
  policy-blocked; the server otherwise starts fine.
- `--auto-bootstrap-project-from-cwd` did not create a project on first start
  in this run; `project.create` over HTTP dispatch is the reliable path.

## What Heddle's control plane looks like on this surface

Pure HTTP + one tiny WS shim:

1. issue/exchange token (CLI or pair+`/oauth/token`);
2. `server.getConfig` over WS once per connect for instance/model/capability
   discovery (or pin config and skip WS entirely);
3. own the worktree, `thread.create`, `thread.turn.start` over HTTP;
4. poll `GET /api/orchestration/shell`, derive phase with the
   `agentAwareness` rules (mirrored in `lib.sh`);
5. steer with bare `thread.turn.start`, gate with `approval-required` +
   `thread.approval.respond`, tear down with `thread.turn.interrupt` /
   `thread.session.stop`.
