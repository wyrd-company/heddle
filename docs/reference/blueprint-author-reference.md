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

Every completed node writes its output below its authored node id. A pausing result is also exposed during edge routing as `result.output.<result>`; its wake payload is `result.output.payload`. Every node marked `stage: true` writes its visit count to `stages.<node-id>.visits`, whatever its node type, before the edges leaving it are evaluated.

The running blueprint is a reserved context root. Edge conditions, `{ from: <expression> }` references, and templates read `blueprint.id` and `blueprint.metadata`, the blueprint's own top-level metadata bag, which is `{}` when none is authored. A child run reads its own blueprint, never its parent's.

## Templates

One renderer serves every `templateRef`. A string is a path from the blueprint root, `{ inline }` is template text, and both render as Nunjucks with autoescaping off and undefined values fatal. Each template reads the run context, the running blueprint as `blueprint`, and the node's own `metadata`, `node`, and `input`.

A `templateRef` path is read from the run's pinned commit and resolves from the blueprint root, the directory Heddle is pointed at, whatever subdirectory holds the blueprint file. A template may load another with `include`, `import`, or `extends`; those targets resolve from that same blueprint root at the same pinned commit. A target that leaves the blueprint root is refused.

## Minimal blueprint

```yaml
id: sample-process
kind: helper
nodes:
  hold:
    uses: wait
  finish:
    uses: terminal-result
    params:
      value: done
edges:
  - from: hold
    to: finish
```

## Blueprint document

The complete authored document shape is below. Node-type inputs follow in the catalog.

```yaml
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://heddle.wyrd.company/schemas/blueprint",
  "title": "Heddle blueprint",
  "description": "A workflow blueprint authored as YAML. Nodes are keyed by id. Edges route on expressions over the run context. Node-type inputs live under `params` and are checked against the node type's own contract in addition to this schema. Comments in the source file are not part of the data model and are preserved by every conforming writer.\n",
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "kind", "nodes"],
  "properties":
    {
      "id":
        {
          "description": "Blueprint id. Also the file's basename without extension.",
          "$ref": "#/$defs/slug",
        },
      "entry":
        {
          "description": "The node where execution begins when every node has an incoming edge, such as a process with a retry cycle. It must name a key in `nodes`. A blueprint with a natural entry node must omit it.\n",
          "$ref": "#/$defs/slug",
        },
      "kind":
        {
          "description": "`process` blueprints belong to the user and route on stage outcomes. `stage` blueprints are run by `child-run` nodes and end on the stage result contract. `helper` blueprints are small plumbing runs such as intake, answer-question, and hold-then-attention.\n",
          "type": "string",
          "enum": ["process", "stage", "helper"],
        },
      "description": { "type": "string" },
      "metadata":
        {
          "description": "A bag available to every node in the run as `blueprint.metadata` and to templates. Authors put process-level configuration here, such as thresholds guards read.\n",
          "$ref": "#/$defs/bag",
        },
      "requires":
        {
          "description": "What this blueprint needs from the issue and the project.",
          "type": "object",
          "additionalProperties": false,
          "properties":
            {
              "issue":
                {
                  "type": "object",
                  "additionalProperties": false,
                  "properties":
                    {
                      "type":
                        {
                          "description": "Organization issue types this blueprint accepts.",
                          "type": "array",
                          "items": { "type": "string" },
                        },
                      "fields":
                        {
                          "description": "Project or organization fields the blueprint reads.",
                          "type": "array",
                          "items": { "type": "string" },
                        },
                      "labels":
                        { "type": "array", "items": { "type": "string" } },
                      "frontMatter":
                        {
                          "description": "Keys the blueprint reads from YAML front matter carried in a Markdown comment block in the issue description.\n",
                          "type": "array",
                          "items": { "type": "string" },
                        },
                    },
                },
            },
        },
      "inputs":
        {
          "description": "For `stage` and `helper` blueprints: the initial context keys a parent must supply, each with a JSON Schema. Process blueprints receive the issue automatically and may declare additional lifecycle-start inputs.\n",
          "type": "object",
          "additionalProperties": { "$ref": "#/$defs/jsonSchema" },
        },
      "outputs":
        {
          "description": "For `stage` and `helper` blueprints: the final context keys returned to the parent, each with a JSON Schema. A stage blueprint's outputs always include `result`.\n",
          "type": "object",
          "additionalProperties": { "$ref": "#/$defs/jsonSchema" },
        },
      "nodes":
        {
          "type": "object",
          "minProperties": 1,
          "propertyNames": { "$ref": "#/$defs/slug" },
          "additionalProperties": { "$ref": "#/$defs/node" },
        },
      "edges": { "type": "array", "items": { "$ref": "#/$defs/edge" } },
    },
}
```

### Shared schema definitions

```yaml
{
  "slug": { "type": "string", "pattern": "^[a-z][a-z0-9]*(-[a-z0-9]+)*$" },
  "path":
    {
      "description": "A path relative to the blueprint root. It never reaches above the root, whichever subdirectory holds the blueprint file.\n",
      "type": "string",
      "pattern": "^(?!/)(?!.*\\.\\./).+$",
    },
  "bag": { "type": "object", "additionalProperties": true },
  "expression":
    {
      "description": "A JSONata expression evaluated over `result` and the run context. Node ids are hyphenated slugs, and JSONata reads a bare hyphen as subtraction, so every hyphenated node, input, or output name is written in backticks wherever an expression names it, as in `taste-test`.payload and stages.`taste-test`.visits. In YAML the whole expression is then quoted.\n",
      "type": "string",
      "minLength": 1,
    },
  "jsonSchema":
    {
      "description": "A JSON Schema Draft 2020-12 object, written in YAML.",
      "type": "object",
    },
  "templateRef":
    {
      "description": "A Nunjucks template, given as a path from the blueprint root or inline. Every template renders the same way, with the task context, the running blueprint, and the node's own metadata, definition, and input. A path is read from the run's pinned commit. `include`, `import`, and `extends` targets are paths from the blueprint root at that same commit, and a target outside the root is refused.\n",
      "oneOf":
        [
          { "$ref": "#/$defs/path" },
          {
            "type": "object",
            "additionalProperties": false,
            "required": ["inline"],
            "properties": { "inline": { "type": "string" } },
          },
        ],
    },
  "schemaRef":
    {
      "description": "A JSON Schema written in YAML, given as a path from the blueprint root or inline.\n",
      "oneOf": [{ "$ref": "#/$defs/path" }, { "$ref": "#/$defs/jsonSchema" }],
    },
  "contextRef":
    {
      "description": "A value taken from the run context at execution time, written as `{ from: <expression> }`.\n",
      "type": "object",
      "additionalProperties": false,
      "required": ["from"],
      "properties": { "from": { "$ref": "#/$defs/expression" } },
    },
  "valueOrRef":
    {
      "anyOf":
        [
          { "$ref": "#/$defs/contextRef" },
          { "not": { "type": "object", "required": ["from"] } },
        ],
    },
  "node":
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["uses"],
      "properties":
        {
          "uses":
            {
              "description": "The node type. Shipped node types are listed in `$defs`.",
              "type": "string",
            },
          "description": { "type": "string" },
          "stage":
            {
              "description": "Marks a node whose entry is projected to the bound project's Status field. Defaults to true for `child-run` of a `stage` blueprint.\n",
              "type": "boolean",
            },
          "metadata":
            {
              "description": "A bag merged into the node's context as `node.metadata`. Keys with the same name on the issue take precedence unless listed in `fixed`.\n",
              "$ref": "#/$defs/bag",
            },
          "fixed":
            {
              "description": "Metadata keys the issue may not override.",
              "type": "array",
              "items": { "type": "string" },
            },
          "params":
            {
              "description": "Node-type inputs. Checked against the node type's contract.",
              "type": "object",
              "additionalProperties": true,
            },
          "inputs":
            {
              "description": "Flowcraft input mapping: a context key, or a map of input names to context keys, populated into the node's `input`.\n",
              "oneOf":
                [
                  { "type": "string" },
                  {
                    "type": "object",
                    "additionalProperties": { "type": "string" },
                  },
                ],
            },
          "config":
            {
              "type": "object",
              "additionalProperties": false,
              "properties":
                {
                  "joinStrategy": { "type": "string", "enum": ["all", "any"] },
                  "maxRetries": { "type": "integer", "minimum": 0 },
                  "retryDelay": { "type": "integer", "minimum": 0 },
                },
            },
        },
      "allOf":
        [
          {
            "if": { "properties": { "uses": { "const": "child-run" } } },
            "then":
              {
                "properties":
                  { "params": { "$ref": "#/$defs/childRunParams" } },
                "required": ["params"],
              },
          },
          {
            "if": { "properties": { "uses": { "const": "lifecycle-start" } } },
            "then":
              {
                "properties":
                  { "params": { "$ref": "#/$defs/lifecycleStartParams" } },
                "required": ["params"],
              },
          },
          {
            "if": { "properties": { "uses": { "const": "pass" } } },
            "then":
              {
                "properties": { "params": { "$ref": "#/$defs/passParams" } },
                "required": ["params"],
              },
          },
          {
            "if": { "properties": { "uses": { "const": "question" } } },
            "then":
              {
                "properties":
                  { "params": { "$ref": "#/$defs/questionParams" } },
                "required": ["params"],
              },
          },
          {
            "if": { "properties": { "uses": { "const": "on-issue-change" } } },
            "then":
              {
                "properties":
                  { "params": { "$ref": "#/$defs/onIssueChangeParams" } },
              },
          },
          {
            "if": { "properties": { "uses": { "const": "github" } } },
            "then":
              {
                "properties": { "params": { "$ref": "#/$defs/githubParams" } },
                "required": ["params"],
              },
          },
          {
            "if": { "properties": { "uses": { "const": "git" } } },
            "then":
              {
                "properties": { "params": { "$ref": "#/$defs/gitParams" } },
                "required": ["params"],
              },
          },
          {
            "if": { "properties": { "uses": { "const": "terminal-result" } } },
            "then":
              {
                "properties":
                  { "params": { "$ref": "#/$defs/terminalResultParams" } },
                "required": ["params"],
              },
          },
          {
            "if": { "properties": { "uses": { "const": "aggregate" } } },
            "then":
              {
                "properties":
                  { "params": { "$ref": "#/$defs/aggregateParams" } },
                "required": ["params"],
              },
          },
          {
            "if": { "properties": { "uses": { "const": "notify" } } },
            "then":
              {
                "properties": { "params": { "$ref": "#/$defs/notifyParams" } },
                "required": ["params"],
              },
          },
          {
            "if": { "properties": { "uses": { "const": "policy" } } },
            "then":
              {
                "properties": { "params": { "$ref": "#/$defs/policyParams" } },
                "required": ["params"],
              },
          },
          {
            "if": { "properties": { "uses": { "const": "sleep" } } },
            "then":
              {
                "properties": { "params": { "$ref": "#/$defs/sleepParams" } },
                "required": ["params"],
              },
          },
          {
            "if": { "properties": { "uses": { "const": "wait" } } },
            "then":
              { "properties": { "params": { "$ref": "#/$defs/waitParams" } } },
          },
        ],
    },
  "edge":
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["from", "to"],
      "properties":
        {
          "from": { "$ref": "#/$defs/slug" },
          "to": { "$ref": "#/$defs/slug" },
          "when":
            {
              "description": "Condition. A pausing node's results appear as booleans under `result.output`, so the common form is `result.output.<result>`. Absent means unconditional. Edges never carry an `action`.\n",
              "$ref": "#/$defs/expression",
            },
          "description": { "type": "string" },
        },
    },
  "deadline":
    {
      "description": "An ISO 8601 duration after which the node wakes with result `timeout`.\n",
      "type": "string",
      "pattern": "^P(?!$)(\\d+Y)?(\\d+M)?(\\d+W)?(\\d+D)?(T(?=\\d)(\\d+H)?(\\d+M)?(\\d+S)?)?$",
    },
}
```

## Node types

The catalog below publishes every designed node type and, for a node type that takes an operation, every designed operation, each marked available or not. `heddle validate` rejects a blueprint that uses a node type or an operation that is not available yet.

### `child-run`

Start a child blueprint and pause until it completes.

- Available: yes
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
          "additionalProperties": { "$ref": "#/$defs/expression" },
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

- Available: yes
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

- Available: yes
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

- Available: no, Heddle has no run-time implementation for it yet
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

- Available: yes
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
          "additionalProperties": { "$ref": "#/$defs/expression" },
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

- Available: yes
- Operations: `set-field`, `comment`, `add-labels`, `remove-labels`, `close`, `reopen`, `open-pull-request` (not available yet), `request-review` (not available yet), `link` (not available yet)
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
  "allOf":
    [
      {
        "if":
          {
            "required": ["operation"],
            "properties": { "operation": { "const": "set-field" } },
          },
        "then":
          {
            "required": ["field", "value"],
            "properties":
              {
                "field": { "type": "string" },
                "scope": { "enum": ["project", "organization"] },
              },
          },
      },
      {
        "if":
          {
            "required": ["operation"],
            "properties": { "operation": { "const": "comment" } },
          },
        "then":
          {
            "required": ["body"],
            "properties": { "body": { "type": "string" } },
          },
      },
      {
        "if":
          {
            "required": ["operation"],
            "properties": { "operation": { "const": "add-labels" } },
          },
        "then":
          {
            "required": ["labels"],
            "properties":
              { "labels": { "type": "array", "items": { "type": "string" } } },
          },
      },
      {
        "if":
          {
            "required": ["operation"],
            "properties": { "operation": { "const": "remove-labels" } },
          },
        "then":
          {
            "required": ["labels"],
            "properties":
              { "labels": { "type": "array", "items": { "type": "string" } } },
          },
      },
      {
        "if":
          {
            "required": ["operation"],
            "properties": { "operation": { "const": "close" } },
          },
        "then":
          {
            "properties":
              { "reason": { "enum": ["completed", "not-planned"] } },
          },
      },
    ],
}
```

- Output:

```yaml
{}
```

### `git`

Apply one Git worktree, branch, merge, or push operation.

- Available: no, Heddle has no run-time implementation for it yet
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

- Available: yes
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

- Available: yes
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

- Available: yes
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

- Available: yes
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
      "rules":
        {
          "description": "The policy rule artifact, as a path from the blueprint root.",
          "$ref": "#/$defs/path",
        },
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

- Available: yes
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

- Available: yes
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
- `expression.hyphenated-name`: An expression quotes a hyphenated node, input, or output name instead of subtracting it.
- `heddle.owned-field`: GitHub nodes do not write service-owned Status or Paused fields.
- `heddle.unavailable-node-type`: Every node type a blueprint uses has a run-time implementation.
- `heddle.unavailable-operation`: Every node operation a blueprint uses has a run-time implementation.
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
