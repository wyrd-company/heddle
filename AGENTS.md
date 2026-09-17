# Working in this repository

Heddle is a workflow engine for agent-executed work. A person describes how
work moves through their process as a blueprint: a graph of nodes and edges.
Heddle runs those blueprints. It starts agent threads on T3 Code at the points
that need judgment, gives those agents tools to report status, escalate, and
hand off, and keeps a GitHub Project in step with where every issue is. No
agent orchestrates. The engine does the algorithmic work, and agents do the
judgment work.

Heddle requires GitHub Projects and T3 Code. Everything else about how a user
works is theirs to decide in blueprints.

## Principles

These principles decide what belongs in a blueprint and what belongs in code.
Read them before adding either.

- **Blueprints decide order and routing.** Which stage is next, what happens
  on each result, who is asked, how long to wait. If a change alters the
  user's process, it is a blueprint edit, never a code edit.
- **Code decides how one step touches the world.** T3 Code threads, GitHub,
  MCP tools, timers. Every external system sits behind a node type. Blueprints
  compose node types and never call systems directly.
- **Invariants are code, and blueprints cannot opt out.** Result contracts, run
  identity, idempotency, and blueprint-to-project reconciliation. An author
  never writes a "sync GitHub" node. The project's Status field exists because
  the blueprint has stages.
- **Constraints are lint rules, not runtime surprises.** A blueprint that
  cannot work fails at authoring time, with the reason.
- **Node types need code; blueprints do not.** A stage name is a blueprint id,
  never a code constant. Any code that switches on a stage name, a status name,
  or a label name is a defect.
- **Not everything is dynamic.** The system is flexible where the user's
  process lives and fixed where the machinery lives. Watch for code that
  should become a node type, and for node types that have grown so specific
  they should become blueprints. Moves in both directions are expected.
- **The issue is the input.** A GitHub issue, with its project card fields,
  sub-issues, links, and pull requests, is the initial context of every run.
  Conditions, templates, policies, and reconciliation read and write that one
  shape.
- **Do not bake in one person's preferences.** One project per repository,
  labels versus fields, stage names, review paths: these are the user's
  choices, expressed in blueprints and intake, never assumed by code.
- **Use T3 Code's words.** Thread, turn, session, project, runtime mode,
  approval, user input, read model. Where T3 Code has no word for a thing,
  Heddle names it once in the designs and uses that name everywhere.
- **Two credential tiers.** Heddle is an algorithmic system and holds its
  own GitHub App with write permissions. Agents hold narrower credentials
  and never Heddle's.

## How work runs

- Every issue in a bound GitHub Project is a workflow instance from the moment
  it is discovered, including while it waits in a backlog.
- An intake blueprint chooses the lifecycle blueprint for a new issue. Intake
  is a blueprint, so the choice is the user's.
- A `pass` node starts one thread for one pass at a stage and pauses. It
  wakes on handoff, escalate, timeout, idle, turn-ended, or overridden. Each
  wake-up picks an edge and does nothing else. A stage may take several
  passes; the process blueprint sees only results.
- What happens inside a pass is code behind the `pass` node: a read model
  of the thread built from observed events, deadlines, and the generated
  tool server. Only the result crosses into the graph.
- Stage blueprints wrap `pass` nodes with retry routing and run as their own
  top-level runs. A parent run starts a child run and pauses until the child
  resumes it. Nested Flowcraft subflows and action edges are not used.
- Operator turns sent from the T3 Code UI are ordinary observed turns.
  Heddle never assumes a turn it did not send cannot exist.
- Agent questions do not wake a stage. They start a separate small run that
  answers the thread directly.
- Handoff is a tool defined per stage with JSON Schema. The agent must call it
  to finish the stage.
- Blueprints are YAML files in a git repository, pinned per instance to a
  commit. The engine may use JSON internally. Translation is never lossy
  and keeps comments. Edge conditions are JSONata. Prompts are Nunjucks
  templates. The file format is `docs/specifications/blueprint.yml`.
- Timeouts exist only where a blueprint author writes a duration, and a
  wake-up never stops or destroys anything by itself. Any other timeout
  mechanic needs the user's explicit approval.

## Development cycle

Blueprint, then node types, then learn, then revise both. Neither layer leads.
The first blueprint is the user's real workflow, authored before most node
types exist, with nodes stubbed. Fixtures include workflows the user does not
anticipate, to prove the flexibility claim.

The ready-to-ship test: Heddle can be used to revise itself.

Expect gaps. The current process is carried by agent cognition, and running it
as a blueprint will expose steps that agents were handling silently. Treat each
one as a finding to design for, not a failure.

## Repository conventions

- Documentation is the single source of truth for stable intent. Design
  artifacts live under `docs/` and follow the refinery schemas in
  `/workspaces/context`. They are clean copy: present intent only, no history
  narration.
- Worktrees live at `/workspaces/worktrees/heddle/{branch}`. Do not work on
  `main` directly.
- Flowcraft is the engine. Known defects in its subflow resume, action edges,
  and concurrent wait-plus-sleep are worked around, not depended on. See the
  technical designs and `docs/spikes/` before touching resume logic.
- `heddle validate` is the authoring loop. Run it after every blueprint edit
  and read its JSON output.
- Shelling out to a CLI from service code is a last resort and needs explicit
  approval from the user.
- Example values in tests and docs are generic and never drawn from the
  system's own domain.
