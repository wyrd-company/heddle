---
docs: true
title: Overview
order: 1
---

Heddle runs software-delivery tasks from a kanban-md board to completion. It
reads the board, starts a coding-agent session for each stage that needs
judgment through the T3Code control plane, exposes its own actions back to
those sessions as an MCP server, and projects every transition into a durable
operator console. The lifecycle a task follows is not in Heddle: it is a
blueprint in an organization blueprint repository, pinned by content hash when
the task starts.

## The model

A **task** on the board names its lifecycle. Heddle starts one **instance** of
that blueprint for the task and runs it as a graph. Each **node** declares a
capability with `uses`; each **edge** carries a JSONata guard over what the
graph has produced so far. Heddle reads the capability and the guards. The
node identifiers, the disposition names, and the wording of every handoff are
the author's.

| Capability                                                 | What Heddle does                                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `wait`                                                     | Renders the pinned handoff, starts an agent session, and waits for it to `advance` with one of the edge dispositions |
| `question`                                                 | Asks the operator or an adjudicator the node's questions and routes on the answer                                    |
| `fail`                                                     | Ends the lifecycle with a rendered attention entry the operator must see                                             |
| `resolve-attention`                                        | Resolves the attention entry the lifecycle was started for                                                           |
| `complete`                                                 | Does nothing; marks an entry or terminal point                                                                       |
| `prepare-worktree`, `review-snapshot`, `merge`, `finalize` | Runs the mechanical delivery step in real code and mirrors the board status the blueprint maps to it                 |

An agent session sees only the tools its stage declares, and `advance` offers
only the dispositions its outgoing edges declare, each described in the tool
schema. An edge can bind a disposition to an **output contract** — a JSON
Schema artifact in the blueprint repository — and Heddle validates the
session's output against it before the transition is recorded.

## What stays in Heddle

Heddle owns the machinery a blueprint cannot supply: durable state, restart
that replays exactly what was recorded, session bootstrap and observation,
escalation routing, incident admission, board status as a projection of
instance state, and the operator console. Everything that decides _which_ way a
task goes — how many review rounds, whether a production change needs the
operator, what ends an incident — is blueprint data, read from the blob pinned
at activation.

## Where to go next

- [Installation](install.md) — the package, the Dev Container Feature, and the
  operator configuration this service needs.
- [Usage](usage.md) — authoring a blueprint from a first wait stage to guards,
  questions, and output contracts.
- [Blueprint reference](reference.md) — every field, capability, and validation
  rule, and the data a guard or template can read.
