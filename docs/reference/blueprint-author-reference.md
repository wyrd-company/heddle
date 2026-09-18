---
relationships:
  implements:
    - blueprint-authoring
    - node-types
---

# Blueprint author reference

This file is generated from the node-type registry, blueprint schema, validation-rule registry, shipped blueprints, and hook-plugin file registry. Run `task build` to regenerate it.

## Engine agreement

Heddle dispatches Flowcraft nodes sequentially with engine concurrency 1. Durable snapshot checkpointing and the one-terminal-result guard depend on that order. A concurrency change must replace those agreements before it changes dispatch.

Every completed node writes its output below its authored node id. A pausing result is also exposed during edge routing as `result.output.<result>`; its wake payload is `result.output.payload`.

## Node types

### `child-run`

Start a child blueprint and pause until it completes.

- Pausing: yes
- Results: `completed`, `failed`
- Context keys written: `<node-id>`
- Inputs and defaults:

```yaml
{
  "type": "object",
  "additionalProperties": false,
  "required": ["blueprint"],
  "properties":
    {
      "blueprint": { "$ref": "#/$defs/slug" },
      "inputs":
        {
          "description": "Child initial context keys to values or context references.",
          "type": "object",
          "additionalProperties": { "$ref": "#/$defs/valueOrRef" },
        },
      "outputs":
        {
          "description": "Keys under this node's output.payload mapped to JSONata expressions over child final context. Omitted mappings export all declared outputs by literal key; an explicit empty object exports no values.\n",
          "type": "object",
          "additionalProperties": { "type": "string" },
        },
    },
}
```

- Output:

```yaml
{
  "type": "object",
  "properties":
    {
      "payload": { "type": "object" },
      "completed": { "type": "boolean" },
      "failed": { "type": "boolean" },
    },
}
```

### `lifecycle-start`

Start the selected lifecycle as an independent top-level run.

- Pausing: no
- Results: `started`
- Context keys written: `<node-id>`
- Inputs and defaults:

```yaml
{
  "type": "object",
  "additionalProperties": false,
  "required": ["blueprint"],
  "properties":
    {
      "blueprint":
        {
          "description": "Process blueprint id, selected literally or from intake policy output.",
          "oneOf":
            [{ "$ref": "#/$defs/slug" }, { "$ref": "#/$defs/contextRef" }],
        },
      "inputs":
        {
          "description": "Additional initial context values or a reference to their mapping. The current issue snapshot is transferred automatically; inputs cannot replace issue. Values are captured before target resolution.\n",
          "oneOf":
            [
              { "$ref": "#/$defs/contextRef" },
              {
                "type": "object",
                "propertyNames": { "not": { "enum": ["issue", "from"] } },
                "additionalProperties": { "$ref": "#/$defs/valueOrRef" },
              },
            ],
        },
    },
}
```

- Output:

```yaml
{
  "type": "object",
  "properties":
    {
      "started": { "const": true },
      "payload":
        {
          "type": "object",
          "properties": { "runId": { "type": "string" } },
          "required": ["runId"],
        },
    },
  "required": ["started", "payload"],
}
```

### `pass`

Run one agent pass in one T3 Code thread and pause for its outcome.

- Pausing: yes
- Results: `handoff`, `escalate`, `timeout`, `idle`, `turnEnded`, `overridden`
- Context keys written: `<node-id>`, `stages.<node-id>`
- Inputs and defaults:

```yaml
{
  "type": "object",
  "additionalProperties": false,
  "required": ["prompt", "handoff"],
  "properties":
    {
      "prompt": { "$ref": "#/$defs/templateRef" },
      "handoff":
        {
          "description": "The handoff tool's definition. Root must be `type: object` with `properties` and a `description`, as the MCP tool schema requires. The `description` is the tool description the agent reads.\n",
          "$ref": "#/$defs/schemaRef",
        },
      "turnEndPolicy":
        {
          "description": "The starting value. It is mutable context on the stage and may be changed while the stage runs: by the operator, or by a tool call from the agent that raises an escalation the operator approves.\n",
          "type": "string",
          "enum": ["require-handoff", "allow"],
          "default": "require-handoff",
        },
      "escalation":
        {
          "description": "Whether an escalation ends the stage or is answered in place.\n",
          "type": "string",
          "enum": ["ends-stage", "answer-in-place"],
          "default": "answer-in-place",
        },
      "model": { "$ref": "#/$defs/valueOrRef" },
      "runtimeMode":
        {
          "type": "string",
          "enum":
            ["approval-required", "auto-accept-edits", "auto", "full-access"],
          "default": "full-access",
        },
      "worktree": { "$ref": "#/$defs/valueOrRef" },
      "resumeThread":
        {
          "description": "The id of an earlier `pass` node whose thread this pass continues, or a context reference to a thread id.\n",
          "$ref": "#/$defs/valueOrRef",
        },
      "tools":
        {
          "description": "Extra MCP registrations for the thread.",
          "type": "array",
          "items":
            {
              "type": "object",
              "additionalProperties": false,
              "required": ["name", "endpoint"],
              "properties":
                {
                  "name": { "type": "string" },
                  "endpoint": { "type": "string", "format": "uri" },
                },
            },
        },
      "deadline": { "$ref": "#/$defs/deadline" },
      "inactivity":
        {
          "description": "An ISO 8601 duration of no observed thread activity after which the node wakes with result `idle`.\n",
          "$ref": "#/$defs/deadline",
        },
    },
}
```

- Output:

```yaml
{
  "type": "object",
  "properties":
    {
      "payload": {},
      "handoff": { "type": "boolean" },
      "escalate": { "type": "boolean" },
      "timeout": { "type": "boolean" },
      "idle": { "type": "boolean" },
      "turnEnded": { "type": "boolean" },
      "overridden": { "type": "boolean" },
    },
}
```

### `question`

Ask a configured role one or more questions and pause for its answer.

- Pausing: yes
- Results: `answered`, `timeout`
- Context keys written: `<node-id>`
- Inputs and defaults:

```yaml
{
  "type": "object",
  "additionalProperties": false,
  "required": ["role", "questions"],
  "properties":
    {
      "role": { "type": "string" },
      "questions":
        {
          "type": "array",
          "minItems": 1,
          "items":
            {
              "type": "object",
              "additionalProperties": false,
              "required": ["id", "question"],
              "properties":
                {
                  "id": { "$ref": "#/$defs/slug" },
                  "header": { "type": "string" },
                  "question": { "$ref": "#/$defs/templateRef" },
                  "multiSelect": { "type": "boolean", "default": false },
                  "options":
                    {
                      "type": "array",
                      "items":
                        {
                          "type": "object",
                          "additionalProperties": false,
                          "required": ["label"],
                          "properties":
                            {
                              "label": { "type": "string" },
                              "description": { "type": "string" },
                            },
                        },
                    },
                },
            },
        },
      "deadline": { "$ref": "#/$defs/deadline" },
    },
}
```

- Output:

```yaml
{
  "type": "object",
  "properties":
    {
      "payload": {},
      "answered": { "type": "boolean" },
      "timeout": { "type": "boolean" },
    },
}
```

### `on-issue-change`

Pause until the bound issue changes and its authored condition matches.

- Pausing: yes
- Results: `changed`, `timeout`
- Context keys written: `<node-id>`
- Inputs and defaults:

```yaml
{
  "type": "object",
  "additionalProperties": false,
  "properties":
    {
      "when": { "$ref": "#/$defs/expression" },
      "bindings":
        {
          "type": "object",
          "propertyNames": { "$ref": "#/$defs/slug" },
          "additionalProperties": { "type": "string", "minLength": 1 },
        },
      "deadline": { "$ref": "#/$defs/deadline" },
    },
}
```

- Output:

```yaml
{
  "type": "object",
  "properties":
    {
      "payload": {},
      "changed": { "type": "boolean" },
      "timeout": { "type": "boolean" },
    },
}
```

### `github`

Apply one GitHub operation to the bound issue or repository.

- Pausing: no
- Results: none
- Context keys written: `<node-id>`, `issue`
- Inputs and defaults:

```yaml
{
  "type": "object",
  "required": ["operation"],
  "properties":
    {
      "operation":
        {
          "type": "string",
          "enum":
            [
              "set-field",
              "comment",
              "add-labels",
              "remove-labels",
              "close",
              "reopen",
              "open-pull-request",
              "request-review",
              "link",
            ],
        },
    },
  "additionalProperties": true,
}
```

- Output:

```yaml
{}
```

### `git`

Apply one Git worktree, branch, merge, or push operation.

- Pausing: no
- Results: none
- Context keys written: `<node-id>`
- Inputs and defaults:

```yaml
{
  "type": "object",
  "required": ["operation"],
  "properties":
    {
      "operation":
        {
          "type": "string",
          "enum":
            ["worktree-add", "worktree-remove", "branch", "merge", "push"],
        },
    },
  "additionalProperties": true,
}
```

- Output:

```yaml
{}
```

### `terminal-result`

Set the run's final result.

- Pausing: no
- Results: none
- Context keys written: `<node-id>`, `result`
- Inputs and defaults:

```yaml
{
  "description": "Final run data, persisted as context.result and returned through outputs.result.",
  "type": "object",
  "additionalProperties": false,
  "required": ["value"],
  "properties": { "value": { "$ref": "#/$defs/valueOrRef" } },
}
```

- Output:

```yaml
{}
```

### `aggregate`

Collect named predecessor outputs into one object.

- Pausing: no
- Results: none
- Context keys written: `<node-id>`
- Inputs and defaults:

```yaml
{
  "description": "Named results of every direct predecessor, in authored binding order.",
  "type": "object",
  "additionalProperties": false,
  "required": ["bindings"],
  "properties":
    {
      "bindings":
        {
          "type": "object",
          "minProperties": 1,
          "additionalProperties":
            {
              "type": "object",
              "additionalProperties": false,
              "required": ["node"],
              "properties":
                {
                  "node": { "$ref": "#/$defs/slug" },
                  "path":
                    {
                      "description": "JSONata expression relative to the predecessor output; absent selects the entire output.",
                      "$ref": "#/$defs/expression",
                    },
                },
            },
        },
    },
}
```

- Output:

```yaml
{ "type": "object" }
```

### `notify`

Send a notification through a configured channel.

- Pausing: no
- Results: none
- Context keys written: `<node-id>`
- Inputs and defaults:

```yaml
{
  "type": "object",
  "additionalProperties": false,
  "required": ["channel", "title"],
  "properties":
    {
      "channel": { "type": "string", "enum": ["pushover"] },
      "title": { "$ref": "#/$defs/templateRef" },
      "message": { "$ref": "#/$defs/templateRef" },
      "url": { "$ref": "#/$defs/valueOrRef" },
    },
}
```

- Output:

```yaml
{}
```

### `policy`

Evaluate an ordered policy-rule artifact against an input.

- Pausing: no
- Results: none
- Context keys written: `<node-id>`
- Inputs and defaults:

```yaml
{
  "type": "object",
  "additionalProperties": false,
  "required": ["rules"],
  "properties":
    {
      "rules": { "$ref": "#/$defs/path" },
      "input": { "$ref": "#/$defs/contextRef" },
    },
}
```

- Output:

```yaml
{}
```

### `sleep`

Pause for an authored duration.

- Pausing: yes
- Results: none
- Context keys written: `<node-id>`
- Inputs and defaults:

```yaml
{
  "type": "object",
  "additionalProperties": false,
  "required": ["duration"],
  "properties": { "duration": { "$ref": "#/$defs/deadline" } },
}
```

- Output:

```yaml
{ "type": "object", "properties": { "payload": {} } }
```

### `wait`

Pause for an external resume, with an optional authored deadline.

- Pausing: yes
- Results: none
- Context keys written: `<node-id>`
- Inputs and defaults:

```yaml
{
  "type": "object",
  "additionalProperties": false,
  "properties": { "deadline": { "$ref": "#/$defs/deadline" } },
}
```

- Output:

```yaml
{ "type": "object", "properties": { "payload": {} } }
```

## Validation rules

- `yaml.parse`: The source is valid YAML 1.2.
- `blueprint.schema`: The document satisfies the blueprint JSON Schema.
- `blueprint.id`: The blueprint id matches the source filename.
- `node.params`: Node params satisfy the registered node-type schema.
- `repository.child-missing`: Every child-run target exists in the complete repository.
- `repository.child-duplicate`: A child-run target resolves to exactly one blueprint file.
- `repository.child-kind`: A stage-marked child-run targets a stage blueprint.
- `repository.child-output-path`: Direct child output mapping paths are declared by the child.
- `repository.output-schema`: Blueprint output declarations are valid JSON Schemas.
- `repository.output-shape`: Known terminal shapes do not contradict declared outputs.result.
- `repository.child-output-shape`: A mapped child result has no statically proven terminal shape contradiction.
- `reference.exists`: Referenced templates, schemas, and rules files exist.
- `handoff.schema`: Handoff schemas satisfy JSON Schema and MCP constraints.
- `policy.schema`: Policy rule artifacts satisfy the policy rule JSON Schema.
- `policy.rule-id`: Policy rule ids are unique within one artifact.
- `policy.fallback-order`: No policy rule follows a condition-less fallback.
- `expression.jsonata`: Every condition is valid JSONata syntax.
- `heddle.owned-field`: GitHub nodes do not write service-owned Status or Paused fields.
- `heddle.no-subflow`: Blueprints do not use the Flowcraft subflow node.
- `heddle.entry`: Entry is declared only when every node has an incoming edge, and names an authored node.
- `heddle.no-action-edge`: Blueprint edges do not declare Flowcraft actions.
- `heddle.unhandled-result`: Every named result of a pausing node has an outgoing edge.
- `heddle.question-role`: Every question role has a configured channel.
- `heddle.context-key`: Statically identifiable context roots have a possible provider.
- `heddle.issue-change-binding`: Every issue-change variable names an explicit immutable binding.
- `flowcraft.lint`: The derived Flowcraft blueprint passes its linter.
- `roundtrip.bytes`: An unchanged loaded document saves byte-for-byte.
- `requires.issue.live`: Live project requirements are checked when requested.
- `requires.issue.stage-name`: Stage node names are live project single-select options when requested.

## Shipped blueprints

- `blueprints/default-intake.yml`
- `blueprints/hold-then-attention.yml`

## Harness hook files

### claude

- `.claude-plugin/marketplace.json`
- `plugins/heddle/.claude-plugin/plugin.json`
- `plugins/heddle/hooks/hooks.json`

### codex

- `.agents/plugins/marketplace.json`
- `plugins/heddle/.codex-plugin/plugin.json`
- `plugins/heddle/hooks/hooks.json`
