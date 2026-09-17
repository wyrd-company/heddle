# Heddle

Workflow orchestration for T3 Code agents.

Heddle runs GitHub issues through blueprints: graphs of nodes and edges that
describe how work moves through a process. At the points that need judgment it
starts an agent thread on T3 Code, gives that agent tools to report status,
escalate, and hand off, and pauses until the agent is done. Everything else,
from dispatch to timeouts to keeping the GitHub Project in step, is mechanical
and runs without an agent in the loop.

Blueprints are YAML in a git repository. Changing a process is editing a
blueprint. Code changes only when a new kind of integration is needed.

## Requirements

- Node.js 24.
- A GitHub Project and the issues in it.
- A T3 Code server.

## Install

Heddle is not published yet. Clone it into the Heddle worktree layout with
the `github-work` and `t3code-client` development repositories beside the
`heddle` worktree directory, then install the locked dependencies and build:

```sh
npm ci
task build
```

The package installs one executable named `heddle`.

## Run

The scaffold exposes the planned command groups. They print their usage and
return a non-zero exit code until their implementations land.

```sh
heddle --help
heddle start
heddle validate <path>
heddle skill <command>
heddle hook <command>
```

Run every repository gate with:

```sh
task check
```

## Status

Pre-release. See `AGENTS.md` for the principles and `docs/technical-designs/`
for the design.

## License

Apache-2.0.
