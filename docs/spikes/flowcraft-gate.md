# Spike: flowcraft gate tests for the Heddle lifecycle engine

Evaluation of `flowcraft` 2.10.1 (+ `@flowcraft/sqlite-history` 1.0.0-alpha.1,
`@flowcraft/tldraw` source) as the interpreter for Heddle task lifecycles.
Source reference: `/workspaces/references/flowcraft`.

Lifecycle under test: implement -> review (wait) -> approve -> merge ->
retrospective -> done, with reject -> remediate -> review as a cycle.
Blueprint: `blueprint.js`. Driver: `spike.js`. Viewer harness: `viewer/`.

## Gate 1 — External-event resume across processes: PASS (with caveats)

Every step below is a separate OS process (distinct pids); state between
processes lives only in `data/<instance>.json` (serialized context) and
`data/history.sqlite` (event log).

```
node spike.js start inst-1            # pid A: runs implement, awaits at review, exits
node spike.js resume inst-1 reject    # pid B: remediate round 1, awaits at review again
node spike.js resume inst-1 reject    # pid C: remediate round 2, awaits again
node spike.js resume inst-1 approve   # pid D: merge -> retrospective -> done, completed
```

Observed output (pids prove process separation):

```
[pid 204029] implement: agent session produced a change set
[pid 204029] instance=inst-1 status=awaiting
[pid 204036] remediate: applying review feedback (round 1)
[pid 204036] instance=inst-1 status=awaiting
[pid 204043] remediate: applying review feedback (round 2)
[pid 204043] instance=inst-1 status=awaiting
[pid 204050] merge: merging after approval by alice
[pid 204050] retrospective: capturing learnings
[pid 204050] done: lifecycle complete
[pid 204050] instance=inst-1 status=completed
```

`FlowRuntime.resume(blueprint, serializedContext, resumeData, nodeId)` needs
only the blueprint, the registry, and the serialized context string. No
in-memory runtime state from the `start` process is required.

### Caveats (all reproduced, all with workarounds)

1. **Action-labeled edges are broken on resume.** The documented HITL pattern
   (`.edge('review', 'merge', { action: 'approve' })`, resume with
   `{ action: 'approve' }`) fails two independent ways:
   - `FlowRuntime.resume()` builds `nodeResult = { output: nodeOutput }` and
     drops `resumeData.action` before edge matching
     (`packages/core/src/runtime/runtime.ts:534`, dist
     `runtime.mjs:311`). Action edges therefore never match; with only action
     edges the resume returns `status: 'completed'` while the workflow
     silently goes nowhere.
   - Even with the action re-injected (we shimmed `determineNextNodes`),
     `GraphTraverser.fromState()` re-adds EVERY non-condition-edge successor
     of a completed node to the frontier
     (`packages/core/src/runtime/traverser.ts:64-110`); only `condition`
     edges are excluded (`hasOnlyConditionalIncomingEdges`,
     traverser.ts:78-89). Observed: a `reject` resume executed `merge`,
     `remediate`, and `retrospective`.
   **Workaround used:** express review routing as `condition` edges evaluated
   against the resume output (`result.output.approved` /
   `result.output.rejected`). Deterministic, safe with the default
   `PropertyEvaluator`, and respected by both `determineNextNodes` and
   `fromState`.
2. **Cycles need explicit `joinStrategy: 'any'`.** With the default `'all'`
   join, `review` (predecessors: implement, remediate) is never ready — the
   run ends immediately with `status: 'completed'` (not an error, not
   `stalled`) without executing the wait node. Both `review` and `remediate`
   need `config: { joinStrategy: 'any' }` to be re-runnable inside the cycle.
   `analyzeBlueprint` does report the cycle (`isDag: false`,
   `cycles: [[review, remediate, review]]`), and cycles are accepted unless
   `strict: true`.
3. **You persist the serialized context yourself.** flowcraft hands you
   `result.serializedContext`; durability of that string is your job. The
   sqlite adapter stores only the event history, not the resumable context.

## Gate 2 — Crash recovery: PASS (with the expected at-least-once caveat)

Scenario A, crash while awaiting: covered by Gate 1 by construction — every
process exits after persisting; `kill -9` of an idle service is
indistinguishable.

Scenario B, `kill -9` mid-node-execution:

```
node spike.js start inst-3                 # awaits at review, persists, exits
node spike.js resume-slow inst-3 &         # approve-resume, merge swapped for a 10s node
kill -9 <pid>                              # at t+3s, mid-merge
```

After the kill:

- `data/inst-3.json` still holds the pre-resume awaiting context
  (`status: awaiting`).
- The sqlite log ends mid-node — last rows:
  `edge:evaluate, node:skipped review, context:change x3, node:start merge` —
  with no `node:finish`. The partial execution is visible and diagnosable.

Recovery, in a fresh process, from disk state only:

```
node spike.js resume inst-3 approve bob-reviewer
# [pid 258951] merge -> retrospective -> done; final status: completed
```

The interrupted `merge` re-executed from scratch: node execution is
**at-least-once**; effects must be idempotent or guarded (fine for Heddle —
our stages are exactly the kind of external work that needs its own
idempotency anyway).

Event history is genuinely usable: `node spike.js history inst-3` dumps the
ordered per-execution log (workflow:start/resume, node:start/finish,
context:change per key, edge:evaluate, node:skipped, workflow:finish with
status), and `node spike.js replay inst-3` reconstructs final state from
events alone via `runtime.replay()` without executing node logic.

### Serialized context shape

Plain flat JSON, fully inspectable — safe to build tooling on:

```json
{
  "taskId": "inst-1",
  "_outputs.implement": { "changeSet": "cs-001" },
  "implement": { "changeSet": "cs-001" },
  "_inputs.review": { "changeSet": "cs-001" },
  "_awaitingNodeIds": ["review"],
  "_awaitingDetails": { "review": { "reason": "external_event" } },
  "_executionId": "..."
}
```

Underscore-prefixed keys are runtime bookkeeping; everything else is user
context. Note: node outputs are stored twice (`_outputs.<id>` and `<id>`).

## Gate 3 — Externally-driven live viewer: PASS

(a) **What the canvas subscribes to.** `useExecutionBridge(editor, eventBus)`
(`packages/ui/tldraw/src/runtime/ExecutionBridge.tsx:8`) subscribes to a
`@flowcraft/tldraw` `EventBus` (`src/sync/EventBus.ts:15`) — a trivial typed
pub/sub that implements core `IEventBus` (`emit(event)` — `packages/core/src/types.ts:335`)
and adds `on(type, handler)`. On `node:start|finish|error`, `context:change`,
`batch:*` it updates the tldraw shape `shape:<nodeId>` with status and data.
It does not know or care where events come from.

(b) **Can an external runtime feed it?** Yes. `FlowcraftCanvas`
(`src/components/FlowcraftCanvas.tsx:103`) hard-embeds `RuntimeControls`
(`src/runtime/RuntimeControls.tsx:18-25`), which constructs its own in-tab
`FlowRuntime` — that component is married to in-tab execution. But the
package publicly exports the primitives (`src/index.ts`): `EventBus`,
`useExecutionBridge`, `FlowcraftNodeUtil`, `FlowcraftSync`/`blueprintToCanvas`
(blueprint -> shapes, "visualization mode" is explicitly documented in
`src/sync/FlowcraftSync.ts`). `FlowcraftEvent`s are plain `{type, payload}`
JSON — they survive sqlite/websocket transport verbatim.

**Harness built** (`viewer/`, vite + react + tldraw 5.3): a page with NO
FlowRuntime that renders the blueprint via `FlowcraftSync.applyBlueprint` and
pipes a recorded service-process event log (`spike.js export-events` ->
sqlite -> `events.json`, 71 events) into an `EventBus` consumed by
`useExecutionBridge`. Reproduce: `node spike.js export-events inst-1 && npx vite`.

Screenshots (`docs/spikes/assets/`):

- `viewer-before.png` — blueprint rendered, all nodes idle, external log loaded.
- `viewer-mid.png` — 18/71 events replayed: implement and review green with
  live inputs/outputs, downstream nodes still idle.
- `viewer-after.png` — 71/71: full lifecycle green, per-node inputs/outputs
  visible (reject round, approve by alice, merged, retro-notes, done).

For live (not replayed) updates the same bus is fed from a
websocket/SSE stream of the service's `PersistentEventBusAdapter` events —
the service already emits exactly these objects. A tee-ing IEventBus
(sqlite + push channel) is a ~10-line adapter.

**Caveat:** `@flowcraft/tldraw` is NOT published to npm (404; version 0.1.0,
`workspace:*` deps) despite being presented alongside published packages. We
vendored its MIT source (`viewer/vendor/flowcraft-tldraw`) and consumed it
directly with vite — zero changes needed. Adopting it means vendoring or
building from source until upstream publishes.

## README/doc claims vs reality

| Claim | Reality |
| --- | --- |
| "Conditional Branching with Actions" on wait-node resume (pausing/hitl guides) | Broken in 2.10.1: `resume()` drops the action (runtime.ts:534) and `fromState` executes all action-edge targets anyway (traverser.ts:86-110). Use `condition` edges. |
| Loops/cycles "just work" via edges | Work only with explicit `joinStrategy: 'any'` on every node with a cycle back-edge; default join silently ends the run with `status: 'completed'` before the wait node executes. |
| "Awaiting state persists across system restarts" | True, but only for the `serializedContext` string YOU store; nothing in the box persists it for you. |
| Docs `runtime.run(blueprint, {...}, { functionRegistry: nodeRegistry })` (README declarative example) | `functionRegistry` option must be a `Map`, while the constructor `registry` takes a plain object. Passing the constructor-style object as the option silently does nothing. |
| `@flowcraft/tldraw` presented as an installable package | Not on npm; source-only. |
| Time-travel replay | Works as documented (`runtime.replay` reconstructed state from sqlite events). |

Other sharp edges:

- Silent no-op completions are the failure mode everywhere: wrong join
  strategy, unmatched edges, dropped actions all yield `status: 'completed'`
  rather than an error. Heddle must assert expected awaiting/complete states
  after every transition (cheap to do; our CLI does it).
- Each `resume()` mints a new `executionId`, so one instance's history spans
  several execution ids (plus stray 2-event groups and an `'unknown'` id for
  events emitted before the id exists). A Heddle instance must track its
  execution-id list (our state file does).
- `better-sqlite3` is a native dependency of `@flowcraft/sqlite-history`
  (needs build-script approval / prebuilds).
- Node outputs are duplicated in context under two keys; context grows with
  lifecycle length. Not a problem at Heddle scale.

## Recommendation

**ADOPT WITH CAVEATS.**

The three gates pass, and the core architecture is genuinely right for
Heddle: blueprint and context are plain JSON, resume is process-independent
by design, the event log is durable, dumpable, and replayable, and the viewer
bridge is runtime-agnostic. The caveats to carry into the design:

1. Wrap the runtime in a thin Heddle layer that (a) persists
   `serializedContext` + execution-id list transactionally, (b) expresses
   wait-node routing as `condition` edges (never `action` edges) until the
   upstream resume bug is fixed, (c) asserts the post-transition state
   instead of trusting `status: 'completed'`.
2. Require `joinStrategy: 'any'` on cycle re-entry nodes; lint blueprints
   with `analyzeBlueprint` at load time and fail on unexpected topology.
3. Treat node execution as at-least-once; stage side effects must be
   idempotent.
4. Vendor `@flowcraft/tldraw` (MIT) or build it from source; do not plan on
   `npm install`.
5. File (or patch) the upstream `resume()` action-drop bug; it is a
   two-line fix and our shim proves it.

Fallback trigger: if upstream churn makes the wrapper grow teeth (e.g. the
silent-completion behavior spreads or serialized-context shape breaks between
minors), the same blueprint JSON + our own interpreter on XState is the
escape hatch — the spike shows our state fits in one flat JSON document, so
the switching cost stays bounded.
