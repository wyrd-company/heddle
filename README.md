# heddle

Orchestration service

## Package layout

Production code lives under `src`. `engine` interprets lifecycle blueprints;
`control-plane` coordinates service actions; `mcp-server` exposes those actions
to agents; `reconciler` aligns board tasks with workflow instances; and
`console` supplies the operator interface. The flowcraft gate remains an
independent spike at the repository root, with its viewer in `viewer` and its
support scripts in `scripts/spike`.
