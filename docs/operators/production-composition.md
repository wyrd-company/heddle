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

## Dev Container Feature distribution

Install the service with the versioned Feature reference
`ghcr.io/wyrd-company/heddle/heddle:1`. The `wyrd-company/heddle` collection
namespace follows the source repository identity, and `heddle` is the Feature
ID. The major-version reference accepts compatible Feature updates while the
Feature manifest retains the complete semantic version.

The repository source at the publishing head is the Heddle installation source
of truth. Publication stages the tracked package, TypeScript, viewer, binary,
and schema inputs inside the Feature. `install.sh` installs locked development
dependencies, builds those inputs, and creates the private npm package locally
inside the Feature installation. It does not download a Heddle npm package or
release archive. The public GHCR Feature and public npm dependencies need no
application credential. The repository workflow alone receives package-write
access through its scoped `GITHUB_TOKEN` to publish the Feature.

`task deployment:qualification` dry-publishes the same staged collection to an
isolated local OCI registry and replaces only the registry portion of the
checked-in remote reference. The Dev Container CLI then resolves and installs
that reference in a clean container. `task deployment:package` checks the OCI
Feature archive without exercising registry resolution; it is not the remote
installation proof.

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

This complete single-product example uses one provider alias and no provider
budget, so it omits the provider-usage executable:

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
  maxConcurrentSessions: 2
  providerBudgets: {}
  subagents:
    maxDepth: 2
    maxFanOut: 2
  usageWindowHours: 5
providerAliases:
  primary:
    providerDisplayName: Workbench Alpha
    model: model-alpha
products:
  - name: Sample collection
    repos:
      - name: sample-repository
        repositoryRoot: /workspaces/sample-repository
pushover:
  apiUrl: https://notify.example.invalid/messages
  applicationToken: replace-with-operator-secret
  consoleBaseUrl: https://console.example.invalid/
  recipientLabel: Primary operator
  userKey: replace-with-operator-secret
server:
  host: 127.0.0.1
  port: 3774
session:
  baseRef: main
  defaultProviderAlias: primary
  defaultRuntimeMode: auto
  interactionMode: default
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
worktree root, reconciliation cadence, bounded stop timeout, provider aliases,
provider pacing, session defaults, observation and per-stage staleness
thresholds, and Pushover routing. The server port is a fixed integer from 1
through 65535. T3
and Pushover secrets enter only through operator-owned
`config.yml`; Heddle does not log, emit, or persist them. Every lifecycle and
delegated session resolves an allowed alias before it enters pacing or T3.
T3, Pushover API, and console endpoints must be absolute HTTP or HTTPS URLs;
the runtime validator and configuration schema reject other schemes.

## Provider and session selection

`providerAliases` is the operator-owned allowlist. An alias matches
`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`, is at most 64 characters, and contains
exactly `providerDisplayName` and `model`. Both values are nonempty strings.
`providerDisplayName` is the exact, case-sensitive display name from the T3
provider catalog. `model` is the exact, case-sensitive T3 model slug. It is not
a model display name or model alias.

Heddle reads `ServerConfig.providers` through T3's authenticated
`server.getConfig` WebSocket RPC. It sends the configured bearer token to
`POST /api/auth/websocket-ticket`, changes `http` to `ws` or `https` to `wss`,
connects to `/ws?wsTicket=<ticket>`, performs one bounded RPC, and
closes the connection. The WebSocket ticket is short-lived. T3 accepts ticket
reuse until expiry or parent-session revocation. Heddle never reuses the ticket
and never persists or logs it.
The control token needs `orchestration:read`, the same read scope used for the
orchestration shell. Heddle discards the rest of the returned configuration. It
keeps these values distinct:

| Value                 | Authority and use                                      |
| --------------------- | ------------------------------------------------------ |
| provider alias        | Heddle authorization and operator configuration        |
| provider display name | T3 catalog matching and operator diagnostics           |
| provider instance ID  | T3 routing and pacing identity                         |
| driver kind           | T3 capability metadata and optional launch preparation |
| model slug            | T3 dispatch model identity                             |

A missing or malformed ticket, failed or malformed RPC, or response without a
provider catalog is `provider-catalog-unavailable`. Heddle does not include
transport details or returned configuration payloads in that selection error.

Startup validates and resolves every alias, `session.defaultProviderAlias`, and
each `pacing.providerBudgets` key against one catalog snapshot. A selectable
provider has one exact display-name match and is available, enabled, installed,
and `ready`; its model catalog contains the configured slug. Providers without
a display name cannot be selected. Duplicate display names are ambiguous.
Startup fails before the server binds when this authority is invalid or the
catalog cannot be read.

New stage occurrences, new subagent assignments, and `list_providers` use a
fresh catalog snapshot. Selection failures use one of these safe reasons:
`provider-catalog-unavailable`, `provider-alias-not-allowed`,
`provider-name-not-found`, `provider-name-ambiguous`,
`provider-unavailable`, or `provider-model-not-found`. No failure tries another
alias, provider, or model. A T3 rejection after resolution is reported as that
T3 failure and also has no fallback.

Task front matter can override provider selection with this exact optional
scalar field:

```yaml
provider-alias: specialist
```

A wait node in a lifecycle blueprint can declare these exact optional fields:

```yaml
provider-alias: reviewer
runtime-mode: full-access
```

Effective provider selection is task `provider-alias`, then wait-node
`provider-alias`, then `session.defaultProviderAlias`. Only absence falls
through. A present null, empty, non-string, malformed, or unknown alias is an
error with no fallback. Mechanical nodes cannot declare these fields. Tasks
cannot override runtime mode. Effective runtime mode is wait-node
`runtime-mode`, then `session.defaultRuntimeMode`.

Runtime mode is independent from provider selection. Heddle uses T3's exact
vocabulary: `approval-required`, `auto-accept-edits`, `auto`, and
`full-access`. `full-access` is selectable for every configured provider and is
forwarded unchanged. It is not mandatory; the operator chooses the default.

Heddle stores one resolved session binding before worktree creation, timeout
preparation, MCP registration, thread creation, or first-turn dispatch.

The binding records the session and occurrence identity, selected alias,
display-name snapshot,
provider instance ID, open driver kind, observed provider CLI version, model
slug, runtime mode, and interaction mode. It contains no provider setting or
credential. Dispatch, observation, steering, stop, retry, restart, and a cold
replacement thread for the same occurrence use this binding. A configuration,
task, blueprint, catalog, provider-display-name, or alias change cannot retarget
an existing occurrence. If T3 can no longer use the bound provider or model,
the session fails visibly. A new stage occurrence or subagent assignment makes
a new selection.

SQLite stores a top-level binding with its stage-session runtime row and a
delegated binding with its todo assignment. The binding and session identity
are immutable after publication. A pre-release state directory that contains a
stage-session row without a binding cannot start recovery; clear that isolated
state directory and restart Heddle.

The existing instance runtime response includes a sorted `sessionBindings`
array for each instance. Each entry contains only `sessionKey`, `threadId`,
`alias`, `providerDisplayName`, `providerInstanceId`, `driverKind`,
`observedCliVersion`, `modelSlug`, `runtimeMode`, and `interactionMode`. This is
the operator-safe projection used to diagnose routing. It never contains T3 or
provider credentials, provider settings, correlation tokens, or handoff
content.

The observed provider CLI version is evidence, not a Heddle compatibility pin.
T3 owns provider discovery, driver support, CLI authentication, CLI
compatibility, and launch wrappers. Heddle pins the deployed T3 application
version separately in `deployment/supported-versions.json`. Adding a T3 driver
or upgrading a provider CLI does not require a Heddle driver-name or CLI-version
allowlist change.

The MCP `list_providers` tool accepts an empty object and returns version 1 of
the current allowed view:

```json
{
  "version": 1,
  "aliases": [
    {
      "alias": "primary",
      "providerDisplayName": "Workbench Alpha",
      "driverKind": "sample-driver",
      "model": {
        "slug": "model-alpha",
        "name": "Model Alpha",
        "isCustom": false
      },
      "selectable": true,
      "reason": null
    }
  ],
  "runtimeModes": [
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access"
  ]
}
```

Rows are sorted by alias. The tool returns only configured aliases and their
configured provider and model. It does not expose provider instance IDs,
credentials, provider settings, or T3 browser and desktop visibility
preferences. A configured alias that is not currently selectable remains in
the result with `selectable: false` and one safe selection reason. A catalog
read failure fails the tool. This result is discovery, not a reservation;
`spawn` resolves again.

The MCP `spawn` tool accepts this strict input:

```json
{
  "operationId": "operation-alpha",
  "rootItemId": "item-alpha",
  "providerAlias": "specialist",
  "runtimeMode": "full-access"
}
```

`providerAlias` is required and must be configured. `runtimeMode` is optional;
when absent, `session.defaultRuntimeMode` applies. A child does not inherit its
parent's provider or runtime mode. An invalid or nonselectable choice creates no
todo assignment, pacing reservation, timeout effect, MCP registration, or T3
thread. `operationId` is the replay-safe request identity. `rootItemId` names
the requested todo-subtree root, and Heddle accepts it only within the caller's
todo authority. The shared pacing gate evaluates an accepted request and can
return a bounded deferral. A successful spawn returns the child assignment and
records its resolved session binding.

Qualification uses an isolated recipe-catalog board, packaged Heddle service,
and pinned T3 release. Configure distinct default, execution, review, override,
and delegated aliases, including two aliases for one provider instance. Prove
the default, wait-node, and task-front-matter precedence paths; then call
`list_providers` and `spawn` from a real parent agent to create a child on a
different provider. Claude Code, Codex, Cursor, Grok, and OpenCode must each run
a stage and delegated child, invoke a real Heddle MCP tool, and perform a benign
command and file action in explicit `full-access` without an approval prompt.
Steer parent and child, restart Heddle, replace one missing thread cold, and
confirm that stored bindings and provider-instance pacing remain unchanged
after alias, display-name, task-front-matter, and default changes. Record exact
Heddle, Blueprints, T3, provider CLI, and model provenance without credentials.
Ambiguous, unavailable, unknown, and forbidden selections must produce the
documented no-effect error with no fallback. A skipped native driver leaves the
qualification incomplete.

## Organization blueprint repository

Clone the organization's blueprint repository into
`<HEDDLE_CONFIG>/blueprints` before service startup. The directory must be the
exact root of a Git worktree, and its current branch must track `origin`.
Provision the service user with a forwarded SSH agent socket or a scoped deploy
key that can fetch and push that repository. Heddle stores no Git credential in
`config.yml`, logs, attention payloads, or instance state. The supported
service-user SSH-agent path is qualified with `git push --dry-run` to a unique
scratch ref; the dry run leaves no remote ref.

Each lifecycle blueprint must declare a `board-statuses` object whose keys are
the `uses` values of its mechanical nodes and whose values are statuses from
the live board configuration. Heddle rejects a missing mechanical key, an
unknown mechanical key, or an absent live-board status before it performs a
mechanical effect or writes a board status. The diagnostic names the invalid
mechanical use and, for a missing live status, the selected status.

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
fails when a node's pinned handoff-template commit and path or named todo
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

The provider-usage source and session launch-preparation catalog are distinct
explicit runtime ports. A nonempty `pacing.providerBudgets` requires top-level
`providerUsage`; an empty budget catalog forbids it. Its absolute executable is
started without a shell, receives one version-1 JSON request on stdin containing
the resolved provider instance ID and fixed five-hour window, and must return
exactly one version-1 JSON response with finite nonnegative `used` and a
nonnegative safe-integer `windowStartedAt`. The configured timeout bounds
execution and response output. The executable owns usage-service
authentication; no credential belongs in its arguments or Heddle output.

Provider budgets are keyed by configured alias for operator readability. At
startup, Heddle resolves those keys and applies limits by provider instance ID.
All aliases for one instance consume the same usage and concurrent-session
capacity. If two aliases for one instance declare different limits,
configuration is invalid. Omitting a second alias does not give that alias an
unbudgeted route to the instance.

`session.launchPreparation` is an optional map keyed by the exact open T3 driver
kind. A key is a 1–64 character `ProviderDriverKind` slug: it starts with a
letter and contains only letters, digits, `-`, and `_`. Each configured entry is
a separately preflighted absolute executable. It receives the accepted
timeout-consumer input, including the resolved driver kind and provider instance
ID, as one version-1 JSON request and must return exactly
`{"version":1,"applied":true}`. Heddle invokes it before `thread.create` and
fails closed on process, timeout, output, or acknowledgement errors. An entry
accepts optional `arguments`. Its bounded `timeoutMilliseconds` defaults to 10000.

Heddle terminates failed or timed-out children and does not expose their output.
The production catalog configures Codex with
`tool_timeout_sec = 100000` and Claude Code with
`MCP_TOOL_TIMEOUT=100000000` milliseconds. A driver without a configured entry
skips this Heddle-specific preparation; it is not rejected by a Heddle roster.
The map key selects preparation only; the resolved provider instance ID still
routes the T3 thread. T3 owns provider CLI authentication and launch
configuration.

For example, a production timeout-preparation catalog can contain:

```yaml
session:
  launchPreparation:
    claudeAgent:
      executable: /opt/heddle/bin/configure-claude-timeout
      timeoutMilliseconds: 10000
    codex:
      executable: /opt/heddle/bin/configure-codex-timeout
      timeoutMilliseconds: 10000
```

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

Agents create findings and follow-ups through Heddle's MCP tools. Heddle records
the source task, instance, session, kind, parent epic, lifecycle, operation
digest, record digest, and request before it writes the board task. Startup
recovers pending records before reconciliation. A board tag is evidence only;
it cannot authorize execution.

An incomplete non-UAT child can run while its epic remains in `uat` only when
the live task exactly matches one completed Heddle-owned creation record. Heddle
also requires every UAT child to be done on the board, to have exactly one
retained top-level runtime whose state and mirrored board status are `done`, and
to have no nonterminal delegated instance. Trusted work waits without attention
while UAT is active. A done UAT card without the required runtime proof raises
one stable `uat-terminal-unverified` attention and admits no dynamic work.

Missing or conflicting creation authority leaves the child unchanged and keeps
one stable epic-scoped delivery attention. A mixed set still admits each exact
trusted child. Move the epic to `in-progress` to admit untrusted delivery work,
or remove or re-parent work that is not part of the epic. All direct children,
including follow-ups created by other follow-ups, remain completion gates. When
all work is done, Heddle completes the epic without starting another UAT
lifecycle.

Heddle Console status controls use the same per-epic ordering boundary as
dynamic creation, recovery, admission, start reservation, and completion. A
Console pause before admission prevents promotion. A pause after promotion but
before the durable start reservation prevents dispatch. A reservation that
wins first continues under the normal in-flight pause rule. Direct `kanban-md`
status writes are outside this boundary because the board has no compare-and-set
operation. Heddle observes them on a later read, so a direct pause can lose one
race to an admission decision that already reserved a start. Use the Console
control when this ordering matters.

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
with a repository-relative Markdown path and exact Git commit SHA. Heddle reads
the entry file and `handoff-templates/includes/` files from that commit in the
organization blueprint clone, retains the commit under
`refs/heddle/handoff-templates/<commit-sha>`, and does not read mutable
working-tree files during session activation. Product repositories receive no
template-retention refs.
An agent wait node can also declare `skills: [<name>, ...]`. Each name must be
unique, kebab-case, and no longer than 64 characters. Heddle reads
`skills/<name>/SKILL.md` from the same
pinned commit as the handoff template, requires the front-matter `name` to
equal the folder name, and requires a `description` of 1 to 1,024 characters.
Known optional Agent Skills fields are validated when present: `license` and
`allowed-tools` are non-empty strings, `compatibility` contains 1 to 500
characters, and `metadata` maps string keys to string values. Valid YAML
extension fields, including top-level `relationships`, do not prevent loading
and are not exposed to the handoff template. The handoff
stage carries the names. Templates resolve one with the `skill(name)` global,
which returns `{name,path,description}` with a repository-relative path. This
blueprint declaration supplies generic stage skills. A task's front-matter
`skills` map remains an independent per-task override.
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
record one `verdict: accepted` event for that captured basis. When the accepted
source and base heads are equal, Heddle closes the PR as integrated with the
base branch and exact head as closure evidence; it does not invoke gitpr's
strict fast-forward merge. Otherwise Heddle invokes gitpr's separate merge
operation. Heddle accepts completion only from `state: merged` with the exact
accepted event and branch identities, or from `state: closed` with an exact
equal-head accepted event and matching integrated closure evidence. Cleanup
removes the worktree and task branch only while the retained review evidence,
clean worktree, and task branch head still agree. Merged reviews require base
ancestry; closed equal-head reviews require the live base to remain at the
exact reviewed head.

Handoff templates are schema'd Markdown artifacts in `handoff-templates/`.
Their YAML front matter declares the Heddle template schema, relationship,
format version, and either `standard` or `remediation`. Template bodies use
strict Nunjucks variables. Use `stableJson` for structured values and do not
use `random` or `date`; Heddle disables both filters and compares two renders.
Templates can include pinned partials with the full repository-relative form
`{% include "handoff-templates/includes/<path>" %}`. An include path cannot
escape that directory. Nunjucks `extends`, `import`, and `from ... import`
directives are not supported in entry files or included files.
The standard context supplies `task` and `handoff`, including the normalized
task contract, prior outputs, stage skill names, skill pointer, and persisted todo lists. The
remediation context supplies the same roots with canonical review findings and
the typed remediation cause in the handoff. Raw board front matter is available only as display input under
`task`; normalized `handoff.taskContract` remains the machine authority.

Before dispatch, Heddle resolves the effective system prompt, prepends it to
the rendered handoff, and durably stores both the prompt and exact composed
Markdown document.
A missing variable, invalid template or pinned skill, pin or kind disagreement, invalid
identity, or nondeterministic render raises one stable
`handoff-render-failed` lifecycle-resolution attention entry. No timeout,
thread, or first-turn effect occurs. After T3 accepts the first turn, Heddle
records the effective prompt, exact rendered document, and task, instance,
session, stage, and thread identity in `session:activated`. Restart accepts
only an exact payload match and does not append or dispatch a second activation.

Pinned Wyrd Company T3 fork 0.0.37-wyrd.2 supplies authenticated per-thread MCP
registration through each of its provider adapters. Heddle derives
the workflow MCP endpoint from the configured server host and port, then sends
that endpoint and the session's bearer correlation token to
`PUT /api/mcp/provider-session` before thread creation. T3 supplies the
registration through the selected adapter's native launch path. No
Heddle-specific provider roster or MCP configuration file is required. The
rendered handoff contains no token. A new T3 driver needs no Heddle name or
version allowlist entry; an adapter that cannot accept the MCP registration
fails at the T3 boundary.

The workflow MCP handler negotiates protocol 2025-11-25 or older. It advertises
no Tasks capability and returns ordinary tool results, not
`InputRequiredResult`. Session preparation applies the optional
launch-preparation entry for the bound driver kind before registration. The
Heddle `escalate` tool remains available through this MCP registration for every
provider. It is independent from a provider's native question tool, which T3
owns and records as user-input state.

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

The board and dependency graph URL `scope` accepts `all` or `epic:<id>`. Their
scope control lists All work and root epics. A lifecycle URL carries its target
as `task=<id>` and retains the board scope, so BOARD and DEPENDENCIES return to
the same projection. New task-scoped attention links use
`?view=lifecycle&task=<id>&scope=all&attention=<attention-id>`. Production
Console and Pushover link generators do not emit `scope=task:<id>`. The client
accepts a positive `scope=task:<id>` URL as compatibility input and normalizes
it to the lifecycle for that task with `scope=all`. All-work and epic attention
links retain their scope-shaped routes.

The console attention source projects the current unresolved durable queue
through the same reconciler runtime records. Those records supply task scope;
the source does not infer a task from an attention message or instance-name
shape. Escalation entries offer the exact recorded option IDs. Approval entries
offer accept and reject. User-input entries preserve the recorded question,
optional header, selection mode, option labels, and descriptions; T3 option
labels are the submitted answer values. Stale, terminal, and lifecycle
adjudication entries remain informational. Missing or inconsistent runtime,
request, question, or durable identity fails closed.
Pushover task links use the canonical split lifecycle route. Their task target
comes from an explicit attention scope or the same runtime-derived task scope;
notification routing does not parse instance names.

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
does not overlap or stop future cadence passes. The first failed pass starts a
numbered scheduler failure episode. Every later failure before one completed
pass belongs to that episode and appends its exact structured error to ordered
durable history. One episode has one active card, even when its errors differ;
the card keeps the first diagnostic and its stable ID ends in
`global:episode:<number>`.

**Resolve** acknowledges the active scheduler card for the latest durable
failed-pass sequence. If another pass fails in the same episode, Heddle reopens
that card and advances the action replay boundary. Replaying a completed Resolve
from an earlier sequence has no effect; Resolve from the current projection can
acknowledge the reopened card. One complete production pass is the only
recovery evidence: it appends the episode's recovery event and resolves every
active `scheduler-pass-failed` card, including a legacy error-fingerprint card. A
later failure starts the next episode with a new stable ID. The prior attention
rows and ordered failure and recovery events stay in SQLite for inspection and
do not return to the active catalog.

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
Set `pushover.recipientLabel` to a non-secret name the operator can recognize.
For each rejected occurrence, Heddle stores this label with the exact intended
message and displays both before it offers **Retry notification**. The public
attention API does not expose the Pushover user key, application token, or
internal notification stable ID. If either verification value is unavailable,
the card explains the missing verification and offers no Retry action. Adding a
label later can reconstruct details when the pending intent still supplies an
exact message; otherwise the historical occurrence remains actionless.
When one stable notification changes delivery-failure state, the newly raised
entry becomes its current projection and resolves only older
notification-delivery entries for that stable ID. A permanent rejection does
not leave earlier automatic-retry guidance visible. Other notification failures
and the original escalation or pageable attention remain unresolved.
The original escalation attention and unanswered questions remain unchanged.

A pending intent written by a version that stored only the combined message
fingerprint upgrades automatically when the current combined fingerprint still
matches. A mismatch cannot prove that only the application credential changed.
It performs no HTTP call and raises an exact
`legacy-intent-unverifiable` recovery occurrence. Retry notification is the
explicit disposition that adopts the current route; without it, ambiguous
legacy intent stays pending.
A pending intent from the immediately preceding two-fingerprint message shape
also upgrades in place when both stored fingerprints match the current message
without its level. A pending two-fingerprint task notification whose route is
the exact legacy `scope=task:<id>` form also upgrades to the canonical split
lifecycle route when its task identity, stable attention identity, and every
other fingerprint field match. Heddle then records the current level and route
in both fingerprints. Any other disagreement remains rejected.
Pushover receives escalations, every production error, and session-observation
attention of kind `ended`, `failed`, or `stalled`. The first two session states
are dead-session states. An incident-eligible production error is informational
and carries a deterministic incident identity for its later incident lifecycle.
A scheduler-pass or durable-catalog production error is a critical floor page:
its message states that no incident can be raised and that operator action is
required. While SQLite is available, Heddle durably limits one production-error
code to one page per minute and three page attempts in five minutes, even when
changing error text produces new attention identities. If a floor failure makes
SQLite unavailable, an in-memory window provides the same bound within the
current process; restarting Heddle resets that degraded-path window. Approval,
user-input, stale-instance, lifecycle, repository, and epic-acceptance attention
remain console-only. Configuration validation fails before production
composition exists, so it cannot produce an attention or dispatch an incident.
A pending production-error page is replayed before each scheduler pass. A
retryable page waits for its durable retry deadline, including across restart;
the durable attention remains active while earlier passes contain the delivery
failure.

Every production-error card offers **Resolve**. The action records durable
intent and completion before it resolves the entry. Repeating the action or
replaying it after a crash is safe. The resolved row remains in SQLite for
audit, while the active attention list and count no longer include it. Agents do
not use this action; incident-owned resolution has its own recorded authority.

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
