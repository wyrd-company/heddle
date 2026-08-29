# Heddle

Installs Heddle and runs one service for the workspace through s6-overlay. The
service binds only to loopback. An optional Caddy route serves both the console
at `/` and the Streamable HTTP MCP endpoint at `/mcp`.

The Feature requires a Debian/Ubuntu image with s6-overlay 3. Node.js 24 is
supplied through the official Dev Container Node Feature. The service requires
the supported front-matter-preserving `kanban-md` fork on `PATH`; its exact
version is recorded in `deployment/supported-versions.json`. When `dnsName` is
set, add the Wyrd Company Caddy Feature to the same devcontainer.

## Options

| Option        | Type   | Default              | Description                                                         |
| ------------- | ------ | -------------------- | ------------------------------------------------------------------- |
| `statePath`   | string | `/var/lib/heddle`    | Absolute in-container path for the persistent state bind mount.     |
| `boardPath`   | string | `/workspaces/kanban` | Absolute in-container path to the workspace kanban-md board.        |
| `port`        | string | `3774`               | Loopback port served by Heddle.                                     |
| `dnsName`     | string | `""`                 | Optional fully qualified workspace DNS name served through Caddy.   |
| `serviceUser` | string | `automatic`          | User that runs Heddle; automatic selection prefers the remote user. |

## Workspace-specific persistence

`statePath` must be a dedicated bind-mount target. Give every workspace its own
host source so that a rebuild replaces the container without replacing the
SQLite event history:

```json
{
  "features": {
    "ghcr.io/wyrd-company/devcontainers/caddy:1": {},
    "ghcr.io/boblangley/heddle:1": {
      "statePath": "/var/lib/heddle",
      "boardPath": "/workspaces/kanban",
      "port": "3774",
      "dnsName": "heddle.workspace.example.test"
    }
  },
  "mounts": [
    {
      "source": "${localWorkspaceFolder}/.devcontainer/state/heddle",
      "target": "/var/lib/heddle",
      "type": "bind"
    }
  ]
}
```

The service refuses to start when `statePath` is not a mount point. One Heddle
service and one state source belong to one workspace.

`boardPath` names the board already mounted for that workspace. The deployed
console reads that board and keeps its scope and epic lever on the accepted
kanban-md adapter boundary.

## T3 compatibility qualification

This release supports T3 `0.0.36`, recorded in
`deployment/supported-versions.json`. The repository gate installs that exact
release into a temporary prefix, launches it on an unused non-live loopback port
with temporary T3 state and a temporary Git repository, and drives it with the
`T3ControlPlaneClient` installed by this Feature. It does not use the ambient T3
binary, port `3773`, or `/home/vscode/.t3`.

Run the complete scratch build, service, Caddy, rebuild/replay, and pinned-T3
qualification at one repository head:

```console
task deployment:qualification
```
