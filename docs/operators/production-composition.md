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
accepted `BlueprintArtifactEditor` over the worker's blueprint synchronization
checkout and the same mechanical effect registry as the lifecycle engine. The
factory rejects a second live composition for the same board directory.

## Package distribution

Heddle is published to npmjs as the public package `@wyrd-company/heddle`.
The package carries the built service, the console viewer bundle, the JSON
schemas, and the `heddle-server` and `heddle-cursor-agent` entry points. It
declares runtime dependencies only; `react`, `react-dom`, and `tldraw` are
compiled into the viewer bundle. The supported Node.js range is declared in
`engines` and is enforced by the Feature installer.

The package release workflow runs on a pushed `heddle@<version>` tag. It
builds the tree, verifies that the tag names the `package.json` version and
that the viewer bundle is in the packed file list, and publishes with npm
provenance. `heddle-feature@*` tags publish only the Feature. A baseline tag
`heddle@0.0.0` records release authority and does not publish.

## Command-line installation

An operator without a Dev Container installs the published package globally
and runs the service against an operator-owned configuration directory:

```console
npm install --global @wyrd-company/heddle@<version>
heddle-server --config /path/to/configuration
```

`heddle-server` requires the same configuration bundle, shared `blueprints`
source, and durable worker state directory that the Feature requires. The
conventional state directory is `/var/lib/heddle`; those contracts are in the
sections below.
`heddle-server --config <directory>
--print-launch-settings` prints the nonsecret state directory, host, and port
the service will use. The supported `kanban-md` fork recorded in
`deployment/supported-versions.json` must be on `PATH`; the Feature's service
launcher checks that version before each start, and a command-line operator
owns that check. `better-sqlite3` installs from a prebuilt binary; a platform
without a matching prebuild needs a compiler toolchain on the command-line
path, which the Feature does not provide.

## Dev Container Feature distribution

Install the service with the versioned Feature reference
`ghcr.io/wyrd-company/heddle/heddle:0`. The `wyrd-company/heddle` collection
namespace follows the source repository identity, and `heddle` is the Feature
ID. The major-version reference accepts compatible Feature updates while the
Feature manifest retains the complete semantic version. The Feature source is
`features/heddle/` in the repository.

The Feature and Heddle package are independent release units. The Feature's
`version` option selects the Heddle package version installed from
`npmRegistry`, which defaults to `https://registry.npmjs.org`. The default
`latest` installs the registry's current `latest` dist-tag on every build, so
a rebuild can move to a newer Heddle without a Feature change. An exact SemVer
version installs that version on every build; pin one when a workspace must
be reproducible. An https URL or absolute path in `packageSource` bypasses the
registry. `packageSha256` optionally binds the tarball to a hexadecimal
SHA-256 digest before installation, whichever source supplied it.

The published Feature contains no Heddle source and no Heddle package tarball.
Installation fetches the exact package tarball with `npm pack`, verifies the
optional digest, resolves the `better-sqlite3` prebuild, and installs only
runtime dependencies. Resolution, download, digest, and native-prebuild
failures stop before service registration and name the cause. The target gets
no compiler or source-build fallback.

`task deployment:qualification` packs the built tree, serves it from an
isolated local npm registry as the only published version and as `latest`,
dry-publishes the source-free Feature collection to an isolated local OCI
registry, and replaces only the registry portion of the checked-in remote
reference. It proves a failed download, a digest mismatch, a missing registry
version, and a missing native prebuild each stop before service registration.
It then installs the Feature at the default `latest`, verifies that the
installer requests no Python or compiler packages and uses no native
source-build fallback, proves that the installed service answers its configured
endpoint, rebuilds at the exact package version, and proves persisted state
replays.
`task deployment:package` checks the OCI Feature archive without exercising
registry resolution; it is not the remote installation proof.

## Configuration directory

`--config <directory>` selects one configuration bundle. Without that argument,
`HEDDLE_CONFIG` selects it; the default is `/home/vscode/.heddle`. The bundle
contains required shared core settings in `config.yml`, optional worker
overrides in `worker.yml`, and the organization blueprint clone. A worker with
no differences has no `worker.yml`.

An empty, comment-only, or root-level `null` `worker.yml` is treated as no
override layer. Root-level clearing is not supported; use field-level `null`
values when a worker must clear an inherited optional value.

Heddle layers built-in defaults, `config.yml`, then `worker.yml`, and validates
the effective result. Objects and maps merge by key. Arrays replace the whole
inherited array so provider fallback and executable argument order cannot change
by concatenation. A YAML `null` restores the built-in value when one exists; it
otherwise removes the inherited optional value. For example,
`pacing.providerBudgets: null` restores the built-in empty map and
`adjudication: null` disables inherited adjudication. An empty map only merges
no entries; it does not clear inherited map entries.

The built-in worker conventions are:

| Effective field              | Built-in value                             |
| ---------------------------- | ------------------------------------------ |
| `adHocProject.workspaceRoot` | `/workspaces`                              |
| `boardDirectory`             | `/workspaces/kanban`                       |
| `pacing.usageWindowHours`    | `5`                                        |
| `pushover.apiUrl`            | `https://api.pushover.net/1/messages.json` |
| `server.port`                | `3774`                                     |
| `session.worktreesRoot`      | `/workspaces/worktrees`                    |
| `stateDirectory`             | `/var/lib/heddle`                          |
| `t3.baseUrl`                 | `http://127.0.0.1:3773`                    |

Each conventional field remains an optional source setting within its validated
domain; `pacing.usageWindowHours` still accepts only `5`. Heddle always binds
its listener to `127.0.0.1`; `server.host` is not a configuration field. Keep
`pushover.apiUrl` at its built-in value for Pushover. Set it only for an
explicit test or proxy endpoint. `pushover.consoleBaseUrl` remains a separate,
public console link and is not the message API endpoint. Each worker has its
own T3 server, so the T3 default names that worker's local server.

These defaults do not make credentials, provider choice, incident authority,
or the remaining lifecycle settings optional. Project identity is generated at
runtime and persisted before Heddle creates the project. Existing durable state
remains authoritative across restart.

Both source files are read-only inputs. A missing `config.yml`, an unreadable
present `worker.yml`, invalid YAML, or an invalid effective value fails before
composition or network bind. Errors name the source file and JSON-pointer field
while redacting configured T3 and Pushover secrets.

The loopback server port must be from 1 through 65535; an ephemeral port cannot
be projected into the fixed Caddy upstream.

After validation, the service binds the configured loopback endpoint before it
constructs or starts the production composition. The bound endpoint returns
`503 Service Unavailable` until composition startup completes. A bind failure
therefore leaves the board, T3, Pushover, and production persistence untouched.

The layered effective configuration is the sole deployed runtime authority.
`HEDDLE_BOARD_PATH`, `HEDDLE_HOST`, `HEDDLE_PORT`, and `HEDDLE_STATE_PATH` do not
affect deployed configuration. Configuration changes require service restart.
Heddle does not write, migrate, or reformat either source. The operator owns the
bundle and must make both source files readable only by that account, normally
mode `0600`.

Configuration ownership is independent from mount ownership. The built-in
board, state, worktree, and local T3 paths are the same in every worker. Each
container can bind a different host source at those in-container paths and
runs its own T3 server. Shared core or `worker.yml` overrides a path only when
the in-container path differs; it does not repeat a path merely because the
mounted data is worker-local.

`heddle-server --print-effective-configuration` prints the effective values,
their source provenance and explicit clears as JSON. T3 and Pushover credential
values are replaced with `[REDACTED]`. This command performs the same parsing,
layering, validation, executable preflight and blueprint preflight as service
startup, but does not bind a network endpoint, create worker state, or start
production work.

The directory may also contain `heddle.md` and the required shared organization
blueprint source at `blueprints/`. Unknown entries are ignored. Neither entry is
a configuration field.

The service-user and agent-session `PATH` must provide `git`, `gh`, `gitpr`,
and `kanban-md`.
Mechanical worktree preparation, review snapshots, review landing, and board
status mirroring invoke these tools without a shell. Incident finalization uses
`gh` as the authenticated bot identity for an accepted GitHub issue. Startup
does not replace or infer their locations.

This minimal shared `config.yml` uses the worker conventions, one
single-candidate provider alias, and no provider budget, so it omits both the
conventional values and the provider-usage executable:

```yaml
cadenceMilliseconds: 60000
adjudication:
  approvalSettlementMilliseconds: 60000
  policyPath: adjudication/policy.json
  providerAlias: adjudicator
observationThresholds:
  endedMilliseconds: 60000
  failedMilliseconds: 60000
  stalledMilliseconds: 60000
incident:
  approvalSeverityThreshold: high
  failureThreshold: 3
  githubIssueRepository: sample-owner/sample-repository
  immediateEscalationCodes: []
  retryDelayMilliseconds: 60000
  workspaceRoot: /workspaces/sample-workspace
pacing:
  maxConcurrentSessions: 2
  providerBudgets: {}
  subagents:
    maxDepth: 2
    maxFanOut: 2
providerAliases:
  adjudicator:
    - providerDisplayName: Workbench Alpha
      model: model-capable
  primary:
    - providerDisplayName: Workbench Alpha
      model: model-alpha
pushover:
  applicationToken: replace-with-operator-secret
  consoleBaseUrl: https://console.example.invalid/
  recipientLabel: Primary operator
  userKey: replace-with-operator-secret
session:
  baseRef: main
  defaultProviderAlias: primary
  defaultRuntimeMode: auto
  interactionMode: default
  skillPointer: skill://sample
stageThresholds:
  implement: 900000
  review: 900000
stopTimeoutMilliseconds: 10000
t3:
  accessToken: replace-with-operator-secret
```

A worker file contains only differences. This one binds its local T3
credential while disabling core adjudication and provider budgets. It uses the
conventional board, state, worktree, and local T3 paths because those paths
have worker-local mounts inside this container:

```yaml
adjudication: null
pacing:
  providerBudgets: null
providerUsage: null
t3:
  accessToken: replace-with-worker-secret
```

The optional `adjudication` block enables the top-level escalation tier.
`providerAlias` must name an entry in `providerAliases` and can select a model
independently of lifecycle stages. `policyPath` names the decision-boundary
artifact in the organization blueprint repository. Heddle pins that artifact's
Git blob for each escalation occurrence. Adjudication uses approval-required
runtime mode and the session interaction mode. It counts against
`pacing.maxConcurrentSessions` and the selected provider's usage budget. A
pacing denial routes the original question to the operator instead of parking
it.

`approvalSettlementMilliseconds` optionally sets how long a sanctioned tool
approval may remain pending after Heddle durably issues its response. It
defaults to `60000`. Request age does not consume this interval: a request first
observed after a long delay still receives the full settlement interval after
Heddle answers it. The issuance record is keyed by the adjudication session,
T3 thread, and request occurrence, and survives service restart. Reconciliation
reuses its command identity and starting time until T3 records the resolution
or the interval expires. A sanctioned approval activity anywhere in retained
thread history without a usable request identity permanently taints and
abandons that adjudication thread and occurrence: no later resolution can be
correlated to the malformed activity. It reports `Adjudication tool approval
request has no usable identity`. Later well-formed activity, reconciliation,
and restart do not clear the taint. Invalid retained response-issuance evidence
abandons adjudication as
`Adjudication approval response issuance evidence is invalid`. Both conditions
move the escalation to operator attention without answering an approval or
including the malformed durable payload in the cause. Reconciliation and
restart retain the same attention occurrence and cause.

Configuration conforms to `schemas/production-configuration.json`.
`adHocProject` declares the absolute workspace root and an optional worker label
for tasks outside an epic. Heddle also uses that workspace root to resolve each
task-declared repository name as
`{adHocProject.workspaceRoot}/tools/{repository}`. Heddle reconciles the shared
project at startup. On first use, it generates a UUID, records the complete
identity before external effects, and creates the project in the control plane.
The conventional title is `Heddle · ad-hoc work`; when `label` is present, the
title is `Heddle · ad-hoc work · {label}`. A label change updates only the title
through a durable, replayable revision. It never changes the project ID.

Heddle reuses an existing SQLite project identity after restart and recreates
that exact identity when the paired T3 server has lost it. Fresh Heddle state
fails closed when T3 still has another active project at the same workspace
root. Restore the paired Heddle state instead of treating partial T3 history as
authority. Importing or adopting a project requires a future explicit operation
that imports the complete paired state; ordinary startup does not adopt it.

A top-level ad-hoc task or epic declares its complete repository scope in the
typed `repos` front-matter array. Each entry must be a logical,
single-safe-path-segment repository name. A child task must omit `repos` and
inherits the complete repository scope from its epic. Heddle raises attention
when scope is absent, a child tries to declare scope, a resolved repository path
is unavailable, or a lifecycle node selects a `repo` outside the effective
scope. It does not inspect diffs or branches to guess scope.

Lifecycle activation retains the effective ordered array in its task contract.
Every later stage, restart, delegated session, and mechanical delivery uses that
same array. Editing the live task declaration does not retarget active work.

Other required values are the absolute board and state directories, optional
worktree root, reconciliation cadence, bounded stop timeout, provider aliases,
provider pacing, session defaults, observation and per-stage staleness
thresholds, and Pushover routing. The server port is a fixed integer from 1
through 65535. T3 and Pushover secrets enter only through operator-owned
configuration sources; Heddle does not log, emit, or persist them. Every
lifecycle and delegated session resolves an allowed alias before it enters
pacing or T3.
T3, Pushover API, and console endpoints must be absolute HTTP or HTTPS URLs;
the runtime validator and configuration schema reject other schemes.

`incident` is the required operator-owned incident policy and authority boundary.
`failureThreshold` opens the circuit breaker after that many failed
later-pass attempts. `retryDelayMilliseconds` is the earliest time another
pass can count a new attempt; it never sleeps or holds that pass open.
`immediateEscalationCodes` may short-circuit known failure shapes, but an
unlisted failure still reaches the breaker. `workspaceRoot` is the root from
which the incident agent can inspect and change observable production state,
including the worker blueprint checkout, Heddle and T3 configuration,
durable data, and installed components. It must not contain a source checkout
whose build and deployment the running service cannot observe.

`approvalSeverityThreshold` uses `low`, `moderate`, `high`, or `critical`.
An accepted production mutation at or above the threshold waits for the
operator's exact proposal approval. A proposal below the threshold proceeds;
an absent or unknown proposal severity fails closed to approval. Set the
threshold so disabling one broken provider can proceed unattended while a
lifecycle change that governs future work still requires approval.
`githubIssueRepository` is the `owner/name` sink for code findings that the
incident cannot deploy and verify. The finalizer records whether delivery
succeeded. An undelivered report remains durable local attention and uses the
ordinary notification route; it does not fail the repaired incident.

## Provider and session selection

`providerAliases` is the operator-owned allowlist. An alias matches
`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`, is at most 64 characters, and contains a
non-empty ordered candidate list. Each candidate contains exactly
`providerDisplayName` and `model`. Both values are nonempty strings.
`providerDisplayName` is the exact, case-sensitive display name from the T3
provider catalog. `model` is the exact, case-sensitive T3 model slug. It is not
a model display name or model alias. The prior single-object form continues to
load and means a one-candidate list; converting it to the list form does not
change selection.

Use declared order to express the role preference:

```yaml
providerAliases:
  reviewer:
    - providerDisplayName: Workbench Alpha
      model: model-alpha
    - providerDisplayName: Workbench Beta
      model: model-beta
```

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

| Value                 | Authority and use                               |
| --------------------- | ----------------------------------------------- |
| provider alias        | Heddle authorization and operator configuration |
| provider display name | T3 catalog matching and operator diagnostics    |
| provider instance ID  | T3 routing and pacing identity                  |
| driver kind           | T3 capability metadata and diagnostics          |
| model slug            | T3 dispatch model identity                      |

A missing or malformed ticket, failed or malformed RPC, or response without a
provider catalog is `provider-catalog-unavailable`. Heddle does not include
transport details or returned configuration payloads in that selection error.

Startup validates and resolves every alias,
`session.defaultProviderAlias`, and each `pacing.providerBudgets` key against
one catalog snapshot. Heddle checks candidates in configured order and selects
the first usable candidate. A selectable provider has one exact display-name
match and is available, enabled, installed, and `ready`; its model catalog
contains the configured slug. Providers without a display name cannot be
selected. Duplicate display names are ambiguous. Startup fails before the
server binds when an alias has no usable candidate or the catalog cannot be
read.

New stage occurrences, new subagent assignments, eligible adjudication starts
or replays, and `list_providers` use a fresh catalog snapshot. A confirmed
adjudication replay retains its stored binding. Selection failures use one of
these safe reasons:
`provider-catalog-unavailable`, `provider-alias-not-allowed`,
`provider-alias-exhausted`, `provider-name-not-found`, `provider-name-ambiguous`,
`provider-not-ready`, `provider-unavailable`, or `provider-model-not-found`.
For new session selection, these candidate configuration and catalog failures
advance to the next candidate in declared order. `list_providers` reports the
first configured candidate's failure without advancing its projection. An
unreadable catalog prevents selection because no candidate can be evaluated.

Fallback also continues when T3 or its harness fails before the initial turn
starts. A candidate that passes catalog validation starts on a distinct thread.
If all candidates are unusable, fail, or collide, operator attention names the
alias, every candidate, and each cause. A successful fallback raises
`provider-fallback-active` attention and records the selected position and all
earlier catalog, collision, and start-failure causes in the session binding.
Treat the unresolved attention as a standing degradation condition: repair or
reorder the alias before new sessions repeatedly take the same fallback.

Before pacing deferral returns, the delegated successor assignment is marked as
pacing-deferred. Replaying the spawn operation evaluates that successor again;
it does not retry the failed predecessor or create the successor thread before
admission. The marker remains until bootstrap confirms. An already admitted
successor needs no marker: a crash before confirmation replays the same durable
candidate. A successor that uses another T3 driver reuses the same rendered
workflow handoff and Workflow-MCP correlation authorization; Heddle stores no
provider authentication metadata.
Delegated catalog exhaustion and start exhaustion both return the
`provider-alias-exhausted` selection reason and raise the same durable attention
boundary.

A candidate cannot bind when a started session for another alias in the same
lifecycle instance already uses that provider instance. Heddle records the
collision as a skipped cause and continues in order. Sessions for the same
alias may reuse the provider, and different lifecycle instances do not collide.

Task front matter can override provider selection for specific stages with
this exact optional map field:

```yaml
provider-alias:
  implement: specialist
```

A wait node in a lifecycle blueprint can declare these exact optional fields:

```yaml
provider-alias: reviewer
runtime-mode: full-access
```

Effective provider selection for a stage is that stage ID's own entry in the
task `provider-alias` map, then wait-node `provider-alias`, then
`session.defaultProviderAlias`. Only absence of the stage entry falls through.
A scalar `provider-alias` value, or a present null, empty, non-string,
malformed, or unknown alias value, is an error with no fallback. Every map key
must name a wait node in the task's pinned resolved blueprint. An unknown key
or a key for a mechanical node fails with `provider-alias-not-allowed` before
any provider dispatch or session effect. Mechanical nodes cannot declare these
fields. Tasks cannot override runtime mode. Effective runtime mode is wait-node
`runtime-mode`, then `session.defaultRuntimeMode`.

Runtime mode is independent from provider selection. Heddle uses T3's exact
vocabulary: `approval-required`, `auto-accept-edits`, `auto`, and
`full-access`. `full-access` is selectable for every configured provider and is
forwarded unchanged. It is not mandatory; the operator chooses the default.

Heddle pins the lifecycle blueprint source ref and persists the pending start
with that blueprint path and blob hash before it resolves the session binding.
Planning, lifecycle execution, and recovery use this same snapshot even when
the source ref moves. Heddle stores one resolved session binding before the
lifecycle starts any mechanical effect, including worktree creation, and before
MCP registration, thread creation, or first-turn dispatch.
If any valid initial lifecycle landing identifies a wait stage, every valid
initial landing must identify that same wait stage. Heddle rejects a different
wait stage or terminal alternative before it runs the selecting effect. An
initial route with only terminal landings needs no session binding.

The binding records the session and occurrence identity, selected alias,
candidate position, skipped candidates and their catalog-selection, collision,
or start-failure causes, display-name snapshot, provider instance ID, open
driver kind, observed provider CLI version, model slug, runtime mode, and
interaction mode. It contains no provider setting or credential. The binding
is provisional until T3 reports that its session or turn started. Dispatch may
advance a provisional binding after a start failure.
Observation, steering, stop, retry, restart, replay, and a cold replacement
thread for the same occurrence use the confirmed binding. A configuration,
task, blueprint, catalog, provider-display-name, or alias change cannot retarget
an existing occurrence. If T3 can no longer use the bound provider or model,
the session fails visibly. A failed turn, poor result, rejected review, or
failed gate never selects another candidate. A new stage occurrence or
subagent assignment makes a new selection.

SQLite stores a top-level binding with its stage-session runtime row and a
delegated binding with its todo assignment. The binding and session identity
are immutable after T3 reports that the thread started. Existing binding JSON
that predates candidate metadata loads as candidate position 1 with no skipped
candidates. A pre-release state directory that contains a stage-session row
without a binding cannot start recovery; clear that isolated state directory
and restart Heddle.

The existing instance runtime response includes a sorted `sessionBindings`
array for each instance. Each entry contains only `sessionKey`, `threadId`,
`alias`, `providerDisplayName`, `providerInstanceId`, `driverKind`,
`observedCliVersion`, `modelSlug`, `runtimeMode`, `interactionMode`,
`candidatePosition`, and `skippedCandidates`. This is
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

Rows are sorted by alias. The tool returns only configured aliases and each
alias's first configured provider and model. Fallback order remains an
operator-owned start policy rather than an agent selection surface. The result
does not expose provider instance IDs,
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
  "providerAlias": "specialist"
}
```

`providerAlias` is required and must be configured. A child inherits its
parent session's resolved runtime mode and cannot select its own; a child does
not inherit its parent's provider. A parent whose resolved binding is absent
fails the spawn. An invalid or nonselectable choice creates no
todo assignment, pacing reservation, MCP registration, or T3
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
`<HEDDLE_CONFIG>/blueprints` before service startup. This shared source can be a
read-only bind mount used by every worker. It must be a Git worktree at the
clone root, and its current branch must track `origin`. Worker initialization
uses committed Git state and ignores source working-tree changes.

Each worker owns a writable synchronization checkout at
`<stateDirectory>/blueprints`. Heddle creates it from the shared source during
the first reconciliation pass without hard-linking Git objects. It then binds
that checkout to the shared source's `origin` fetch URL, push URL, and upstream
branch. A later source/checkout binding mismatch fails reconciliation and raises
durable repository attention; Heddle does not rewrite an existing checkout's
Git identity. The checkout persists with the rest of that worker's state. Do
not nest either path inside the other, and do not mount or copy the checkout
into another worker.

Provision each service user with a forwarded SSH agent socket or a scoped
deploy key that can fetch and push the configured origin. Heddle stores no Git
credential in configuration, logs, attention payloads, or instance state. The
supported service-user SSH-agent path is qualified with `git push --dry-run` to
a unique scratch ref; the dry run leaves no remote ref.

Each lifecycle blueprint with mechanical nodes maps every mechanical node's
`uses` value in `board-statuses` to a status from the live board configuration.
An agent-only lifecycle can declare the known `prepare-worktree` and `finalize`
mappings without including those mechanical nodes. Heddle uses them as entry
and terminal task-status boundaries without executing either mechanical
effect. A lifecycle with neither mechanical nodes nor boundary mappings can
omit `board-statuses`. Heddle rejects a missing mechanical key, an unknown
mechanical key, or an absent live-board status before it performs a mechanical
effect or writes a board status. The diagnostic names the invalid mechanical
use and, for a missing live status, the selected status.

Each reconciliation pass runs `git fetch --no-tags --prune origin` in the
worker synchronization checkout under its repository writer lease. Fetch
changes that worker's remote-tracking refs only. It never changes the shared
source or another worker's Git state. New instances and explicit instance
rebases read the fetched upstream commit. Running instances keep their held
blueprint blob and do not change version. Heddle does not merge, rebase, reset,
switch, or modify the working branch during fetch.

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

The console editor operates only on that worker's synchronization checkout and
requires its working tree to be clean with the current branch equal to
upstream. One successful save validates and atomically replaces the artifact,
commits only that artifact, and pushes the commit while holding the same writer
lease. A push failure leaves the commit local and raises durable attention with
the checkout and commit. Dirty, unpushed, behind, or diverged state also raises
one durable repository attention entry. Resolve the state manually, then allow
a later reconciliation pass to clear the entry; do not expect Heddle to
integrate commits. The shared source remains unchanged by editing and
synchronization.

To prepare a workspace, copy its authored blueprint changes into the
organization repository, validate and commit them there, and mount a
clone at `<HEDDLE_CONFIG>/blueprints`. Heddle creates the worker checkout under
`stateDirectory` when it starts. Remove other blueprint copies only after the
organization commit contains the required artifact bytes. Validate the shared
source from the blueprint repository with:

```console
task validate HEDDLE_REPOSITORY_ROOT=/absolute/path/to/heddle
```

Heddle owns the lifecycle blueprint schema and interpreter. The organization
repository owns authored blueprint artifacts together with the
`handoff-templates/` and `todo-templates/` artifacts they bind. Validation
fails when a node's pinned handoff-template commit and path or named todo
template does not resolve in the repository being validated.

Author an ad-hoc task with its repository scope:

```console
kanban-md --dir /workspaces/sample-board create "Arrange sample records" \
  --repos sample-alpha,sample-beta \
  --tags lifecycle:standard-delivery
```

Author an epic with the same field, then omit it from every child:

```console
kanban-md --dir /workspaces/sample-board create "Coordinate sample delivery" \
  --repos sample-alpha,sample-beta \
  --tags type:epic
kanban-md --dir /workspaces/sample-board create "Prepare sample output" \
  --parent 101 \
  --tags lifecycle:standard-delivery
```

The organization blueprint repository's `skills/task-authoring/` directory is
the canonical Heddle-specific task-authoring guide and task-body template.

The provider-usage source is an explicit runtime port. A nonempty
`pacing.providerBudgets` requires top-level
`providerUsage`; an empty budget catalog forbids it. Its absolute executable is
started without a shell, receives one version-1 JSON request on stdin containing
the resolved provider instance ID and fixed five-hour window, and must return
exactly one version-1 JSON response with finite nonnegative `used` and a
nonnegative safe-integer `windowStartedAt`. The configured timeout bounds
execution and response output. The executable owns usage-service
authentication; no credential belongs in its arguments or Heddle output.

Provider budgets are keyed by configured alias for operator readability. At
startup, Heddle retains those keys and applies each limit to every candidate in
the alias, including a candidate that becomes usable only on a later fresh
catalog read. The pacing request carries the selected alias and the selected
provider instance. The provider-usage source reads the actual provider
instance, while the alias supplies its configured limit. A catalog change
between pacing and session binding cannot substitute an unpaced provider; the
dispatch stops with task-reconciliation attention. All aliases for one instance
consume the same usage and concurrent-session capacity. If two aliases whose
candidate lists overlap on one catalog instance declare different limits,
configuration is invalid even when that instance is unavailable at startup.
Omitting a second alias does not give that alias an unbudgeted route to the
instance.

An in-progress epic gets one generated, durably persisted T3 project titled
`{epic-title} - epic-{id}` at `/workspaces/worktrees/{epic-id}`. Heddle prepares
each declared repository at `/workspaces/worktrees/{epic-id}/{repository}` on
`epic/{epic-id}` before project creation. Paused, stopped, and UAT epics retain
their project. A done epic also retains its project so its archived stage
threads remain available in T3's archive view. The durable `active` state means
that the project exists; it is not execution permission. A done epic's board
status blocks child dispatch. Project deletion requires a separate explicit
cleanup policy. A durable deleting or deleted record stays non-active across
restart and is not reseeded. Child task threads use the epic project.
An epic title change updates only the T3 project title through a durable,
replayable revision. Ad-hoc threads use the persisted shared project ID.
Subagents reuse the parent's project and worktree.

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

Task worktrees use `/workspaces/worktrees/{task-id}/{repository}`. Heddle
prepares every repository in the effective scope before session activation. A
top-level task uses its own `repos`; a child uses the complete array inherited
from its epic and bases each task branch on that repository's epic branch. The
handoff task contract contains the effective array, so a child session sees the
inherited names. Mechanical nodes act on all retained repositories. A wait node
can select one declared `repo` as its session worktree. Existing
repo-first worktrees are not migrated. Every thread has a bounded deterministic
`task-<id> · <stage-occurrence>` title and no `titleSeed` on its first turn.
Each occurrence of a wait stage has one durable
session and thread identity. A recurring review or remediation stage receives
a new occurrence discriminator; restart resumes an incomplete occurrence.
All stage occurrences for one task use the same task branches and repository
worktrees so review, remediation, and later stages operate on the same delivery
state.

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

Use your harness question tool when you need an answer. Heddle routes the question set to your parent, an adjudicator, or the operator. Answer assigned questions with Heddle's `answer` tool: every question ID needs selectedOptions or text, plus reasoning. Finish the work or advance; do not stop while you owe an answer.
```

Agent wait nodes declare `handoff: standard` or `handoff: remediation` in the
pinned lifecycle blueprint. Each wait node also declares a `handoff-template`
with a repository-relative Markdown path and exact Git commit SHA. Heddle reads
the entry file and `handoff-templates/includes/` files from that commit in the
worker blueprint checkout, retains the commit under
`refs/heddle/handoff-templates/<commit-sha>`, and does not read mutable
working-tree files during session activation. Task repositories receive no
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
`handoff-render-failed` lifecycle-resolution attention entry. No MCP
registration, thread, or first-turn effect occurs. After T3 accepts the first turn, Heddle
records the effective prompt, exact rendered document, and task, instance,
session, stage, and thread identity in `session:activated`. Restart accepts
only an exact payload match and does not append or dispatch a second activation.

Pinned Wyrd Company T3 fork 0.0.38-wyrd.2 supplies authenticated per-thread MCP
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
`InputRequiredResult`. Agents ask through their harness question tool, which T3
records as user-input state. Heddle routes each recorded request and exposes one
`answer` tool for a complete answer set.

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
shape. Escalation entries offer the exact recorded option labels as submitted
answer values. Approval entries
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

A deferred reconciler runtime and an in-flight start reservation can
intentionally exist before lifecycle state. Synchronization does not report
that interval as `lifecycle-instance-absent`. A retained `starting` runtime
without lifecycle activation raises `instance-start-incomplete`; its resolved
task lifecycle is retried on the ordinary incident retry deadline. If lifecycle
state appears, synchronization resolves the matching stale entry. A running,
waiting, or completed runtime with no lifecycle state remains a production
error.

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

An escalation records an answering authority. A child begins with its parent
session as authority. A top-level escalation begins with a new adjudication
session scoped to that occurrence. The adjudicator receives the current epic
and child statuses, escalating stage, prior outputs, and original questions,
but receives no correlation token or configured secret in that context. Its
pinned policy permits only an answer with reasoning or a decline with cause and
reasoning. A decline does not try another provider candidate. It moves authority
to the operator and includes the original questions, model, cause, and reasoning
in console attention and Pushover notification.

Provider candidates apply only to session start. If every candidate fails, or
if the session requests an unauthorized action, submits invalid answers, or
attempts to answer another escalation occurrence, Heddle moves
authority to the operator. A started adjudication has no adjudication-specific
wall-clock timeout. It remains authoritative until it answers or declines
through its approved tool, or its native question is durably cancelled. Session failure, terminal exit, absence, and stalled
execution use the normal session observation and escalation policy without
settling the adjudication or stopping its thread. One occurrence has one stable
adjudication session identity, with one stable thread identity per startup
candidate; replay cannot create a second adjudication after start. The
lifecycle event history shows every adjudicated answer's selected values,
model, and reasoning. The session stops only after an accepted answer, decline,
authority failure, or durable cancellation of its native question. Native
withdrawal or confirmed loss of the asking session cancels the occurrence
without an answer or decline. Cleanup waits for any in-flight start and does
not stop an adjudicator that still asks or owes another pending question.
Replay confirms cleanup without redelivery.

Heddle can move authority to another named session or return it to the operator.
The current authority answers through the same guarded answer contract. A
question offers zero or more options and accepts either selected options or
text. The optional multi-select flag defaults to false. Each answer is keyed by
question ID and contains selectedOptions, text, and required reasoning. Exactly
one of selections or text provides the answer. Every question must be answered;
unknown questions or options and excess single-select answers are rejected.
A native question set has no count limit. An empty set remains pending until
its current authority explicitly answers with `answers: {}`. It is not
automatically settled and does not permit an early adjudicator stop.
An answerer that stops owing an answer receives its questions again. An answerer
asking its own question waits while the same routing rule handles that question.
For parent or delegated session authority, a failed or absent answerer returns
the pending question to operator authority without answering or cancelling it.
A delegated session remains observable while it asks or owes a pending question,
even after its assignment becomes terminal. Unrelated terminal assignments do
not remain observation targets. Scoped adjudication retains its separate
settlement and session-error policy.

Heddle records an accepted answer before effects. It replies to the original
T3 request on its recorded thread with a command identity derived from the
escalation occurrence, then appends the question, answer, per-answer reasoning, and
named answering authority to the task and, for an epic child, its epic. Restart
replays either unfinished effect with the same identity and never redelivers a
completed reply. An absent or failed asking thread cannot receive a reply on a
replacement thread. Answer obligations clear when the request is answered,
withdrawn, or its asking session is gone.
Selected single-option answers reach T3 as strings; multi-select answers reach
T3 as arrays. Text answers remain strings. For repeated question IDs, each answer
must satisfy every occurrence and the last occurrence sets native wire cardinality.

One failed answer settlement raises
`production:escalation-settlement-failed:<escalation-attention-id>` and does not
stop settlement for other escalations, incident reconciliation, or session
observation. A later successful replay resolves the production-error attention.

A present, nonfailed session thread with a pending escalation has the
`awaiting_answer` phase. It raises no ended or stalled attention and admits no
incident while the wait remains. An absent or failed thread is still a genuine
dead session and follows normal attention and incident admission.

A session that is not turning and has not advanced is poked to finish its work
or advance. Running and starting phases are not poked based on the stalled
liveness bucket. A session owing an answer receives the pending question set
again and cannot advance or stop until its obligation clears. Adjudication has
no execution timeout and completes through its approved answer or decline tool.
Durable native cancellation releases it without fabricating completion.

An accepted disposition performs its canonical effect before marking the entry
resolved. The resolved record remains durable so the same stable ID cannot raise
a second entry after restart. The production action port records the exact action
and answers as durable intent before effect. It delegates only to
`EscalationCoordinator.answerAsOperator`, `SessionObserver.answerApproval`, or
`SessionObserver.answerUserInput`. Request responses use the stable attention ID
as their command identity; escalation answer delivery uses identities derived
from its occurrence. Before retry, Heddle reconciles the exact intended request,
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
Pushover receives escalations and production failures. Session-observation
attention of kind `ended`, `failed`, or `stalled` also enters the durable
failure path; the first two are dead-session states. No incident eligibility
catalog exists. Any repeated task-scoped production or session failure opens
its circuit breaker unless it is a scheduler-pass, durable-catalog, or
incident-execution floor failure. A floor page is critical and states that no
incident can run. Configuration validation occurs before composition and is
also outside incident response.

The first failure records a durable attempt and retry deadline. Each pass before
the deadline leaves the condition visible and performs no retry. A later pass
raises a new idempotent effect. When `incident.failureThreshold` is reached,
the breaker opens and admits one incident occurrence for the source condition.
The first occurrence uses the condition's deterministic incident identity;
each later occurrence has its own deterministic identity and positive number.
Repeated passes and restart reuse one active occurrence. A terminal occurrence
remains audit history and cannot suppress a later recurrence from opening a
fresh lifecycle. `incident.immediateEscalationCodes` can open a known shape
immediately; it is not an eligibility list. A successful later-pass start or
activation clears its stale condition attention. A `starting` runtime with no
activation is retried rather than excluded because its earlier attention still
exists. An open breaker has another durable probe deadline. Synchronization can
clear the condition at that deadline even when incident admission was
suppressed, remains cooldown-limited, or the admitted incident failed. A failed
probe rearms the deadline instead of running on every pass.

Page rate limits remain separate from admission. While SQLite is available,
Heddle limits one production-error code to one page per minute and three page
attempts in five minutes. If a floor failure makes SQLite unavailable, the same
bound uses an in-memory window for the process lifetime; restart resets it. A
pending page replays before each
scheduler pass and obeys its durable delivery deadline across restart. At most
three incidents run concurrently; suppressed failures remain active attention.
Dead and stalled session attention offers **Resolve** as an operator fallback.
After admission, its console card links to the most recently admitted incident
occurrence.

The incident handoff identifies `incident.workspaceRoot`, the worker blueprint
checkout, board and state paths, T3 endpoint, configured GitHub sink, source
condition, approval threshold, and prohibitions. The agent may change organization
blueprints, Heddle or T3 configuration and data, provider enablement, installed
component versions, and service processes when it can observe the result before
closure. It must not suppress detection, handle secrets, push a real remote or
write a default branch, degrade the response machinery, or perform an effect it
cannot verify.

Diagnosis records `live`, `cleared`, or `undetermined`, root cause, and proposed
GitHub issue, operator escalation, or production mutation actions with severity.
Review can return it at most three times. A production mutation at or above
`incident.approvalSeverityThreshold` waits for **Approve production mutation**;
a lower-severity mutation proceeds without that card. Missing or unknown
severity requires approval. Mutation intent is durable before activation and
completion is durable afterward.

A Heddle or T3 fork code fix is reported to
`incident.githubIssueRepository`, not performed. The running service cannot
observe its build and deployment. The issue includes the incident identity and
the finalizer checks that identity before creation. Finalization records either
delivery or an `incident-report-undelivered` attention. The latter uses the
existing durable notification path and does not fail an otherwise repaired
incident.

Finalization accepts only a fresh `conditionState: cleared` observation. It then
resolves the source attention with the incident identity as justification and
retains the attention row and terminal incident occurrence for audit. Resolution
atomically removes the source admission record, so recurrence starts a fresh
failure-count and breaker episode. If that breaker opens, Heddle allocates the
next occurrence and new lifecycle identity; prior sessions, actions, effects,
and report completion cannot authorize it. With no observable workaround, the
agent reports and escalates instead; the task stays blocked. Incident-execution
failure remains a floor error and cannot create another incident. Known tokens,
configured secrets, and credential-bearing URLs are redacted before attention
persistence and handoff assembly.

Every production-error and dead or stalled session card offers **Resolve**. The
action records durable intent and completion before it resolves the entry. Repeating the action or
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
