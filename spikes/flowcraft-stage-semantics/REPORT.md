---
relationships:
  references: [spike/probes.mjs, spike/timers.mjs]
---
# Flowcraft spike

Tested **flowcraft 2.10.1 from npm**, matching `packages/core/package.json`; Node v24.20.0.
Reference checkout: `584967b418acba89ff3abf8695c8ba85a0c6be3d` (clean).
All writes and installation are in this scratch directory. No queue adapter.
Source links below refer to `/workspaces/references/flowcraft/packages/core/src`.

Re-run from this directory (each command must succeed):
```sh
npm ci --cache ./npm-cache
node spike/probes.mjs > spike/probes.out 2>&1
node spike/timers.mjs > spike/timers.out 2>&1
node spike/timers.mjs save > spike/durability.out 2>&1
node spike/timers.mjs restore >> spike/durability.out 2>&1
```
The last two commands are separate OS processes. Other resume probes create fresh runtimes, except timer races, which deliberately retain the live scheduler.
Full output: [probes](spike/probes.out), [timer races](spike/timers.out), [durability](spike/durability.out); [installation](spike/install.txt).

## 1. Subflow pause/resume — BROKEN

Evidence: [spike/probes.mjs](spike/probes.mjs), `subflow` lines in [captured output](spike/probes.out).
Parent `stage` uses `subflow`; child `gate` marks awaiting, then feeds `childEnd`; parent continues to `after`.
Output map is `{ mapped: 'childEnd' }`. Observed:

| Probe | Status / executed nodes | Mapped output |
| --- | --- | --- |
| Run parent | `awaiting`; parent awaits `stage` | absent |
| Resume parent with child ID `gate` | `Cannot resume: Node 'gate' is not in an awaiting state.` | absent |
| Resume parent with parent ID `stage` | `completed`; only `after` runs | absent; `after` returns null |
| Explicitly register/use `SubflowNode`, resume `stage` | `completed`; `childEnd`, `after` run | still absent; `after` returns null |
| Resume extracted child directly | `completed`; `childEnd` runs | child output `{ "value": 7 }` |
| Flatten stage into parent | `completed`; `childEnd` runs | downstream output `{ "value": 7 }` |

Exact standard call tested:
```js
await new FlowRuntime({ registry, blueprints: { child } }).resume(
  parent, paused.serializedContext,
  { action: 'handoff', output: { value: 7 } }, 'stage'
);
```
Use the **whole parent serialized context** (saved in [parent-subflow.json](spike/parent-subflow.json)).
It contains `_awaitingNodeIds: ["stage"]` and `_subflowState.stage`, a JSON **string** containing the child context awaiting `gate`.
The standard call marks `stage` complete without continuing the child; its nested paused state remains in the returned context.

Cause: [runtime/runtime.ts:449](/workspaces/references/flowcraft/packages/core/src/runtime/runtime.ts:449) checks `uses === 'SubflowNode'`, while the built-in registry uses `subflow`.
The explicit class alias activates recursive resume, but [runtime/runtime.ts:513](/workspaces/references/flowcraft/packages/core/src/runtime/runtime.ts:513) returns the entire child context without applying the named output map.
The normal execution mapping loop exists in [nodes/subflow.ts:93](/workspaces/references/flowcraft/packages/core/src/nodes/subflow.ts:93).

Tested workaround: flatten the child nodes and resume `gate` with the flat run's serialized context.
Child-only recovery also works with this call, but does not finish the parent:
```js
await freshRuntime.resume(child,
  JSON.parse(paused.serializedContext)['_subflowState.stage'],
  { action: 'handoff', output: { value: 7 } }, 'gate');
```
A custom wrapper that persists/resumes the child and maps its outputs would need its own orchestration; that wrapper was not implemented or validated here.

## 2. Wait with timer beside it — BROKEN

Evidence: [spike/timers.mjs](spike/timers.mjs), [captured races](spike/timers.out).
Start fans out to built-in `wait` and `sleep` (150 ms); both feed `join` with `config: { joinStrategy: 'any' }`.
The scheduler is explicitly started with its default 1000 ms tick; the blueprint is registered.
Both nodes initially appear in `_awaitingNodeIds`.
Observed output fields, extracted from the capture:

| Event | Status | Still awaiting | Cumulative join inputs |
| --- | --- | --- | --- |
| Wait resumed before timer | awaiting | timer | `["human"]` |
| Timer fires afterward | awaiting | gate | `["human","seed"]` |
| Next scheduler tick | awaiting | gate | `["human","seed","seed"]` |
| Separate case: timer first | awaiting | gate | `["seed"]` |
| Late wait resumed from timer result | completed | none | `["seed","late-human"]` |
| Next scheduler tick | awaiting | gate | `["seed","late-human","seed"]` |

Neither loser is cancelled or ignored. The join is not a first-winner latch. The scheduler remains registered even after the separate manual resume reports completion.
Causes:
- [runtime/runtime.ts:574](/workspaces/references/flowcraft/packages/core/src/runtime/runtime.ts:574) clears only the selected awaiting node; lines 569–571 explicitly enqueue its successors even if already completed.
- [runtime/traverser.ts:197](/workspaces/references/flowcraft/packages/core/src/runtime/traverser.ts:197) permits an `any` join to run again.
- [runtime/scheduler.ts:81](/workspaces/references/flowcraft/packages/core/src/runtime/scheduler.ts:81) resumes the originally registered serialized snapshot. Lines 89–93 store the result but only unregister completed/failed runs; an awaiting result leaves the stale snapshot registered for another tick.

**Durability: WORKS WITH CAVEATS for deadline data, not automatic timer recovery.**
[Separate-process capture](spike/durability.out): producer exits with one registration; fresh runtime with scheduler started reports `{"registered":0,"calls":[]}` after the deadline.
Manual overdue `resume(bp, serialized, {output:'timeout'}, 'timer')` executes the join and leaves `gate` awaiting.
Explicit `scheduler.registerAwaitingWorkflow(...)` from saved execution ID, blueprint ID, serialized context, timer node ID and `wakeUpAt` also triggers the timer.
The deadline persists under `_awaitingDetails.timer`; the scheduler registration lives only in a [Map at runtime/scheduler.ts:15](/workspaces/references/flowcraft/packages/core/src/runtime/scheduler.ts:15).

Recommendation: use one wait and an external scheduler that resumes it with action `timeout`, using the condition-edge workaround below. The external owner must arbitrate competing responses; this spike does not establish atomic winner selection across processes. A sibling run alone does not supply that arbitration.

## 3. Action edges — BROKEN; condition workaround WORKS

Evidence: [spike/probes.mjs](spike/probes.mjs), final lines of [captured output](spike/probes.out).
The requested version is still **2.10.1**, not a newer release. These defects are not fixed in the tested package.
Resuming a wait with `{action:'escalate', output:...}` and three action-only edges produces `status: "completed", calls: []`: **no branch runs**.
Direct `GraphTraverser.fromState()` probe returns `["handoff","escalate","timeout"]`.
Adding one default successor makes resume reach traversal and produces:
```text
action edges with default {"status":"completed","calls":["handoff","escalate","timeout","fallback"]}
```
Cause: [runtime/runtime.ts:537](/workspaces/references/flowcraft/packages/core/src/runtime/runtime.ts:537) constructs `{output: nodeOutput}`, dropping `resumeData.action`.
Lines 546–550 return completed immediately when no edges match, explaining the action-only result.
[Runtime traversal at runtime/traverser.ts:83](/workspaces/references/flowcraft/packages/core/src/runtime/traverser.ts:83) excludes condition edges, not action edges; lines 100–108 re-add all ready action successors.

Tested workaround: omit edge `action`; set each edge condition to `result.output.handoff`, `result.output.escalate`, or `result.output.timeout`.
```js
await freshRuntime.resume(bp, paused.serializedContext, {
  action: 'escalate',
  output: { handoff: false, escalate: true, timeout: false }
}, 'gate');
```
Captured result: `status: "completed", calls: ["escalate"]`; asserted by the script.
This uses the built-in PropertyEvaluator; the booleans in output route the edges, not the top-level action.

## 4. Awaiting details — WORKS

Evidence: custom `Pause` in [spike/probes.mjs](spike/probes.mjs), `details` output and [serialized snapshot](spike/details.json).
After `await context.dependencies.workflowState.markAsAwaiting(this.nodeId, {threadId:'abc'})`, serialized JSON contains:
```json
{"_awaitingNodeIds":["gate"],"_awaitingDetails":{"gate":{"threadId":"abc"}},"_executionId":"<run UUID>"}
```
Only the UUID is abbreviated above. An external process can parse this object and inspect `_awaitingDetails.gate.threadId`.
[Runtime state at runtime/state.ts:97](/workspaces/references/flowcraft/packages/core/src/runtime/state.ts:97) writes both awaiting fields; lines 33–34 restore details.
For a subflow, these details are inside the JSON string `_subflowState.stage`; the parent's `_awaitingDetails` is `{}` ([nodes/subflow.ts:71](/workspaces/references/flowcraft/packages/core/src/nodes/subflow.ts:71)). Flowcraft does not provide a thread-ID index in this test.
