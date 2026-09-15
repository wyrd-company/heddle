---
docs: true
title: Usage
order: 3
---

A blueprint is a JSON artifact in the organization blueprint repository under
`blueprints/<artifact-id>.json`. A task selects it with a `lifecycle` front
matter property or a `lifecycle:<artifact-id>` tag. This page authors one from
scratch; the [reference](reference.md) lists every field and rule.

## A first lifecycle

The smallest useful lifecycle is one agent stage that ends the task:

```json
{
  "$schema": "https://wyrd.company/heddle/lifecycle-blueprint.schema.json",
  "relationships": {
    "implements": "heddle",
    "uses": ["catalog-entry", "catalog"]
  },
  "board-statuses": { "prepare-worktree": "in-progress", "finalize": "done" },
  "nodes": [
    { "id": "begin", "uses": "complete" },
    {
      "id": "write-entry",
      "uses": "wait",
      "tools": ["advance", "get_task_context", "todo_list", "todo_check"],
      "todo-template": "catalog-entry",
      "handoff-template": {
        "path": "handoff-templates/catalog.md",
        "commitSha": "<commit that holds the template>"
      }
    },
    { "id": "published", "uses": "complete" }
  ],
  "edges": [
    { "source": "begin", "target": "write-entry" },
    {
      "source": "write-entry",
      "target": "published",
      "disposition": "done",
      "description": "The catalog entry is written and checked"
    }
  ]
}
```

Heddle starts at `begin`, activates a session for `write-entry` with the
rendered handoff, and waits. The session's `advance` tool offers one
disposition, `done`, with the edge's description in its schema. When the
session calls it, the edge fires (a disposition edge without a `condition`
fires on `result.output.dispositions.done`) and the lifecycle completes. An
agent-only lifecycle declares the `prepare-worktree` and `finalize` statuses
without those nodes so Heddle knows which board columns bound the work.

## Adding a review loop

Guards read the graph's own history. `lifecycle.visits.<node>` counts how many
times a node has finished and `lifecycle.blueprint.metadata` carries whatever
the blueprint declares, so a bounded loop needs no code:

```json
"metadata": { "maximumRevisions": 2 },
"edges": [
  {
    "source": "check-entry", "target": "write-entry",
    "disposition": "revise", "description": "Return the entry with findings",
    "output-contract": "review-findings",
    "condition": "result.output.dispositions.revise and lifecycle.visits.`check-entry` < lifecycle.blueprint.metadata.maximumRevisions"
  },
  {
    "source": "check-entry", "target": "give-up",
    "disposition": "revise", "description": "Return the entry with findings",
    "output-contract": "review-findings",
    "condition": "result.output.dispositions.revise and lifecycle.visits.`check-entry` >= lifecycle.blueprint.metadata.maximumRevisions"
  }
]
```

Several edges may share a disposition; exactly one must fire. The
`output-contract` names `output-contracts/review-findings.json`, a JSON Schema
Heddle reads at the stage's pinned template commit and enforces at `advance`
before anything is recorded. A node that revisits (`write-entry` here) declares
`"config": { "joinStrategy": "any" }`.

`give-up` is a `fail` node. Its message is a template over the same data the
guards read, and Heddle renders it into the attention entry the operator sees:

```json
{
  "id": "give-up",
  "uses": "fail",
  "params": {
    "message": "Entry for {{ task.title }} was returned {{ lifecycle.visits['check-entry'] }} times"
  }
}
```

## Asking a person

A `question` node waits on a role instead of a session. Its questions use the
T3 question shape; the text is a template; the answer becomes the node's output:

```json
{
  "id": "confirm-price",
  "uses": "question",
  "params": {
    "role": "operator",
    "questions": [
      {
        "id": "publish",
        "question": "Publish {{ lifecycle.outputs['write-entry'].title }} at {{ lifecycle.outputs['write-entry'].price }}?",
        "options": [
          { "label": "yes" },
          { "label": "no", "description": "Hold the entry" }
        ]
      }
    ]
  }
}
```

Its edges carry no disposition; they route on the answer. `selected` projects
each chosen option to `true`, so the common guard is a path:

```json
{ "source": "confirm-price", "target": "publish", "condition": "result.output.selected.publish.yes" },
{ "source": "confirm-price", "target": "held", "condition": "result.output.selected.publish.no" }
```

Free-text answers are in `result.output.answers.<id>.text`; any JSONata over
them is a legal guard. The `role` selects who answers: `operator` raises an
attention card, `adjudicator` opens a scoped adjudication session.

## Reading graph data in a handoff

Handoff templates receive `handoff` (the stage's contract, its entry, prior
stage outputs, the task contract, and the todo list), `lifecycle` (the same
projection the guards read), and `task` (the board task's raw front matter).
A remediation stage reads what sent it back through `handoff.stage.entry`:

```njk
{% if handoff.stage.entry %}
Findings from `{{ handoff.stage.entry.node }}`:
{{ handoff.stage.entry.output.findings | stableJson }}
{% endif %}
```

## Validating and pinning

Every wait stage pins its template by commit. Heddle reads the template, every
include, the stage's skills, and the output contracts its edges name at that
commit, so a change to any of them is a new pin. The blueprint repository's
`task validate HEDDLE_REPOSITORY_ROOT=<heddle checkout>` runs the authoritative
schema and interpreter over the catalog; `task blueprints:validate` in a Heddle
checkout does the same for one repository.

A running instance keeps the blueprint blob it started from. Editing the
catalog affects new instances and explicit rebases only.

Schema and interpreter validity is not the same as runnability. A stage can
name a provider alias, or a question can ask the adjudicator, that the
deployment you are pinning into does not supply — valid catalog, held
lifecycle. Ask that deployment before you pin:

```console
$ heddle-server validate-blueprints ~/catalog --config ~/.heddle
catering-run node 'approve': asks the adjudicator; this deployment composes no adjudication; configure 'adjudication'
```

It exits non-zero with one such line per mismatch, and exits zero with a JSON
summary when every requirement is met. See
[Deployment requirements](reference.md#deployment-requirements) for what it
checks.
