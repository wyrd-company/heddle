---
name: blueprint-authoring
description: Author and repair Heddle blueprint repositories from the embedded node contracts. Use when creating or editing Heddle blueprint YAML, referenced templates, handoff schemas, policy rules, or child-run compositions.
metadata:
  relationships:
    implements: blueprint-authoring
---

# Author Heddle blueprints

Read `references/blueprint-author-reference.md` before editing. It is generated from the same contracts that Heddle validates.

Node ids are hyphenated slugs and JSONata reads a bare hyphen as subtraction, so inside any expression a node, input, or output id is written in backticks - `start-hold`.payload, never start-hold.payload - and the whole expression is then quoted in YAML.

Use generic names and scenarios. Write every path - template, handoff schema, policy rules, and every `include`, `import`, and `extends` target - relative to the blueprint root, the directory Heddle is pointed at, and never above it; a blueprint in a subdirectory of the root prefixes its paths with that subdirectory. Use condition edges for routing and route every named result of each pausing node. Do not use action edges or Flowcraft subflows.

After every blueprint or referenced-file edit, run:

```sh
heddle validate --json <file-or-blueprint-root>
```

Read every finding, fix it, and rerun the same command. Continue until the JSON output is `[]`. Do not treat readable YAML, schema validation alone, or an earlier clean run as validation of the latest edit.

Heddle dispatches nodes sequentially. Do not author or document a workflow that depends on concurrent node execution.
