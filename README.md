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

- Node.js 24 or newer, including its built-in SQLite API.
- A GitHub Project and the issues in it.
- A T3 Code server.

## Install

The private phase publishes `@wyrd-company/heddle` to GitHub Packages. Map the
scope to GitHub's npm registry in the installing user's `.npmrc`, authenticate
that registry according to the organization's package policy, then install the
package:

```ini
@wyrd-company:registry=https://npm.pkg.github.com
```

```sh
npm install --global @wyrd-company/heddle
```

The package manifest fixes the publish target to
`https://npm.pkg.github.com` with restricted access. A release operator can run
`npm publish` only after authentication is configured. This repository does
not publish as part of its build or test tasks.

For local development, install Heddle's locked dependencies and build:

```sh
npm ci
task build
```

`npm pack` builds the package and produces a tarball with one executable named
`heddle`. `task package-check` rejects file dependencies, symbolic links, and
parent-directory archive entries, installs the tarball into an empty project,
and exercises `heddle --help`.

## Internal modules

Heddle owns its T3 Code and GitHub clients as internal modules:

- `src/t3code/` provides the T3 Code HTTP, WebSocket RPC, authentication,
  project, thread, turn, shell, MCP, version-control, and terminal surfaces.
- `src/github/` provides typed GitHub Projects, issues, pull requests,
  conversations, labels, milestones, issue types, and issue fields.

They build, typecheck, and test as part of Heddle. They are not package
dependencies and are not published separately. Their technical designs are
`docs/technical-designs/t3-code-client.yml` and
`docs/technical-designs/github-client.yml`; `AGENTS.md` defines their offline
and live test commands.

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

## Configuration

Heddle reads one YAML configuration file. This is the minimum service shape;
the implementation tasks that own each integration also own its detailed
validation rules.

```yaml
projects:
  - owner: sample-owner
    number: 12
github:
  credentialFile: /run/secrets/heddle-github-app.yml
t3Code:
  endpoint: http://127.0.0.1:3773
  tokenFile: /run/secrets/heddle-t3-token
blueprints:
  repository: /workspaces/blueprints
webhook:
  secretFile: /run/secrets/heddle-webhook-secret
```

`projects` lists the bound GitHub Projects. `github.credentialFile` points to
Heddle's GitHub App credential file. `t3Code.endpoint` names the T3 Code
server, and `t3Code.tokenFile` points to its bearer token. The blueprint
repository is a local Git checkout. `webhook.secretFile` points to the secret
used to verify GitHub deliveries. Secret values are read from these files;
they do not belong in YAML values, Feature options, command arguments, or
logs.

Configure the App according to GitHub's
[permission reference](https://docs.github.com/rest/authentication/permissions-required-for-github-apps)
with these permissions:

- Metadata: read.
- Code: read and write.
- Issue fields: read and write.
- Issue types: read and write.
- Issues: read and write.
- Pull requests: read and write.
- Organization projects: administration.

The required webhook subscriptions are still pending integration
qualification. The candidate set is `issues`, `projects_v2_item`,
`issue_comment`, and `pull_request` from GitHub's
[webhook reference](https://docs.github.com/webhooks/webhook-events-and-payloads);
do not treat that set as accepted until the webhook integration proves it.
Agents use their own narrower credentials and never receive this App credential.

For T3 Code, issue a dedicated bearer session on the machine that owns the T3
state, write it directly to the mounted token file, and restrict the file to
the service user:

```sh
heddle_service_user=vscode
install -m 0600 -o "${heddle_service_user}" \
  -g "$(id -gn "${heddle_service_user}")" \
  /dev/null /path/to/secrets/heddle-t3-token
sudo -u "${heddle_service_user}" \
  t3 auth session issue --base-dir /home/vscode/.t3 \
  --label heddle --token-only \
  > /path/to/secrets/heddle-t3-token
```

Replace `vscode` and its home directory with the T3 service account and base
directory, then set `t3Code.endpoint` to that server. A one-time token from
`t3 pair` or `t3 auth pairing create` must be exchanged for a bearer session
before it can be stored; one-time pairing tokens are not restart credentials.

## Dev Container Feature

The Feature runs `heddle start` as the selected service user through a native
s6-overlay 3 longrun. Its options select the configuration file, state
directory, and secret-file locations. Mount each at the same path:

```json
{
  "overrideCommand": false,
  "features": {
    "ghcr.io/wyrd-company/heddle/heddle:0": {
      "configFile": "/etc/heddle/config.yml",
      "stateDirectory": "/var/lib/heddle",
      "githubAppCredentialsFile": "/run/secrets/heddle-github-app.yml",
      "t3CodeTokenFile": "/run/secrets/heddle-t3-token",
      "webhookSecretFile": "/run/secrets/heddle-webhook-secret"
    }
  },
  "mounts": [
    {
      "source": "${localWorkspaceFolder}/.devcontainer/heddle/config.yml",
      "target": "/etc/heddle/config.yml",
      "type": "bind"
    },
    {
      "source": "${localWorkspaceFolder}/.devcontainer/heddle/state",
      "target": "/var/lib/heddle",
      "type": "bind"
    },
    {
      "source": "${localWorkspaceFolder}/.devcontainer/heddle/secrets",
      "target": "/run/secrets",
      "type": "bind"
    }
  ]
}
```

The Feature artifact contains the npm tarball built from the same accepted
revision. Run `task feature-check` to stage that tarball and prove the Feature
in isolated Dev Container builds. The service assembly lands after the engine,
GitHub binding, T3 Code pass, and webhook components. Until then, `start` writes
its usage, exits with status 2, and s6 restarts it in a loop. The later service
integration must replace that scaffold with a durable process and eliminate the
restart loop before operational acceptance.

## Status

Pre-release. See `AGENTS.md` for the principles and `docs/technical-designs/`
for the design.

## License

Apache-2.0.
