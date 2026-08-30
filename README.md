<!--
relationships:
  implements: heddle
-->

# heddle

Orchestration service

## Package layout

Production code lives under `src`. `engine` interprets lifecycle blueprints;
`control-plane` coordinates service actions; `mcp-server` exposes those actions
to agents; `reconciler` aligns board tasks with workflow instances; and
`console` supplies the operator interface. The independent flowcraft gate lives
in `spikes/flowcraft-gate`, with its original package, driver, and viewer kept
together. Other spike support scripts remain in `scripts/spike`.

## Operation

The canonical per-workspace scheduler and adapter configuration is documented
in [Production composition](docs/operators/production-composition.md).

## Validation

`task test` builds the service, runs the unit and integration tests, and then
runs the checked-in console browser qualification. Use `task test:unit` for the
non-browser suite or `task browser:qualification` for the browser suite alone.
`task ci` runs the complete repository test and lint path.

The browser qualification uses deterministic generic fixtures and an isolated
`agent-browser` session. It covers the board, dependency graph, lifecycle view,
and attention overlay at desktop, mobile, and the 679/690/740/800/801-pixel
boundary widths. It checks WCAG A/AA axe results, computed accessible names,
visible keyboard focus, board and graph scrolling, authorized actions,
the exact blueprint-editor control roster and repository GET/PUT flow,
dependency geometry, lifecycle event tails, attention deep links, and browser
console, runtime, and network activity. Nineteen named live mutants must
independently kill the prohibited-ARIA, name, focusability, keyboard, editor
roster and activation, contrast, incomplete result, node-height, spacing, and
edge-anchor guards.

All audited views require zero axe violations. Attention focus audits require
zero incomplete results. Tldraw lifecycle-node overlap and horizontally clipped
mobile board headers are the only accepted incomplete results; the suite bounds
each affected target and verifies its effective foreground/background contrast.
