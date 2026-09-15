---
docs: true
title: Blueprint reference
order: 4
---

A lifecycle blueprint is a JSON artifact validated by
`schemas/lifecycle-blueprint.json` and then by the interpreter. This page is the
authoring contract: what each field means, what each capability does, what a
guard or a template can read, and what validation refuses.

## Top-level fields

| Field              | Meaning                                                                                                                                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$schema`          | `https://wyrd.company/heddle/lifecycle-blueprint.schema.json`                                                                                                                                                                                                                                                     |
| `relationships`    | `implements: heddle` and `uses`, the todo templates, handoff templates, skills, and output contracts the blueprint binds                                                                                                                                                                                          |
| `metadata`         | Any JSON object. Exposed to guards and templates as `lifecycle.blueprint.metadata`; Heddle reads nothing from it                                                                                                                                                                                                  |
| `board-statuses`   | Maps a mechanical capability (`prepare-worktree`, `review-snapshot`, `merge`, `finalize`) to the board status the completed step mirrors. Every mechanical node's capability must be mapped; an agent-only lifecycle maps `prepare-worktree` and `finalize` as its entry and terminal columns without those nodes |
| `reasoning-effort` | The provider's own reasoning effort token every stage of this lifecycle starts from. A stage's own `reasoning-effort` overrides it                                                                                                                                                                                |
| `nodes`            | The graph's nodes                                                                                                                                                                                                                                                                                                 |
| `edges`            | The graph's edges                                                                                                                                                                                                                                                                                                 |

## Node fields

| Field               | Applies to         | Meaning                                                                                                                                                                                                                                                     |
| ------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                | all                | The node's identifier. It labels sessions, outputs, and attention; Heddle reads no meaning from it                                                                                                                                                          |
| `uses`              | all                | The capability, from the catalog below                                                                                                                                                                                                                      |
| `tools`             | `wait`             | The MCP tools the stage's session may call, from `advance`, `answer`, `create_finding`, `create_follow_up`, `get_task_context`, `list_providers`, `liveness`, `report_blocked`, `spawn`, `todo_add`, `todo_check`, `todo_edit`, `todo_list`, `todo_reorder` |
| `handoff-template`  | `wait`             | `{ path, commitSha }`: the Markdown template under `handoff-templates/` and the exact commit Heddle reads it from                                                                                                                                           |
| `todo-template`     | `wait`             | The todo template artifact id under `todo-templates/`                                                                                                                                                                                                       |
| `skills`            | `wait`             | Unique kebab-case skill names resolved from `skills/<name>/SKILL.md` at the template commit                                                                                                                                                                 |
| `assign-agent-name` | `wait`             | Which list of the task's agent-name theme names this stage's agent                                                                                                                                                                                          |
| `provider-alias`    | `wait`             | The operator-configured provider alias the stage prefers                                                                                                                                                                                                    |
| `reasoning-effort`  | `wait`             | The provider's own reasoning effort token for this stage. The narrowest layer: it overrides the lifecycle header, the alias candidate, and the configuration default. The value must be one the resolved model offers                                       |
| `runtime-mode`      | `wait`             | `approval-required`, `auto-accept-edits`, `auto`, or `full-access`                                                                                                                                                                                          |
| `repo`              | `wait`             | The repository within the task's scope this stage works in                                                                                                                                                                                                  |
| `params`            | `question`, `fail` | Capability parameters, described per capability                                                                                                                                                                                                             |
| `config`            | all                | Flowcraft node configuration. `joinStrategy: "any"` is required on every node an edge revisits                                                                                                                                                              |

## Capability catalog

The catalog is closed: a `uses` value Heddle does not implement fails
validation by name. Adding a capability is a change to Heddle.

### `wait`

An agent stage. Heddle assembles the handoff, renders the pinned template,
creates a session through T3, registers the stage's tools, and waits. The
session ends the stage with `advance`, choosing one of the dispositions its
outgoing edges declare. The node's output is the `advance` output plus
`disposition` and `dispositions: { <name>: true }`.

A delegated child session spawned from the stage binds to the same stage
contract with every tool except `advance` and no dispositions.

### `question`

A wait on a role. `params.role` is `operator` or `adjudicator`;
`params.questions` is a non-empty array in the T3 question shape:

```json
{
  "id": "publish",
  "header": "Publication",
  "question": "Publish {{ lifecycle.outputs.entry.title }}?",
  "options": [{ "label": "yes" }, { "label": "no", "description": "Hold it" }],
  "multiSelect": false
}
```

`question`, `header`, and each option's `description` are templates over the
[lifecycle projection](#the-lifecycle-projection) and `task`. Question ids are unique within the node. An `operator` question is
an attention card; an `adjudicator` question opens a scoped adjudication
session. A deployment that composes no adjudication does not ask the operator
in its place: the lifecycle holds at the node and raises
`lifecycle-question-role-unavailable` once per occurrence, until adjudication
is configured or the blueprint changes. The answer is the node's output:

```json
{
  "answers": {
    "publish": { "selectedOptions": ["yes"], "text": "", "reasoning": "…" }
  },
  "selected": { "publish": { "yes": true } },
  "answeredBy": { "kind": "operator" },
  "prose": "optional free text"
}
```

Each occurrence of the node — instance, node, visit — asks once. A repeated
pass re-routes the same question; a restart re-raises it; one answer resumes
the lifecycle and a second answer to the same occurrence is inert.

### `fail`

Ends the lifecycle in failure. `params.message` is a required template over
the lifecycle projection and `task`; Heddle renders it into a durable attention
entry `lifecycle:failed:<instance>:<node>:<visit>` with code
`lifecycle-failed`. A missing or empty message fails closed at the node and
raises nothing. The node returns `{ "failed": true, "message": … }`. An
at-least-once rerun of the same visit raises nothing new; a later visit is its
own entry. A task's board status stays where it was; an incident records
`failed`.

### `resolve-attention`

Resolves the attention entry the lifecycle was started for, with the instance
id as justification, and returns `{ "attentionId", "resolved" }`. `resolved`
is `false` on replay. A lifecycle started for no attention fails closed at the
node. Heddle starts an incident lifecycle for the production-error attention
that admitted it, so an incident blueprint resolves its source with this node.

### `complete`

Does nothing and returns `{}`. Use it as a start node before the first wait
stage or as a terminal node.

### `prepare-worktree`, `review-snapshot`, `merge`, `finalize`

The mechanical delivery steps, run by Heddle in real code against the task's
repository scope. Each mirrors the board status `board-statuses` maps to its
capability after its effect.

- `prepare-worktree` creates the task branch and worktree from the base
  branch.
- `review-snapshot` creates or reuses the gitpr review record for the branch
  and persists its exact source/base basis as the node's output.
- `merge` lands the head that was reviewed. It reads the output of the
  blueprint's `review-snapshot` node, records the approval against that exact
  basis, and merges only a strict fast-forward of it. Its output carries
  `dispositions: { merged, remediate }` and, when the branch drifted, a typed
  `remediationCause`; the edges out of a merge node route on those.
- `finalize` removes the merged worktree and branch, reading the same
  `review-snapshot` output.

A merge node is reachable only by a disposition of a wait node that itself
follows a review-snapshot node; the disposition's name is the author's. A
blueprint has one `review-snapshot` node on the path to a merge; several with
outputs fail the merge by name.

## Edge fields

| Field              | Meaning                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `source`, `target` | Node ids                                                                                                                                   |
| `disposition`      | The name a `wait` session gives `advance` to take this edge. Any non-empty string; `send-back` and `in progress` are as valid as `approve` |
| `description`      | Required with `disposition`; shown in the `advance` tool schema                                                                            |
| `output-contract`  | Requires `disposition`. Names `output-contracts/<id>.json`, a JSON Schema the session's output must satisfy                                |
| `condition`        | A JSONata guard. Optional on a disposition edge; required on every other edge out of a node that has more than one                         |

Edges out of a `question` node carry no disposition: every one carries a
condition, or exactly one carries none and always fires.

## Guards

A condition is JSONata evaluated over the node's result and the lifecycle
projection. Evaluation runs to completion with no time or depth bound: a
condition is pinned repository content the catalog reviews, like a template.

- `result.output` is the source node's output — for a wait stage the `advance`
  output with `dispositions`, for a question the answer, for a merge the merge
  result.
- `lifecycle` is the projection below.

A disposition edge without a condition guards
`$lookup(result.output.dispositions, "<name>")`, so a name such as `send-back`
needs no quoting from the author. A guard written by hand reaches a
non-identifier name the same way, or through a backtick segment:
`` result.output.dispositions.`send-back` ``. Several edges may share one
disposition; they must agree on description and output contract, and at most
one may omit its condition. An edge that omits its condition while a sibling of
the same disposition carries one is the else branch: it fires when the
disposition is chosen and no conditioned sibling is true. “Effective condition”
in the validation list includes this disposition default. When a wait or
question node resumes, exactly one edge out of it must fire; none or several
is a routing failure that raises attention and stops the instance. Only the
chosen disposition's edges are evaluated on resume. A mechanical node's edges
follow Flowcraft fan-out: every true guard fires, and a mechanical node whose
guards all skip is a landing failure. A guard that does not compile fails
validation; one that throws at runtime fails the transition by edge name.

Inside a JSONata array filter the root moves to the item, so reach the
projection with `$$.lifecycle…`. Hyphenated ids are path segments in backticks:
`` lifecycle.visits.`check-entry` ``.

## The lifecycle projection

Heddle writes `lifecycle` into the graph context when an instance starts, after
every executed node, and before a wait or question node resumes:

| Path                           | Meaning                                                     |
| ------------------------------ | ----------------------------------------------------------- |
| `lifecycle.blueprint.metadata` | The blueprint's `metadata` object                           |
| `lifecycle.current`            | `{ node, visit }` of the node that last finished, or `null` |
| `lifecycle.outputs.<node>`     | The latest output of each node that has finished            |
| `lifecycle.visits.<node>`      | How many times each node has finished                       |
| `lifecycle.task`               | The task contract the instance started with                 |

Guards, question text, fail messages, and handoff templates all read it.

## Handoff templates

A wait stage's template is strict Nunjucks Markdown rendered with:

- `handoff` — `{ format: "heddle.stage-handoff", version: 1, skillPointer, stage, taskContract, todoList }`
  where `stage` is `{ name, agentName?, entry, priorStageOutputs, skills }`.
  `entry` is `{ node, output }` for the node whose edge activated this stage,
  or `null` at the start of the lifecycle.
- `lifecycle` — the projection above.
- `task` — the board task's raw front matter, display input only.

`{% include "handoff-templates/includes/<path>" %}` reads partials at the pinned
commit; `extends` and `import` are refused, as are the `random` and `date`
filters. `stableJson` renders a value as canonical JSON; `skill(name)` returns
`{ name, path, description }` for a declared skill. An undefined value, a
render that differs on repeat, or a template that disagrees with its stage
fails before any session effect and raises one durable attention entry.

## Stage contracts and `advance`

At activation Heddle stores a stage contract from the pinned blueprint: the
stage id, tools, skills, todo template, handoff template pin, and one entry per
disposition with its description and, when declared, its output contract name
and schema. The `advance` tool schema offers exactly those dispositions and
prints each contract's schema in the description. Output is validated against
the contract before the lifecycle records the transition; a violation reports
every schema error. A contract is closed: a property it does not declare
cannot be in the output, so `additionalProperties` is `false` or absent and
Heddle enforces `false`. A disposition without a contract accepts an empty
output or none; a stage that hands anything forward declares a contract. A completed stage keeps `advance` for replay and loses
every other tool.

## Validation

The interpreter refuses, naming the node or edge:

- a duplicate node id, or a node that declares no `uses`
- a `uses` value with no implementation
- a wait node without disposition edges, or with an action edge
- a blank disposition, or one whose edges disagree on description or output
  contract, or that has more than one unconditioned edge
- a node that mixes disposition edges with ordinary edges, or edges with and
  without effective conditions
- a question node without params, with an unknown role, without questions, or
  with a blank or repeated question id, blank text, or an option without a label
- a question node whose edges declare a disposition
- a merge node reached other than by a disposition of a wait node that follows
  a review-snapshot node
- a cycle node without `joinStrategy: "any"`
- a route that cycles without a landing, that has no wait or terminal landing,
  or that can land at more than one wait node
- a mechanical node whose capability is not in `board-statuses`, or a
  `board-statuses` key that is not a mechanical capability, or a status absent
  from the live board configuration
- session selection, agent-name, skills, or handoff-template metadata on a
  non-wait node; a wait node without a valid pinned template
- a condition that does not compile

Repository validation adds the schema, template and todo-template resolution at
the pinned commit, skill front matter, output contracts read at the source
stage's pinned commit (object schemas bound in `relationships.uses`; the
working tree's copy is not consulted), agent-name themes, and the tool
registry.

### Deployment requirements

A blueprint can be valid and still ask for something the deployment running it
does not supply; the lifecycle then holds at the node instead of routing.
`heddle-server validate-blueprints <blueprints-repository-root>` reads the
installed configuration the way the service does, runs repository validation,
and then names each requirement a node makes of the deployment:

| Node declares                              | The deployment must supply                                          | Configuration key         |
| ------------------------------------------ | ------------------------------------------------------------------- | ------------------------- |
| `question` with `params.role: adjudicator` | composed adjudication                                               | `adjudication`            |
| `question` with `params.role: adjudicator` | the configured policy artifact, present in the blueprint repository | `adjudication.policyPath` |
| `provider-alias`                           | that alias in the allowlist                                         | `providerAliases.<alias>` |

Each unmet requirement is one line on standard error naming the blueprint, the
node, the requirement, and the key that would satisfy it, and the command exits
non-zero. A catalog this deployment can run exits zero with a JSON summary of
the artifacts validated and every requirement found. The command reads; it
changes no configuration, board, or state.

## Pinning and replay

An instance records the Git blob of its blueprint at activation and runs that
blob to completion; a catalog change reaches new instances and explicit rebases
only. Templates, includes, skills, and output contracts resolve at the stage's
pinned commit. Node execution is at-least-once and every effect is idempotent
per occurrence: a rerun of the same visit repeats nothing visible, and a later
visit of the same node is a new occurrence with its own session, question,
attention, and operation identity. Restart replays recorded activations exactly
and never dispatches a second one.
