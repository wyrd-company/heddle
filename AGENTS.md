# Working in this repository

`heddle` is a service that runs software-delivery tasks from a kanban board to
completion. It reads a board, starts an agent session for each task through the
T3Code control plane, exposes its own actions back to those agents as an MCP
server, and gives the operator a live console over the work in flight. The
lifecycle each task follows is not in this code — it is a blueprint in an
organization blueprint repository, pinned by content.

It is a highly opinionated system built around the workflow that currently works
for Bob. It isn't meant to work for anyone.

The core purpose is to let well-defined work proceed through a process without
constant agent or human supervision. Heddle is the process; the coding harness
is a replaceable worker.

## Why this service exists

Heddle is the revision of `pi-orchestrator`, which made one coding harness
event-driven from the inside as an extension suite. That approach worked well
enough to show what the shape should be, and where it could not go:

- **The workflow was welded to one harness.** `pi-orchestrator` depended on a
  forked `pi` with an RPC socket. Every capability had to exist in that fork,
  and the workflow could only run where the fork ran. Heddle moves the process
  out of the harness entirely: it drives sessions through T3Code, so the harness
  becomes a configured detail and several can be supported at once.
- **The orchestrator was still an agent.** `pi-orchestrator` established that
  spending agent context on mundane, algorithmic, administrative work is
  wasteful and damaging — a long epic compacts until it hallucinates exactly
  when it needs to be stable. It reduced that cost but kept an agent in the
  orchestrating seat. In Heddle the reconciler is code. No context, no
  compaction, no forgetting a task exists.
- **Escalation played the telephone game.** A subagent escalated to the
  orchestrator, which escalated to the operator, filling two contexts to carry
  one question. Heddle routes a top-level session's question into a durable
  attention queue the operator answers directly, and routes a subagent's
  question to its parent.
- **Handoffs were prose.** Subagents followed written instructions and performed
  handoffs through shell commands, and got them wrong under long contexts.
  Heddle gives them tools that can only do it right, and renders the handoff
  itself from a pinned template.
- **Observability depended on attaching to a process.** Zellij made sessions
  watchable, which is real but requires a terminal and a human at it. Heddle
  records every transition durably and projects it into a console, so the state
  of the work outlives the process that produced it.
- **Evolving the workflow meant editing skills.** Prose is a weak place to keep
  a process. Heddle's lifecycles are blueprints — data, versioned in their own
  repository, pinned by content hash at activation.

## The tool suite

Heddle does not live on its own. It leverages tools already in use:

- **`kanban-md`** provides the board and the operator's way of interacting with
  it. Heddle reads task intent from the board and writes child task status back.
- **T3Code** is the control plane that actually runs coding-agent sessions. It
  owns provider accounts, threads, and turns. Heddle dispatches to it and never
  launches a harness itself.
- **The organization blueprint repository** holds lifecycles, handoff templates,
  and todo templates. It is a separate repository on purpose, so the process can
  change without shipping the service.
- **`gitpr`** performs the mechanical review surfaces for delivery stages.
- **`Pushover`** carries operator escalation off the machine.
- **The operator.** Yes, the operator is a tool in this suite. The operator
  starts an epic by moving it in progress, answers escalations, and dispositions
  attention.

## Priorities

When this file does not settle a question, decide with these.

1. **Event-driven, never blocked and never polled.** A session is idle until
   something wakes it. Heddle has two channels to an agent: inbound over MCP,
   and outbound by dispatching a turn into the session's existing thread. A tool
   call that holds a request open waiting for a human is a design error — return
   immediately, record the wait durably, and dispatch a turn when the answer
   arrives. If you need to know something changed, arrange to be told, and make
   the telling durable. A task that is forgotten is the failure this system
   exists to prevent.
2. **Automate everything algorithmic; never automate judgment.** Agent context
   is the scarce resource. Spending it on a deterministic transition is a
   defect. Resolving an ambiguous one without an agent is a worse one.
3. **The workflow is data.** Lifecycles, handoff templates, todo templates, and
   the tools each stage may use live in the organization blueprint repository
   and are pinned by content. Adding a stage or changing a transition is a
   blueprint edit, not a code change.
4. **One authority per fact.** The board owns task existence and operator
   intent. Heddle owns child task status. The blueprint owns the lifecycle. The
   runtime owns its own state. Writing another owner's fact makes a legitimate
   state unreachable.
5. **Fail closed, and name the cause.** A configuration, pin, template, or tool
   that cannot be resolved fails before any effect occurs. A `catch` that
   rethrows a generic message destroys the only information the operator has.
6. **Nothing fails silently.** An error the operator cannot see did not get
   handled. Durable attention is the operator's surface; an exception that
   raises no attention and stops a pass is worse than a crash, because a crash
   is at least visible.
7. **Guardrails over instructions.** If an agent must do something exactly
   right, give it a tool that can only do it right. Prose in a system prompt is
   the weakest form of guarantee available.

## A small glossary

- **attention** is a durable record that the operator must see or act on. It
  survives restart and carries the actions that dispose it.
- **blueprint** is the lifecycle definition a task follows, resolved from the
  organization blueprint repository and pinned by content hash at activation.
- **escalation** is a blocking question from a session, routed to its parent if
  it has one and to the operator's attention queue if it does not.
- **instance** is one running lifecycle bound to one task.
- **lifecycle** is the prescribed stages and transitions through which a task
  moves to completion.
- **mechanical stage** is a stage Heddle executes itself — worktree, snapshot,
  merge — with no agent session.
- **session** is one agent thread bound to one instance at one stage, addressed
  by a session key.
- **stage** is a specific step in a lifecycle.
- **status** is the board-level projection of an instance's progress.
- **wait stage** is a stage that activates an agent session and waits for it to
  disposition through `advance`.

"You" is the agent changing this repository. "The operator" is the human running
the service. "The board" is the kanban-md directory holding tasks and its
configuration.

## Thar be dragons

We record here _non-obvious_ repeated failure modes specific to this repo.

1. **A fixture that supplies what production does not.** This is the defining
   failure mode of this codebase and it has produced four separate production
   outages found only by running the real thing. Mechanical stages threw because
   only fixtures wrote the change context. Session bootstrap resolved templates
   and pinned blobs from the product repository because the fixture created them
   there. The MCP server reached no agent because nothing registers it. Every
   one passed its own integration tests. An integration test that constructs its
   own options proves the service beneath the seam and not the seam itself. If
   the production composition is what assembles a thing, drive the production
   composition — and check what your fixture blueprint's first node is, because
   a fixture that begins with a wait stage never exercises a mechanical one.

2. **The live T3Code on `127.0.0.1:3773`.** That is the operator's real control
   plane, with real provider accounts and real threads. Never point a
   composition, a test, or a configuration at it. An isolated instance is
   started on another port for anything that needs a real T3Code.

3. **Writing to the live board.** `/workspaces/kanban` is the real operational
   board, in use while you work. Reading it is fine and the best source of
   realistic fixtures. Never point a composition, a reconciler, or a fixture at
   it; never let a configured `boardDirectory` resolve to it; never clean it up.

4. **Reaching the operator's real services.** The configured Pushover
   credentials deliver to Bob's actual phone. Git remotes in a product
   configuration are real remotes and a mechanical stage will push to them.

5. **The correlation token is a live credential.** It is the bearer credential
   for the MCP boundary and it appears in the rendered handoff document's
   identity front matter. Never copy it into a log, a task note, a terminal
   transcript, a screenshot, or a review artifact. Treat any rendered handoff
   and any raw event payload as secret material.

6. **`gitpr` must be on the service's PATH, not just yours.** Mechanical stages
   shell out to it. It resolves under your interactive shell and can be absent
   from the environment the service actually runs under.

## Testing

| Command                         | Purpose                                               |
| ------------------------------- | ----------------------------------------------------- |
| `task build`                    | Build the service and console viewer                  |
| `task test:unit`                | Unit and integration tests, no browser                |
| `task browser:qualification`    | Console accessibility in a real browser               |
| `task test`                     | Build, then the unit, integration, and browser suites |
| `task lint`                     | Source and artifact formatting                        |
| `task ci`                       | The complete gate                                     |
| `task blueprints:validate`      | Validate one organization blueprint repository        |
| `task deployment:package`       | Qualify the packaged deployment artifact              |
| `task deployment:qualification` | Qualify the deployment feature                        |

Some suites are opt-in and are skipped by default, including those requiring a
real pinned T3Code. A change to a file those suites cover is unproven until you
run them; hosted CI does not.

Prove a change at the seam it changes. See the first dragon — this is the
lesson this codebase paid for four times. Run targeted files while iterating and
the full gate before handing work off.

Test values are generic and non-identifying. Never use a real person, host,
account, or domain, and never give a fixture a scenario drawn from this
repository's own domain — a test board is about a recipe catalog, not about
orchestrating agents.

## Environment

Pinned dependencies that the service checks or assumes:

- **`wyrd-company/kanban-md`** at `0.37.0-fork+b9fc380`, which preserves
  unrecognized front-matter properties through every task mutation. The service
  verifies this at startup and refuses to run against another build.
- **Wyrd Company T3Code fork `0.0.37-wyrd.1`**, against which the control-plane integration is qualified from its public release tarball.
- **Driver CLI versions** are pinned in configuration, and a session refuses to
  dispatch when the running provider does not match its pinned version.

The service requires a dedicated bind mount for its state directory and refuses
to start otherwise. Configuration is operator-owned and carries secrets; read
only the keys you need and never log it.

## How it works

The documents under `docs/` are authoritative for behavior and schema; this file
is not. [`docs/technical-designs/heddle.yml`](docs/technical-designs/heddle.yml)
is the design of record, and
[Production composition](docs/operators/production-composition.md) documents the
deployed configuration. `src/` is one directory per bounded module: `engine`
interprets blueprints, `control-plane` coordinates service actions,
`mcp-server` exposes those actions to agents, `reconciler` aligns board tasks
with instances, `console` supplies the operator interface, and `production` and
`deployment` construct the real adapters. Adapters are built only there.

A few invariants are easy to break without noticing:

- **The board is the operator's authority; Heddle is the single writer of child
  status.** Operator intent — a task existing, an epic moving in progress — is
  read from the board. Child task status is written by Heddle alone. An operator
  editing a child's status by hand, or Heddle inferring intent from one, both
  break the same contract.
- **Status is a projection.** It projects from instance state. Writing it
  directly makes a legitimate state unreachable.
- **Artifacts resolve from the organization blueprint repository.** Lifecycles,
  handoff templates, and todo templates are resolved and pinned there — never
  from the product repository the work happens in.
- **Activation is recorded once and replayed exactly.** Restart accepts only an
  exact payload match and never appends or dispatches a second activation.
- **Effects are idempotent per occurrence.** A retried transition cannot double
  apply. Command identifiers are deterministic so a replay is recognisable.
- **Secrets never reach durable state or diagnostics.** The correlation token,
  provider credentials, Pushover keys, and remote URLs are redacted before they
  are recorded or surfaced.

## Pull requests

Open one only when asked. Use conventional commits with a scope matching the
module you changed. Explain the problem and the change, not just the change.
State which gates you ran, and name any you did not — a silent omission reads as
coverage that does not exist.
