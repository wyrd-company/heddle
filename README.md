# heddle

Orchestration service

## Package layout

Production code lives under `src`. `engine` interprets lifecycle blueprints;
`control-plane` coordinates service actions; `mcp-server` exposes those actions
to agents; `reconciler` aligns board tasks with workflow instances; and
`console` supplies the operator interface. The independent flowcraft gate lives
in `spikes/flowcraft-gate`, with its original package, driver, and viewer kept
together. Other spike support scripts remain in `scripts/spike`.
