---
relationships:
  implements: heddle
  references:
    - t3-headless
    - t3-session-visibility
---

# Production composition

One production composition owns one workspace. Construct it with
`createProductionComposition`, supply it to `startHeddleServerFromEnvironment`,
and use the same composition for the server, console, MCP endpoint, scheduler,
attention queue, repository blueprint editor, and persistence lifetime. The
editor is the accepted `BlueprintArtifactEditor` over the same repository root
and mechanical effect registry as the lifecycle engine. The factory rejects a
second live composition for the same board directory.

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
Pushover routing. Secrets enter the
in-memory configuration from the operator's secret source and are not stored in
the repository. The configured pacing `defaultProvider` must equal the session
`driver` used for top-level lifecycle stages. Delegated subagents carry their
explicit provider and model through the same pacing evaluator and T3 provider
preconditions.
T3, Pushover API, and console endpoints must be absolute HTTP or HTTPS URLs;
the runtime validator and configuration schema reject other schemes.

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

The provider-usage source and session-capable T3 adapter are explicit runtime
ports. The T3 adapter must apply the accepted Codex or Claude MCP timeout before
thread creation. Heddle fails session start when this port is absent for either
provider. An in-progress epic gets one T3 project titled
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
Agent wait nodes declare `handoff: standard` or `handoff: remediation` in the
pinned lifecycle blueprint. Heddle reconstructs completed wait-stage outputs in
recorded lifecycle execution order. A standard stage receives those prior
outputs. A remediation stage receives the latest review findings through the
canonical handoff assembler; review transcript data is not dispatched.

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
