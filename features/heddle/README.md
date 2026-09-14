# Heddle

Installs Heddle and runs one service for the workspace through s6-overlay. The
service binds only to loopback. An optional Caddy route serves both the console
at `/` and the Streamable HTTP MCP endpoint at `/mcp`.

The Feature requires a Debian/Ubuntu image with s6-overlay 3. Node.js 24 is
supplied through the official Dev Container Node Feature. The service requires
the supported front-matter-preserving `kanban-md` fork on `PATH`; its exact
version is recorded in `deployment/supported-versions.json`. When `dnsName` is
set, add the Wyrd Company Caddy Feature to the same devcontainer.

The supported Feature reference is
`ghcr.io/wyrd-company/heddle/heddle:0`. The published Feature contains the
installer but no Heddle source or package tarball. The installer fetches the
published `@wyrd-company/heddle` package at the selected `version` from
`npmRegistry`, verifies the optional digest, and installs its runtime
dependencies. `latest` installs the registry's current `latest` dist-tag on
every build; an exact version installs that version on every build. The
Feature version and the installed Heddle package version are independent
release units.

Installation fails before service registration when package resolution,
download, digest verification, or the required `better-sqlite3` prebuild fails.
The native-dependency error names the platform and Node ABI. The Feature does
not install a compiler or fall back to a source build.

## Options

| Option            | Type   | Default                      | Description                                                                                       |
| ----------------- | ------ | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `version`         | string | `latest`                     | Heddle package version. `latest` follows the registry dist-tag; an exact version is reproducible. |
| `packageSource`   | string | `""`                         | Optional https URL or absolute tarball path that bypasses the registry.                           |
| `packageSha256`   | string | `""`                         | Optional hexadecimal SHA-256 digest verified before installation.                                 |
| `npmRegistry`     | string | `https://registry.npmjs.org` | npm registry that serves `@wyrd-company/heddle` when `packageSource` is empty.                    |
| `configDirectory` | string | `/home/vscode/.heddle`       | Operator-owned directory containing required `config.yml`.                                        |
| `dnsName`         | string | `""`                         | Optional fully qualified workspace DNS name served through Caddy.                                 |
| `serviceUser`     | string | `automatic`                  | User that runs Heddle; automatic selection prefers the remote user.                               |

## Workspace configuration and persistence

Create `config.yml` as the operator, set mode `0600`, and mount its directory at
`configDirectory`. Clone the organization blueprint repository into the
hard-coded `blueprints` subdirectory and give the service user fetch and push
credentials through its SSH agent or a scoped deploy key. The clone path and Git
credentials are not `config.yml` fields. The file is the sole source for board,
state, loopback server, T3, Pushover, pacing, session, threshold, product,
project, and secret settings.
Only `HEDDLE_CONFIG` may select a different directory; other `HEDDLE_*` values do
not configure the deployed service. Configuration changes require service
restart. The configured loopback port must be from 1 through 65535 so that the
same fixed endpoint can be used by Heddle and Caddy.

The configured `stateDirectory` must be a dedicated bind-mount target. Give
every workspace its own host source so that a rebuild replaces the container
without replacing SQLite history:

```json
{
  "features": {
    "ghcr.io/wyrd-company/devcontainers/caddy:1": {},
    "ghcr.io/wyrd-company/heddle/heddle:0": {
      "configDirectory": "/home/vscode/.heddle",
      "dnsName": "heddle.workspace.example.test"
    }
  },
  "mounts": [
    {
      "source": "${localWorkspaceFolder}/.devcontainer/config/heddle",
      "target": "/home/vscode/.heddle",
      "type": "bind"
    },
    {
      "source": "${localWorkspaceFolder}/.devcontainer/state/heddle",
      "target": "/var/lib/heddle",
      "type": "bind"
    }
  ]
}
```

The service validates `config.yml`, derives its Caddy upstream and state target
from that same file, requires the `blueprints` directory to be the exact root of
a Git worktree whose current branch tracks `origin`, and refuses to start when
`stateDirectory` is not a mount point. The root launcher writes only the
nonsecret Caddy snippet, completes a bounded Caddy reload handshake, and then
drops privileges. The watcher owns later Caddy reloads. The launcher never
prints or copies raw YAML. One Heddle service, one blueprint clone, and one state
source belong to one workspace.

Heddle binds the configured loopback endpoint before production composition
startup. The endpoint returns `503 Service Unavailable` until startup succeeds;
a bind failure cannot dispatch production effects or create production state.

See [Production composition](../../docs/operators/production-composition.md)
for the complete schema and executable-adapter contracts.

## T3 compatibility qualification

This release supports the Wyrd Company T3 fork `0.0.38-wyrd.2`, recorded with
its public release-tarball source in `deployment/supported-versions.json`. The
repository gate installs that exact artifact into a temporary prefix, launches
it on an unused non-live loopback port with temporary T3 state and a temporary
Git repository, and drives it with the
`T3ControlPlaneClient` installed by this Feature. It does not use the ambient T3
binary, port `3773`, or `/home/vscode/.t3`.

Run the complete scratch build, service, Caddy, rebuild/replay, and pinned-T3
qualification at one repository head:

```console
task deployment:qualification
```

This gate packs the built repository tree, serves that tarball from an isolated
local npm registry as the package's only version and as `latest`, stages the
source-free Feature, and dry-publishes it to an isolated local OCI registry. It
installs the published Feature through a versioned remote reference at the
default `latest`, proves the service endpoint, then rebuilds at the exact
package version. `packageSource` and `packageSha256` are exercised only by the
named failure cases. It does not use the local-path Feature form.
`task deployment:package` separately checks the distribution archive without
starting a container or registry.
