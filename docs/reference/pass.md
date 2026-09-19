---
relationships:
  implements: node-types
  references:
    - agent-tools
    - engine-and-run-model
---

# Pass

A `pass` node starts one agent turn on a T3 Code thread and waits for a workflow result.
Inputs come from `params`. Node metadata is available to prompt templates; it does
not configure the node.

| Input                    | Meaning                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                 | A Nunjucks template path at the run's pinned commit, or `{ inline: text }`.                                               |
| `handoff`                | A schema path at the pinned commit, or a JSON Schema object with a root description.                                      |
| `model`                  | A model selection, or model name using the configured provider instance. Omission uses the service default.               |
| `runtimeMode`            | Defaults to `full-access`.                                                                                                |
| `worktree`               | T3 project workspace and thread worktree. Omission uses the service default.                                              |
| `resumeThread`           | An earlier pass node name, or a context reference resolving to a T3 thread ID.                                            |
| `tools`                  | Additional `{ name, endpoint }` declarations. The service supplies authorization for each declared identity and endpoint. |
| `turnEndPolicy`          | `require-handoff` by default, or `allow`.                                                                                 |
| `escalation`             | `answer-in-place` by default, or `ends-stage`.                                                                            |
| `deadline`, `inactivity` | Engine wake-up durations. Observed activity postpones inactivity.                                                         |

The node records `stages.<nodeId>.visits`, `.threadId`, and `.handoff`. The handoff
payload is available before the next node renders its prompt. Results are `handoff`,
`escalate`, `timeout`, `idle`, `turnEnded`, and `overridden`; blueprint edges select
the continuation. An observed turn end includes the current policy and a missing
handoff reminder when that policy is `require-handoff`. The blueprint owns any
continuation limit.

`PassService.node` is the `pass` implementation. Connect `PassService.synchronize`
to `WorkflowEngine`'s `onBoundary` callback. Serve `PassService.tools.handle` at the
configured tool origin. Run `PassService.recover()` before accepting hook requests,
then serve `HookServer` with `PassService.sessions` on the local hook socket.
The application supplies a direct-library T3 client, default model and worktree,
and a commit-pinned artifact reader. Additional tool authorization is injected
service configuration; generated pass tokens are never sent to extra endpoints.

The invocation, rendered prompt, stable thread and command IDs, subscription cursor,
and read model use the engine's existing SQLite writer. The first turn starts after
the awaiting row commits and the engine releases its traversal claim. Recovery
replays from the stored cursor and sends the same command identity if an
acknowledgement was lost. Native session mappings remain empty until the T3
subscription has synchronized.

A resumed thread retains its conversation. Heddle first removes the prior pass
mapping and observes its turn settlement. It then stops the provider session,
observes the cleared native identity, registers the next pass's tool endpoint, and
starts its turn on that thread. T3 retains the native resume cursor. A trailing Stop
from the prior turn returns allow before the next mapping exists.

The read model records observed turns, including turns started in the T3 UI,
activity, cumulative total-token deltas by model, helper usage snapshots, context ratios, compaction
outcomes, open requests, and the current policy. It uses subscription events rather
than polling. Terminal and failed passes lose their mapping and credential before
remote registration cleanup; a late registration response cannot restore access.
The reusable [profile plugins](agent-tools.md) remain installed.

A retired pass keeps a read-only observer until its last observed turn settles, so
usage reported after handoff remains with that pass. Credentials, mappings, and
registrations are removed immediately. A reused pass excludes earlier activity
until its own start message appears. Model totals use the cumulative processed-token
counter; latest-request input/output counters are not summed as cumulative usage.
