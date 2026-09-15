---
docs: true
title: Installation
order: 2
install: true
---

Heddle is published as the npm package `@wyrd-company/heddle` and as the Dev
Container Feature `ghcr.io/wyrd-company/heddle/heddle`. Both install the same
service; the Feature also arranges the state bind mount and the service user.

## npm

```bash
npm install -g @wyrd-company/heddle
```

The service requires a dedicated bind mount at its conventional
`/var/lib/heddle` state directory, or an explicit state-directory override,
and refuses to start otherwise.

## Dev Container Feature

Reference the Feature from `devcontainer.json`:

```json
{
  "features": {
    "ghcr.io/wyrd-company/heddle/heddle": {}
  }
}
```

## What the service needs

- A kanban-md board directory and a clone of the organization blueprint
  repository under the configuration directory.
- A T3Code control plane with at least one configured provider.
- `git`, `gh`, and `gitpr` on the service user's `PATH`. The mechanical
  delivery steps invoke `git` and `gitpr`; agent sessions invoke `gh`. Neither
  runs through a shell.
- `kanban-md` is not required. The service reads and writes the board's task
  files itself, so operators and agents keep using whatever `kanban-md` they
  have against the same board.

The complete operator configuration — the workspace `config.yml`, provider
aliases and pacing, incident admission, and the blueprint repository contract —
is documented in
[Production composition](operators/production-composition.md).
