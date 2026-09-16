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

- A GitHub Project and the issues in it.
- A T3 Code server.

## Status

Pre-release. See `AGENTS.md` for the principles and `docs/technical-designs/`
for the design.

## License

Apache-2.0.
