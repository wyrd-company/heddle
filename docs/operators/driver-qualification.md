---
$schema: https://wyrd.company/heddle/operator-document.schema.json
relationships:
  verifies: heddle
  references: t3-headless
---

# Driver qualification

Heddle is qualified against every supported coding-agent harness by running
the packaged production service against an isolated control plane and letting
a real agent session drive it. This document is the repeatable procedure and
the evidence format.

## What qualification proves

A qualification run establishes, for each driver, that:

- The packaged service starts from `config.yml` with its real configuration
  loader, pinned blueprint, SQLite state, MCP endpoint, provider resolver, and
  `T3ControlPlaneClient`.
- A stage session activates and binds to the intended provider instance and
  model, resolved from the live catalog rather than from configuration alone.
- A real agent session calls `list_providers`, creates a delegated child with
  `spawn`, and advances the stage through Heddle's MCP boundary. The
  qualification never calls that boundary itself.
- The session runs under `full-access`, forwarded unchanged, and performs a
  benign scratch-file command without an approval prompt.

Nothing in the harness injects a dispatch implementation or an alternative
provider policy. The composition receives neither a `t3` client nor a
`providerResolver`, so production constructs both itself.

## Prerequisites

- The selected harness installed from its published Dev Container Feature.
  Each native row has its own configuration under
  `.devcontainer/driver-qualification/`.
- The supported T3 release from `deployment/supported-versions.json`,
  installed into a scratch prefix. Never the operator's own `t3` on `PATH`.
- Provider authentication is the operator's own. A native-row configuration
  mounts only that provider's store, read-only, under
  `/run/heddle-credentials`, then copies it into the disposable container home.
  A CLI can update its disposable copy, but cannot write or rotate the
  operator's store. Other providers' stores are not mounted.

Install the pinned control plane:

```bash
npm install --global --no-audit --no-fund --prefix "${SCRATCH}/t3" \
  "$(jq -er '.t3PackageSource' deployment/supported-versions.json)"
```

## Running it

Every suite that starts T3 is opt-in. Production-seam, selection, and restart
fixtures use a credential-free controllable provider binary. Only the five
native rows use the operator's authenticated provider sessions and consume
provider budget.

```bash
# Production seams, selection matrix, restart, and isolation guards.
env -u FORCE_COLOR -u NO_COLOR \
  HEDDLE_T3_INTEGRATION_BINARY="${SCRATCH}/t3/bin/t3" \
  npx vitest run src/production/ src/control-plane/

# One native driver row. Repeat with claude-code, codex, cursor, grok, and
# opencode, using the matching devcontainer configuration for each row. Each
# starts its own control plane and runs a real parent and delegated child, so
# budget a generous wall clock.
env -u FORCE_COLOR -u NO_COLOR \
  HEDDLE_T3_INTEGRATION_BINARY="${SCRATCH}/t3/bin/t3" \
  HEDDLE_NATIVE_DRIVER_QUALIFICATION=1 \
  HEDDLE_NATIVE_DRIVER_ALIAS=codex \
  npx vitest run src/production/native-driver.integration.test.ts
```

Run each row through the cleanup-owning command. It creates the matching
credential-isolated container, captures the exact container identity returned
by `devcontainer up`, verifies the row's unique ownership label, and removes
that exact container on success, failure, or interruption.

```bash
scripts/deployment/qualify-native-driver.sh codex
```

Do not run a native row in the credential-free common
`devcontainer.json`. It installs all five binaries for catalog and production
seam tests, but supplies no provider authentication.

Set `HEDDLE_QUALIFICATION_KEEP_SCRATCH=1` to retain the isolated control
plane's state directory when diagnosing a failure; a driver's provider event
log lives under it and is otherwise removed with the scratch root.

`FORCE_COLOR` must be unset. When it is set, Node emits a `NO_COLOR` warning
into stderr, and two deployment tests assert that stderr is empty. That
failure is environmental and not a defect.

## Isolation

The production-seam, selection, and restart fixtures give T3 a scratch-owned
`HOME` and a credential-free controllable provider binary. An adversarial
sentinel proves provider processes can mutate only that scratch home and cannot
read or change the caller's populated home. The harness refuses, before any
effect:

- the live control-plane port `3773`;
- the live board at `/workspaces/kanban`, including nested paths and paths
  that only resolve to it;
- any control-plane or state directory outside the scratch root.

Each refusal has a named test in
`src/production/driver-qualification-isolation.test.ts`.

Each native-row configuration mounts only its selected provider credential
source and mounts every such source read-only. The row then copies only that
selected identity into T3's scratch-owned provider home. The copied credential
state and all provider sessions are removed with the row's container and
isolated scratch directory.

## Reading a failure

A driver reported as unavailable is more often late than unsupported. T3
discovers whether each configured harness is installed _after_ it begins
serving, reporting `state: warning` until discovery completes. Cursor is
consistently the slowest.

Two failure shapes follow from this, and both look like absent driver support:

- **A readiness window sized to the fastest driver.** Poll until the
  configured instances report `state: ready` with at least one model.
- **A first agent turn slower than the window allows.** Turn latency varies by
  driver and by machine load; rows run sequentially, each with its own control
  plane and agent process.

Before recording a driver as unsupported, confirm its catalog row reached
`ready` and that the window was not simply short.

## Evidence format

Record the exact versions and one row per driver. Versions are provenance, not
compatibility pins.

| Field        | Source                                     |
| ------------ | ------------------------------------------ |
| Heddle       | commit under qualification                 |
| Blueprints   | pinned blueprint content hash              |
| T3           | `deployment/supported-versions.json`       |
| Provider CLI | `observedCliVersion` from the live catalog |
| Model        | the resolved binding's model slug          |

Every driver row is required. A skipped harness, an unavailable credential, or
an unresolved adapter failure leaves the matrix incomplete; a best-effort
result does not satisfy it.

After asserting the binding and native effects, a row writes one line prefixed
with `HEDDLE_NATIVE_EVIDENCE`. Its JSON object is safe to retain and contains:

- the driver, generated provider alias, provider instance, approved model,
  runtime mode, and observed CLI version;
- the benign file action, `list_providers`, `spawn`, and `advance` results; and
- `result: passed`, or `result: provider-turn-failed` only when T3 reports a
  failed latest turn and classifies its error as the selected provider's
  `session/prompt` request failure after establishing the requested binding.

An unfinished turn, timeout, session-start failure, or Heddle/MCP failure emits
no provider-failure row. The failure row does not retain the provider diagnostic.
Read the provider's isolated event log, record its safe reason separately, and
apply any explicit operator disposition without changing the structured binding
evidence.
