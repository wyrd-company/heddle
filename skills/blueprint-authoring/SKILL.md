---
name: blueprint-authoring
description: Author and repair Heddle blueprint repositories from the embedded node contracts. Use when creating or editing Heddle blueprint YAML, referenced templates, handoff schemas, policy rules, or child-run compositions.
metadata:
  relationships:
    implements: blueprint-authoring
---

# Author Heddle blueprints

Read `references/blueprint-author-reference.md` before editing. It is generated from the same contracts that Heddle validates.

Use generic names and scenarios. Keep every referenced template, schema, and rule file beside its blueprint. Use condition edges for routing and route every named result of each pausing node. Do not use action edges or Flowcraft subflows.

After every blueprint or referenced-file edit, run:

```sh
heddle validate --json <file-or-repository>
```

Read every finding, fix it, and rerun the same command. Continue until the JSON output is `[]`. Do not treat readable YAML, schema validation alone, or an earlier clean run as validation of the latest edit.

Heddle dispatches nodes sequentially. Do not author or document a workflow that depends on concurrent node execution.
