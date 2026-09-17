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
returned once for thread registration and hook installation.

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
and rendered context. It installs the returned binding before the first turn,
registers that path and token through T3 Code, and persists the returned details
through the engine's await operation. The handoff schema and context are copied
into those durable details; recovery never resolves a live blueprint file.

`GeneratedToolService.recover()` publishes persisted pass instances and is called
after a new pass reaches its await boundary. Constructing the service performs
the same recovery at startup. Route instance requests through `handle`; consume
rejected promises in the HTTP host. The HTTP host owns listening and shutdown.
The service uses stateless Streamable HTTP requests.

The pass lifecycle owns clearing T3 Code registration and installed hooks when
a pass completes, fails, or is cancelled. `revoke(path)` persistently revokes a
live instance. Authentication also rejects an instance whose run is terminal or
whose node visit is no longer awaiting. Rejected calls go to the host's supplied
log callback, or standard error. The callback receives only the path.

## Worktree files

Hook installation preserves unrelated configuration and adds one command:
`heddle hook stop claude` or `heddle hook stop codex`. `heddle` must be on the
harness's PATH. Hook commands read the harness's real `Stop` JSON from stdin.
An unavailable policy endpoint produces exit code 2 with a handoff diagnostic.
No request timeout is added by Heddle.

| Harness     | Files written by hook installation                                    |
| ----------- | --------------------------------------------------------------------- |
| Claude Code | `.claude/settings.local.json`, `.claude/.heddle-hook.json`            |
| Codex       | `.codex/hooks.json`, `.codex/config.toml`, `.codex/.heddle-hook.json` |

The `.heddle-hook.json` file contains the service origin, instance path, and
bearer token. It is created with owner-only access. Treat it as a credential
and exclude it from commits. Each installation belongs to the pass using that
worktree. The integration must remove the pass's hook and credential at teardown
and must not overwrite another live pass's binding in the same worktree.

Codex project hook discovery is enabled in its project configuration. Codex
requires independent operator trust for a discovered hook. Heddle does not write
user trust or access settings. The Codex installer reports observation mode;
the pass observer calls `observeTurnEnd` for completed turns. When the operator
has independently trusted the hook, the hook can block before that observation.
A completed turn resumes with `turnEnded`; required-handoff results include a
reminder. The blueprint owns continuation routing and its count bound. Operator
turn suppression and registration teardown belong to the pass node.

## Qualification

`node scripts/qualify-codex-hooks.mjs` measures the installed Codex executable
against a local Responses fixture. It uses isolated configuration, no provider
credentials, and the installed Heddle hook command. It measures both untrusted
observation and fixture-only operator trust. In the trusted case the hook blocks
one completion, the next model request receives the handoff reminder, and a
live policy change allows the same turn to finish.

The offline suite checks real engine resumes, cross-instance token isolation,
CLI input/output, immutable handoff definition, and SIGKILL followed by service
recovery at the same endpoint paths. The observation test follows a blueprint's
continuation count through to completion.
