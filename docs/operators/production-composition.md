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

The service-user `PATH` must provide `git`, `gitpr`, and `kanban-md`.
Mechanical worktree preparation, review snapshots, review landing, and board
status mirroring invoke these tools without a shell. Startup does not replace
or infer their locations.

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

Open a running task's lifecycle view to inspect rebase availability. The view
reports `current` when the inspected upstream artifact is the pinned blob and
`available` when it is a different blob. An available target identifies the
newer blob and, while the instance is awaiting, offers that artifact's named
wait states. The view reports `upstream-target-unavailable` when the upstream
source or artifact path cannot be inspected. This state keeps the pinned
blueprint, instance identity, and ordered history visible and offers no rebase
action. A pinned artifact, persistence, identity, or history failure remains an
error instead of being reported as an unavailable target.

Select the intended state and use `REBASE INSTANCE`. Heddle re-reads the task,
instance, pinned blob, and upstream target blob before it calls the lifecycle
router. A successful action replaces the lifecycle view and reports the
selected state and new blob. A stale, unavailable-target, or rejected action
reports the error and leaves the instance pinned. Fetching a newer artifact
without using this action never moves the instance.

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
their project. A done epic also retains its project so its archived stage
threads remain available in T3's archive view. The durable `active` state means
that the project exists; it is not execution permission. A done epic's board
status blocks child dispatch. Project deletion requires a separate explicit
cleanup policy. A durable deleting or deleted record stays non-active across
restart and is not reseeded. Child task threads use the epic project.
Ad-hoc threads use `adHocProject.projectId`. Subagents reuse the parent's project
and worktree.

An epic in `uat` requires at least one child tagged `uat`. Without one, Heddle
raises one stable epic-scoped attention and keeps the epic in `uat`; it does not
create an acceptance task. Add the intended UAT child to the epic. A later
reconciliation pass resolves the current missing-child attention without
deleting its stable durable identity, promotes and dispatches that child, and
can complete the epic after acceptance. Removing the UAT child while the epic
remains in `uat` makes the same missing-child attention current again.

An epic in `uat` with an incomplete non-UAT child raises a separate stable
epic-scoped attention and remains in `uat`. Move the epic to `in-progress` to
admit that delivery work, or remove or re-parent work that is not part of the
epic. Reconciliation resolves the matching attention when no incomplete
delivery child remains or the epic leaves `uat`.

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
the pinned blob from the organization blueprint clone, retains it there under
`refs/heddle/handoff-templates/<blob-hash>`, and does not read the mutable
working-tree file during session activation. Product repositories receive no
template-retention refs.
Heddle reconstructs completed wait-stage outputs in
recorded lifecycle execution order. A standard stage receives those prior
outputs plus the persisted outputs of completed mechanical nodes on the path
from the preceding wait stage, including the review snapshot identity. A
remediation stage receives either the current review findings or a validated
review integration cause from the mechanical merge execution that entered that
remediation occurrence. The cause distinguishes review-basis drift from a
reviewed source that did not contain its target. It contains the snapshot,
source and target branches, reviewed source and base heads, and current source
and target heads. It directs the agent to rebase onto the named exact target
without a merge commit. Review transcript data is not dispatched. Missing or
malformed legacy cause data keeps the existing missing-findings attention and
empty list.

The review snapshot identity is a gitpr schema-2 PR ID plus the exact source
and base heads captured for review. The PR remains in `state: open` while review
events are recorded. A review-stage approve disposition authorizes Heddle to
record one `verdict: accepted` event for that captured basis and then invoke
gitpr's separate merge operation. Heddle accepts completion only from
`state: merged` with the exact accepted event and branch identities.

Handoff templates are schema'd Markdown artifacts in `handoff-templates/`.
Their YAML front matter declares the Heddle template schema, relationship,
format version, and either `standard` or `remediation`. Template bodies use
strict Nunjucks variables. Use `stableJson` for structured values and do not
use `random` or `date`; Heddle disables both filters and compares two renders.
The standard context supplies `task` and `handoff`, including the normalized
task contract, prior outputs, skill pointer, and persisted todo lists. The
remediation context supplies the same roots with canonical review findings and
the typed remediation cause in the handoff. Raw board front matter is available only as display input under
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

Pinned Wyrd Company T3 fork 0.0.37-wyrd.2 supports authenticated per-thread MCP
registration for Claude Code, Codex, Cursor, Grok, and OpenCode. Heddle derives
the workflow MCP endpoint from the configured server host and port, then sends
that endpoint and the session's bearer correlation token to
`PUT /api/mcp/provider-session` before thread creation. T3 supplies the
registration through each driver's native launch path. No Heddle-specific MCP
configuration file is required. The rendered handoff contains no token. A
driver outside this measured set fails before worktree or T3 effects.

The workflow MCP handler negotiates protocol 2025-11-25 or older. It advertises
no Tasks capability and returns ordinary tool results, not
`InputRequiredResult`. Session preparation keeps the existing Claude Code and
Codex tool-timeout configuration; Cursor, Grok, and OpenCode need no separate
timeout setup.

The deployed `/api/events` feed is not a durable-state export. It omits the
payloads of `instance:created` and `instance:updated` records and structurally
validates each token-free `session:activated` identity front matter. An activation record that does
not match the canonical structure is served only as an unavailable marker.
After projection, Heddle checks the complete event result against the current
durable correlation-token catalog. A token in a generic event makes the read
unavailable instead of serving a partial history. Heddle applies the same check
to complete `/api/attention` and `/api/lifecycle` results because messages,
questions, and lifecycle outputs originate outside the console boundary. A
protected result returns HTTP 503 with only `Console data is unavailable`.
Resolve the source content through operator-controlled storage access; retrying
the console read does not remove or rewrite it. The SQLite event, attention,
and Flowcraft history remain exact for restart replay. Treat the stored
activation document and instance state as secret material.

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

Failures attributable to one task, epic project, lifecycle instance, or session
raise stable task-scoped attention and stop only that item. Later tasks, stale
checks, instance synchronization, and session observation continue in the same
pass. An unrouted epic and a live instance whose board task was deleted use this
path. Repeated cadence passes reuse the same attention ID while the failure
remains unresolved.

Flowcraft `lifecycle:attention-required` events enter the same durable queue.
Their persisted error data includes the node error and nested cause messages, so
the attention entry can diagnose a mechanical failure without source reading.
The bridge keys the entry by task, instance, and lifecycle transition; replay or
another cadence pass does not create another entry. The entry remains open while
that exact transition is pending and resolves after its successful retry.

A deferred or starting reconciler runtime can intentionally exist before its
lifecycle state. Synchronization does not report that interval as
`lifecycle-instance-absent`. If a matching stale entry exists, synchronization
resolves it when the lifecycle state appears. A running, waiting, or completed
runtime with no lifecycle state remains a production error.

A failure that cannot be attributed to one item aborts that pass. The scheduler
raises global durable attention and `heddle-server` writes one
`Heddle reconciliation pass failed` line to stderr with the error cause chain.
The immediate startup pass still fails service readiness; a later failed cadence
does not overlap or stop future cadence passes.

Attention and notification delivery use the stable attention ID from the
accepted lifecycle or escalation contract. SQLite stores attention and adapter
intent and completion records. Reusing an attention ID with a different payload
fingerprint fails closed as a durable-identity disagreement. Notification
identity keeps the logical recipient, message, title, deep link, and stable ID
separate from its application-credential attempt fingerprint. A changed
recipient still fails closed. A changed application credential can replace the
attempt fingerprint only after an exact rejected occurrence receives its Retry
notification disposition. A restart replays an unfinished escalation route
without adding a second attention entry. The current console catalog lists only
unresolved attention.

An escalation attention ID is `escalation:` plus a SHA-256 digest of the exact
instance, owner-session, and escalation identity tuple. The exact components
remain in the durable escalation event and console action contract. If replay
reports that a recorded attention identity exceeds the console bound, stop the
service and preserve the state directory. Restore a known-good state backup from
before that pending escalation, or hold the state for a purpose-built repair.
Do not delete or rewrite the event or attention row by hand; the pending event
still blocks its session from stopping.

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

The transport accepts only HTTP 200 with provider `status: 1` as completion.
Network failures, redirects, server failures, and malformed responses with a
non-4xx status are retryable. HTTP 4xx and a parsed HTTP 2xx response without
provider `status: 1` are permanent for the unchanged request. Permanent
categories are the allowlisted
`application-credential-rejected`, `recipient-rejected`,
`provider-quota-exceeded`, and `request-rejected`; classification inspects only
the HTTP status and the presence of documented response fields. Provider error
text, request identifiers, raw bodies, credentials, and device identifiers are
not persisted or emitted. These rules follow the Pushover Message API response
and retry contract at <https://pushover.net/api#response> and
<https://pushover.net/api#friendly>.

Each classified transport failure raises a task-scoped production-error entry
and is contained within that notification route. Pending routes after it and
main instance reconciliation continue in the same scheduler pass. A retryable
failure retains pending intent and a durable deadline at least five seconds
after the failed attempt completes. Earlier scheduler passes keep the scoped
failure visible without calling the provider; a pass at or after the deadline
can retry. A permanent rejection stores its safe category and occurrence and
performs no more HTTP calls until the operator repairs secure configuration,
restarts the service, and selects Retry notification on that exact occurrence.
The action authorizes recovery of that occurrence. Another permanent response
creates the next occurrence; a retryable response follows the durable deadline
without requiring another action.
The original escalation attention and unanswered questions remain unchanged.

A pending intent written by a version that stored only the combined message
fingerprint upgrades automatically when the current combined fingerprint still
matches. A mismatch cannot prove that only the application credential changed.
It performs no HTTP call and raises an exact
`legacy-intent-unverifiable` recovery occurrence. Retry notification is the
explicit disposition that adopts the current route; without it, ambiguous
legacy intent stays pending.
Pushover receives escalations and session-observation attention of kind
`ended`, `failed`, or `stalled`. The first two are dead-session states. Approval,
user-input, stale-instance, lifecycle, repository, production-error, and
epic-acceptance attention remain console-only.

Session observation and Pushover page delivery have separate production-error
entries. `session-observation-failed` means Heddle could not read the session
from T3. `session-page-delivery-failed` means observation succeeded but an
unclassified Pushover adapter effect failed. Classified retryable and permanent
notification failures use the scoped notification-delivery entries and recovery
rules above. No delivery entry replaces the original pageable attention. Its
durable Pushover intent remains pending under the same stable attention ID. A
completed effect does not send again.

Qualification uses generated boards, repositories, state directories,
worktrees, and synthetic notification transport. It does not use the shared
board, the live T3 server, ambient T3 state, or live Pushover.
