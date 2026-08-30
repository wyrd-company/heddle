---
relationships:
  implements: heddle
  references:
    - t3-headless
    - t3-session-visibility
---

# Production composition

One production composition owns one workspace. The deployed `heddle-server`
loads the operator configuration, constructs that composition, and uses it for
the server, console, MCP endpoint, scheduler, attention queue, repository
blueprint editor, and persistence lifetime. The no-composition server boundary
exists only for tests and console-specific composition. The editor is the
accepted `BlueprintArtifactEditor` over the organization blueprint clone and
the same mechanical effect registry as the lifecycle engine. The factory
rejects a second live composition for the same board directory.

## Configuration directory

`--config <directory>` selects the configuration directory. Without that
argument, `HEDDLE_CONFIG` selects it; the default is `/home/vscode/.heddle`.
The required file name is `config.yml`. The service reads this file, validates
the schema and runtime agreements, and fails before composition or network bind
when it is missing, unreadable, or invalid. Errors name the exact file and first
validation failure while redacting configured T3 and Pushover secrets.
The loopback server port must be from 1 through 65535; an ephemeral port cannot
be projected into the fixed Caddy upstream.

After validation, the service binds the configured loopback endpoint before it
constructs or starts the production composition. The bound endpoint returns
`503 Service Unavailable` until composition startup completes. A bind failure
therefore leaves the board, T3, Pushover, and production persistence untouched.

`config.yml` is the sole deployed runtime authority. `HEDDLE_BOARD_PATH`,
`HEDDLE_HOST`, `HEDDLE_PORT`, and `HEDDLE_STATE_PATH` do not affect deployed
configuration. Configuration changes require service restart. Heddle does not
write, migrate, or reformat the file. The operator owns the directory and must make
`config.yml` readable only by that account, normally mode `0600`.

The directory may also contain `heddle.md` and the required organization
blueprint clone at `blueprints/`. Unknown entries are ignored. Neither entry is
a `config.yml` field.

This complete single-product example uses Cursor and no provider budget, so it
omits both executable adapters:

```yaml
adHocProject:
  name: Shared records
  projectId: shared-project
  workspaceRoot: /workspaces/sample-workspace
boardDirectory: /workspaces/sample-board
cadenceMilliseconds: 60000
observationThresholds:
  endedMilliseconds: 60000
  failedMilliseconds: 60000
  stalledMilliseconds: 60000
pacing:
  defaultProvider: cursor
  maxConcurrentSessions: 2
  providerBudgets: {}
  subagents:
    maxDepth: 2
    maxFanOut: 2
  usageWindowHours: 5
products:
  - name: Sample collection
    repos:
      - name: sample-repository
        repositoryRoot: /workspaces/sample-repository
pushover:
  apiUrl: https://notify.example.invalid/messages
  applicationToken: replace-with-operator-secret
  consoleBaseUrl: https://console.example.invalid/
  userKey: replace-with-operator-secret
server:
  host: 127.0.0.1
  port: 3774
session:
  baseRef: main
  cliVersion: 2026.08.25-3e8eec8
  driver: cursor
  interactionMode: default
  model: sample-model
  runtimeMode: auto
  skillPointer: skill://sample
  worktreesRoot: /workspaces/worktrees
stageThresholds:
  implement: 900000
  review: 900000
stateDirectory: /var/lib/heddle
stopTimeoutMilliseconds: 10000
t3:
  accessToken: replace-with-operator-secret
  baseUrl: http://127.0.0.1:3773
```

Configuration conforms to `schemas/production-configuration.json`. The
`products` inventory is the authority for product and repository routing. Each
product declares a unique name and one or more globally unique repository names
with absolute roots. Its optional `epicProject` records the one active epic's
ID and existing T3 project ID when composition starts with that project already
provisioned. `adHocProject` declares the existing shared project name, ID, and
absolute workspace root. Board tasks may declare `product` and `repos` in front
matter. Child tasks inherit omitted declarations from their epic. Heddle raises
attention when a task, epic, or lifecycle stage refers to authority outside
these declarations; it does not inspect diffs or branches to guess.

Other required values are the absolute board and state directories, optional
worktree root, reconciliation cadence, bounded stop timeout, provider pacing,
session provider settings, observation and per-stage staleness thresholds, and
Pushover routing. The server port is a fixed integer from 1 through 65535. T3
and Pushover secrets enter only through operator-owned
`config.yml`; Heddle does not log, emit, or persist them. The configured pacing
`defaultProvider` must equal the session
`driver` used for top-level lifecycle stages. Delegated subagents carry their
explicit provider and model through the same pacing evaluator and T3 provider
preconditions.
T3, Pushover API, and console endpoints must be absolute HTTP or HTTPS URLs;
the runtime validator and configuration schema reject other schemes.

## Organization blueprint repository

Clone the organization's blueprint repository into
`<HEDDLE_CONFIG>/blueprints` before service startup. The directory must be the
exact root of a Git worktree, and its current branch must track `origin`.
Provision the service user with a forwarded SSH agent socket or a scoped deploy
key that can fetch and push that repository. Heddle stores no Git credential in
`config.yml`, logs, attention payloads, or instance state. The supported
service-user SSH-agent path is qualified with `git push --dry-run` to a unique
scratch ref; the dry run leaves no remote ref.

Each reconciliation pass runs `git fetch --no-tags --prune origin` under the
repository writer lease. Fetch changes remote-tracking refs only. New instances
and explicit instance rebases read the fetched upstream commit. Running
instances keep their held blueprint blob and do not change version. Heddle does
not merge, rebase, reset, switch, or modify the working branch during fetch.

The console editor requires a clean working tree with the current branch equal
to upstream. One successful save validates and atomically replaces the artifact,
commits only that artifact, and pushes the commit while holding the same writer
lease. A push failure leaves the commit local and raises durable attention with
the repository and commit. Dirty, unpushed, behind, or diverged state also
raises one durable repository attention entry. Resolve the state manually, then
allow a later reconciliation pass to clear the entry; do not expect Heddle to
integrate commits.

To migrate an existing workspace, copy its authored blueprint changes into the
organization repository, validate and commit them there, clone that repository
at `<HEDDLE_CONFIG>/blueprints`, and then restart Heddle. Remove legacy
per-product or Heddle-source blueprint copies only after the organization commit
contains the required artifact bytes. Validate a clone from the blueprint
repository with:

```console
task validate HEDDLE_REPOSITORY_ROOT=/absolute/path/to/heddle
```

Heddle owns the lifecycle blueprint schema and interpreter. The organization
repository owns authored blueprint artifacts together with the
`handoff-templates/` and `todo-templates/` artifacts they bind. Validation
fails when a node's pinned handoff-template path and blob hash or named todo
template does not resolve in the repository being validated.

For example, the routing portion has this shape:

```json
{
  "adHocProject": {
    "name": "Shared tasks",
    "projectId": "shared-project-id",
    "workspaceRoot": "/workspaces/sample-workspace"
  },
  "products": [
    {
      "name": "Sample product",
      "repos": [
        {
          "name": "sample-repository",
          "repositoryRoot": "/workspaces/sample-repository"
        }
      ],
      "epicProject": {
        "epicId": 101,
        "projectId": "epic-project-id"
      }
    }
  ]
}
```

The provider-usage source and session timeout application are distinct explicit
runtime ports. A nonempty `pacing.providerBudgets` requires top-level
`providerUsage`; an empty budget catalog forbids it. Its absolute executable is
started without a shell, receives one version-1 JSON request on stdin containing
the provider and fixed five-hour window, and must return exactly one version-1
JSON response with finite nonnegative `used` and a nonnegative safe-integer
`windowStartedAt`. The configured timeout bounds execution and response output.
The executable owns any provider authentication; no credential belongs in its
arguments or Heddle output.

A `session.driver` of `codex` or `claudeAgent` requires nested
`session.timeoutApplication`; other drivers forbid it. This separately
preflighted absolute executable receives the accepted timeout-consumer input as
one version-1 JSON request and must return exactly
`{"version":1,"applied":true}`. Heddle invokes it before `thread.create` and
fails closed on startup, process, timeout, output, or acknowledgement errors.
Both executable configurations accept optional `arguments` and a bounded
`timeoutMilliseconds` default of 10000. Heddle terminates failed or timed-out
children and does not expose their output.

An in-progress epic gets one T3 project titled
`{product} - epic-{id}` at `/workspaces/worktrees/{epic-id}`. Heddle prepares
each declared repository at `/workspaces/worktrees/{epic-id}/{repository}` on
`epic/{epic-id}` before project creation. Paused, stopped, and UAT epics retain
their project; a done epic's project is deleted. Child task threads use that
epic project. Successful deletion leaves a durable local tombstone; restart
does not seed a configured tombstoned project as active or repeat its deletion.
Ad-hoc threads use `adHocProject.projectId`. Subagents reuse the parent's project
and worktree.

Task worktrees use `/workspaces/worktrees/{task-id}/{repository}`. Existing
repo-first worktrees are not migrated. Every thread has a bounded deterministic
`task-<id> · <stage-occurrence>` title and no `titleSeed` on its first turn.
Each occurrence of a wait stage has one durable
session and thread identity. A recurring review or remediation stage receives
a new occurrence discriminator; restart resumes an incomplete occurrence.
All stage occurrences for one task use the same task branch and worktree so
review, remediation, and later stages operate on the same delivery state.

## System prompt

Every stage session starts with a system prompt followed by its rendered stage
handoff. The compiled service contains the built-in prompt. To replace it,
create `<HEDDLE_CONFIG>/heddle.md`; Heddle reads that file wholesale and does
not concatenate the built-in prompt. A missing file selects the built-in
prompt. Heddle never creates, writes, or migrates `heddle.md`.

The prompt is resolved once when Heddle creates the durable session handoff.
Retry and restart use the stored prompt and exact composed document even when
the operator file changes later. The override is plain Markdown, not a
template or `config.yml` field. Do not put secrets, task details, stage details,
correlation tokens, or source-provenance markers in it.

The documented built-in default is:

```md
# Heddle stage session

You are one stage-scoped session in a Heddle workflow. The handoff below carries the task contract and the current stage state that you must act on.

Your todo list is prepopulated. Use the Heddle MCP todo tools as its write path; do not use a harness-native todo tool.

Use `advance` to disposition the current stage. The operation is idempotent for this stage, so a retry cannot transition it twice.

Use `escalate` for a blocking question that requires attention outside this session.
```

Agent wait nodes declare `handoff: standard` or `handoff: remediation` in the
pinned lifecycle blueprint. Each wait node also declares a `handoff-template`
with a repository-relative Markdown path and exact Git blob hash. Heddle reads
the pinned blob, retains it under `refs/heddle/handoff-templates/<blob-hash>`,
and does not read the mutable working-tree file during session activation.
Heddle reconstructs completed wait-stage outputs in
recorded lifecycle execution order. A standard stage receives those prior
outputs. A remediation stage receives the latest review findings through the
canonical handoff assembler; review transcript data is not dispatched.

Handoff templates are schema'd Markdown artifacts in `handoff-templates/`.
Their YAML front matter declares the Heddle template schema, relationship,
format version, and either `standard` or `remediation`. Template bodies use
strict Nunjucks variables. Use `stableJson` for structured values and do not
use `random` or `date`; Heddle disables both filters and compares two renders.
The standard context supplies `task` and `handoff`, including the normalized
task contract, prior outputs, skill pointer, and persisted todo lists. The
remediation context supplies the same roots with canonical review findings in
the handoff. Raw board front matter is available only as display input under
`task`; normalized `handoff.taskContract` remains the machine authority.

Before dispatch, Heddle resolves the effective system prompt, prepends it to
the rendered handoff, and durably stores both the prompt and exact composed
Markdown document.
A missing variable, invalid template, pin or kind disagreement, invalid
identity, or nondeterministic render raises one stable
`handoff-render-failed` lifecycle-resolution attention entry. No timeout,
thread, or first-turn effect occurs. After T3 accepts the first turn, Heddle
records the effective prompt, exact rendered document, and task, instance,
session, stage, and thread identity in `session:activated`. Restart accepts
only an exact payload match and does not append or dispatch a second activation.

Isolated pinned T3 0.0.36 qualification found no accepted, preserved per-thread
MCP authentication-header configuration for Claude Code, Codex, or Cursor.
For these three drivers, Heddle therefore writes the correlation token exactly
once in the rendered Markdown identity front matter. It never writes the token
to the canonical JSON projection or Markdown body. Do not add a second token,
copy it into template content, or configure an unmeasured driver. A driver
outside this set fails before dispatch. Treat the rendered handoff as secret
material because its identity front matter contains the token.

The console lifecycle source is a read-only projection over this composition's
canonical persistence. It resolves the task through the durable reconciler
runtime and instance records, reads the blueprint from the pinned Git blob, and
replays Flowcraft history in the execution ID order stored by the lifecycle
context. One global cursor covers the complete ordered history. A missing
production runtime or instance returns unavailable; it does not synthesize an
identity or substitute working-tree blueprint content.

The console attention source projects the current unresolved durable queue
through the same reconciler runtime records. Those records supply task scope;
the source does not infer a task from an attention message or instance-name
shape. Escalation entries offer the exact recorded option IDs. Approval entries
offer accept and reject. User-input entries preserve the recorded question,
optional header, selection mode, option labels, and descriptions; T3 option
labels are the submitted answer values. Stale, terminal, and lifecycle
adjudication entries remain informational. Missing or inconsistent runtime,
request, question, or durable identity fails closed.
Pushover deep links use the same runtime-derived task scope; notification
routing does not parse instance names.

Subagent spawn, liveness, and stop steering use the same SQLite instance store,
global correlation-token catalog, pacing evaluator, stage-session bootstrap,
and observation loop. Active child assignments join the production observation
inventory. A child reuses the task branch and worktree, while its provider and
model remain the explicit delegated selection. The durable todo assignment is
the only subtree and child-session authority.

The scheduler starts with one immediate pass and then uses the configured
cadence. Ticks coalesce while a pass is active; passes never overlap. Stop
cancels the owned timer, refuses new passes, drains the current pass, and fails
within the configured bound if the pass cannot drain.

Attention and notification delivery use the stable attention ID from the
accepted lifecycle or escalation contract. SQLite stores attention and adapter
intent and completion records. Reusing an attention ID with a different payload
fingerprint fails closed as a durable-identity disagreement. A restart replays
an unfinished escalation route without adding a second attention entry. The
current console catalog lists only unresolved attention.
An accepted disposition performs its canonical effect before marking the entry
resolved. The resolved record remains durable so the same stable ID cannot raise
a second entry after restart. The production action port records the exact action
and answers as durable intent before effect. It delegates only to
`EscalationCoordinator.answerAsOperator`, `SessionObserver.answerApproval`, or
`SessionObserver.answerUserInput`. T3 dispatch uses the stable attention ID as
its command identity. Before retry, Heddle reconciles the exact intended request,
approval decision, or user-input answers against authoritative T3 resolved
activity history. A matching outcome completes locally without a second
response; a different outcome fails closed. Heddle approval `reject` maps to T3
provider decision `decline`. Completion is durable before queue resolution;
failure keeps the entry unresolved, and changing a pending action or answer
fails closed.
Pushover transport is an explicit port so qualification can use a synthetic
transport. Routine operation uses `HttpPushoverTransport`. The Pushover message
API has no idempotency or outcome-reconciliation key. Delivery is at-least-once:
Heddle records intent before the HTTP request and retries pending intent after
restart so operator attention is not lost. A process crash after Pushover
accepts the request but before Heddle records completion can produce one
duplicate per ambiguous attempt. Durable completion suppresses later replay.
The stable attention ID remains the local outbox and console deep-link identity;
the HTTP transport does not represent it as provider deduplication.

Qualification uses generated boards, repositories, state directories,
worktrees, and synthetic notification transport. It does not use the shared
board, the live T3 server, ambient T3 state, or live Pushover.
