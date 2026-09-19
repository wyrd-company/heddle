---
relationships:
  describes: agent-tools
  references:
    - engine-and-run-model
    - node-types
---

# Agent tools and turn-end hooks

Each pass has a generated Streamable HTTP MCP endpoint. Its opaque path binds
one run, node visit, and thread. Its bearer token works only at that path.
The service stores the token hash in awaiting details; the clear token is
returned once for thread registration. Heddle retains the binding in its owned
state directory while the pass is active; neither worktrees nor Git metadata
contain hook credentials or endpoint-binding files.

| Tool             | Behavior                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`         | Records a progress note without resuming. The optional status adapter projects it to the issue.                                                                                                                           |
| `escalate`       | Records the shared question shape. Under `answer-in-place`, starts the `answer-question` related run at the parent's pinned commit, or records attention if it cannot start. Under `ends-stage`, resumes with `escalate`. |
| `handoff`        | Uses the stage's handoff schema and description verbatim. Invalid input returns schema errors; valid input resumes with `handoff` and the payload.                                                                        |
| `propose-policy` | Records an operator question and returns its proposal id. The policy stays unchanged until the operator approves that proposal.                                                                                           |
| `context`        | Returns the context snapshot prepared for the pass.                                                                                                                                                                       |

The question shape contains `id`, `header`, `text`, `options` (label and optional
description), and `multi-select`. Tool arguments contain no run or thread id.
Rewind and reset credits are not agent tools.

The policy endpoint is `<instance-path>/policy`. It uses the same bearer token
and returns `policy` and `requirement`. `require-handoff` blocks turn completion
with a message naming the missing handoff. `allow` permits completion. Operator
code can set the policy directly or answer a pending proposal. Proposal answers
are consumed once and survive service restart.

## Integration

The pass node calls `prepareAgentTools` with the thread id, pinned handoff schema,
and rendered context. It retains the returned binding in Heddle-owned state and
persists the details through the engine's await operation. After that boundary
commits and releases traversal, it registers the path and token through T3 Code
and starts the turn. The handoff schema and context are copied
into those durable details; recovery never resolves a live blueprint file.

`GeneratedToolService.recover()` publishes persisted pass instances and is called
after a new pass reaches its await boundary. Constructing the service performs
the same recovery at startup. Route instance requests through `handle`; consume
rejected promises in the HTTP host. The HTTP host owns listening and shutdown.
The service uses stateless Streamable HTTP requests.

The pass lifecycle owns clearing T3 Code registration, session mapping, and
credentials when a pass completes, fails, or is cancelled. The shared profile
plugin remains installed. `revoke(path)` persistently revokes a
live instance. Authentication also rejects an instance whose run is terminal or
whose node visit is no longer awaiting. Rejected calls go to the host's supplied
log callback, or standard error. The callback receives only the path.

## User-profile plugins

Export the reusable native marketplace packages once, outside worktrees:

```sh
heddle hook export-plugins ~/.local/share/heddle/plugins
claude plugin marketplace add ~/.local/share/heddle/plugins/claude
claude plugin install heddle@heddle --scope user
codex plugin marketplace add ~/.local/share/heddle/plugins/codex
codex plugin add heddle@heddle
```

After exporting an updated package, use `claude plugin update heddle@heddle`
or repeat `codex plugin add heddle@heddle`. Installation and update are native
harness operations. Heddle does not rewrite operator profile configuration or
write separate hook trust. Repeated installation keeps one hook. The plugin
version follows the Heddle package version.

Each plugin runs `heddle hook stop claude` or `heddle hook stop codex`.
`heddle` must be on the harness PATH. Both commands read the real Stop JSON
and send only its exact `session_id` to Heddle's local database-specific hook
socket. Set `HEDDLE_HOOK_SOCKET` to the socket reported at service startup for
a database override. Otherwise the command derives the socket from the default
`heddle.sqlite` under `HEDDLE_STATE_DIR`, defaulting to `$XDG_STATE_HOME/heddle`
or `~/.local/state/heddle`. Hook input cannot select a thread, pass, endpoint,
or token. Cwd has no role in correlation. No request timeout is added by Heddle.

Heddle correlates native session identities with the active run, node visit,
thread, and generated endpoint. It learns an identity by reading it from T3
Code once per provider session, when an observed session event shows the
thread's provider session is live. A Stop decision reads Heddle's own table
and never asks T3 Code. An unmapped session returns allow with no
generated-endpoint call, attention, or state change. The plugin is also
inert when no Heddle runtime is listening. Active uniquely mapped sessions use
their own generated policy endpoint. An ambiguous owned mapping is an invariant
error; it does not change decisions for unrelated sessions.

Recovery reconciles terminal and stale mappings before serving hook traffic.
Removing the awaiting row immediately rejects the endpoint's original token.
Terminal mapping removal then makes subsequent Stop events return inert allow;
cleanup cannot precede that awaiting-row transition. An in-flight policy read
rechecks the mapping before returning a block. A later pass never acquires the
completed pass's credentials. The reusable plugin remains installed throughout.

Codex supports independently trusted blocking and untrusted observation.
Heddle does not make hook trust a setup prerequisite. If the native harness does
not execute the hook, including when its hook feature is disabled, Heddle uses
observed completion. Under observation,
completed turns resume with `turnEnded`; required-handoff results include the
reminder. A real blueprint owns continuation routing and its count bound.

## Qualification

`node scripts/qualify-plugin-install.mjs` checks initial native installation,
update and repeat installation in isolated Claude and Codex profiles. It checks
that unrelated Codex comments remain and installation adds no hook trust.

`node scripts/qualify-codex-hooks.mjs` measures the installed Codex executable
against a local Responses fixture. It uses isolated configuration, no provider
credentials, and the natively installed Heddle plugin command. It measures both untrusted
observation and fixture-only operator trust. In the trusted case the hook blocks
one completion, the next model request receives the handoff reminder, and a
live policy change allows the same turn to finish.

The offline suite checks real engine resumes, cross-instance token isolation,
CLI input/output, immutable handoff definition, and SIGKILL followed by service
recovery at the same endpoint paths. The observation test follows a blueprint's
continuation count through to completion.

[Pass qualification](pass-qualification.md) records real T3 ordering, both native
harnesses, concurrent ordinary sessions, approval timing, and process-kill recovery.
