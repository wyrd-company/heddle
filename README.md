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

`heddle start` runs the production service. `heddle validate` checks blueprints. Harnesses invoke `heddle hook stop claude`
or `heddle hook stop codex` to check the current turn-end policy. See the
[agent tools and hook reference](docs/reference/agent-tools.md) for installation,
worktree files, and Codex observation enforcement.

The default configuration is `~/.config/heddle/config.yml`; the default state
directory is `~/.local/state/heddle/`, containing `heddle.sqlite`. See the
[command-line reference](docs/reference/command-line.md) for overrides,
signals, diagnostics, writer ownership, and recovery.

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
state:
  databasePath: /var/lib/heddle/heddle.sqlite
polling:
  intervalMs: 30000
pass:
  defaultModel:
    instanceId: sample-provider
    model: sample-model
  defaultWorktree: /workspaces
```

`projects` lists the bound GitHub Projects. An empty list runs an idle service.
`github.credentialFile` points to
Heddle's GitHub App credential file. `t3Code.endpoint` names the T3 Code
server, and `t3Code.tokenFile` points to its bearer token. The blueprint
repository is a local Git checkout or a blueprint directory within one.
`intake.commit` selects the Git revision for new intake runs. A run stores its
full commit and resolved graph; prompts, handoff schemas, and policies come
from that commit on execution and restart. Working-tree edits do not change a
run. Commit authored changes and select the new revision for new runs. Keep
those Git objects available for existing runs. Linked worktrees and packed
objects use the same contract. `webhook.secretFile` points to the secret
used to verify GitHub deliveries. Secret values are read from these files;
they do not belong in YAML values, Feature options, command arguments, or
logs.

`state.databasePath` overrides the SQLite path. Otherwise Heddle uses
`heddle.sqlite` below the selected state directory. `polling.intervalMs`
defaults to 30000. One service owns the database writer. A second service exits
before opening SQLite. `SIGINT` and `SIGTERM` close the service and release the
writer; restart after an abrupt process death recovers durable runs.

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
state. Run the issuance command as the T3 Code service account, write its
output directly to the mounted token file, and restrict that file to the
separate Heddle service account:

```sh
t3_service_user=service-a
t3_base_dir=/var/lib/service-a
heddle_service_user=service-b
install -m 0600 -o "${heddle_service_user}" \
  -g "$(id -gn "${heddle_service_user}")" \
  /dev/null /path/to/secrets/heddle-t3-token
sudo -u "${t3_service_user}" \
  t3 auth session issue --base-dir "${t3_base_dir}" \
  --label heddle --token-only \
  > /path/to/secrets/heddle-t3-token
```

Set `t3_service_user` and `t3_base_dir` to the account and state directory used
by the T3 Code server. Set `heddle_service_user` to the account that runs
Heddle, then set `t3Code.endpoint` to that server. Run the sequence from a root
shell so it can create the destination with Heddle ownership and redirect the
T3 Code command's output without granting the T3 Code account access to the
token file. A one-time token from `t3 pair` or `t3 auth pairing create` must be
exchanged for a bearer session before it can be stored; one-time pairing tokens
are not restart credentials.

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
in isolated Dev Container builds. The test records one supervised PID across
separated observations, requires exit status 0 after stopping the service, and
then records a stable new PID after starting against the same store. A
restart-looping fixture must fail the PID proof, and a dirty-exit fixture must
fail the shutdown proof.

## Status

Pre-release. See `AGENTS.md` for the principles and `docs/technical-designs/`
for the design.

## License

Apache-2.0.

## GitHub binding API

`GitHubBindingService` composes the engine with project reconciliation,
issue discovery, stage projection, and the `github` node. Construct it with a
`RunStore`, configured projects, `appClients(config.github.credentialFile,
budget)`, a provider of bound blueprints, and the engine options. `start()`
reconciles, discovers, repairs lifecycle attachments, and starts the configured
intake for every new issue. `poll()` repeats discovery before delivering
snapshot diffs through the same handler used by signed webhooks. See the
[binding reference](docs/reference/github-binding.md) for event, intake,
project-choice, permission-attention, pause, and shipped blueprint contracts.

The credential file contains `app-id`, an `installations` mapping from owner
login to installation id, and `private-key`. The binding accepts an App
credential only. Request counters report GraphQL calls, REST calls, and writes;
App authentication exchanges are separate from those counters.

Snapshots retain identity, content, organization fields, the bound card's
fields, relationships, and `frontMatter`. Front matter uses this form at the
start of the issue body:

```markdown
<!--
---
servings: 4
---
-->
```

Snapshots are cached in the instance store and copied into a run's durable
initial context. An issue in multiple bound projects asks one durable project
question and starts no lifecycle until `answerProjectChoice` records a valid
answer on the selected card. Invalid issue front matter raises attention with
the issue reference and leaves other issues available for discovery. Repeated
project attention messages are deduplicated. Status options retain their
existing order and append new stage node ids. Removed stages remain as options. `Paused` is a
single-select field with `Yes` and `No` options. The service owns both fields.
Missing organization fields can be mirrored onto a project when declared by
`requires.issue.fields`; unknown field names raise attention.

The implemented `github` operations accept these params:

- `set-field`: `field`, `value`, and optional `scope: organization`.
- `comment`: `body`.
- `add-labels`: `labels`, an array of existing label names.

Writes read current state first. Completed effects retain their input and
snapshot so replay does not overwrite later changes. Comments also carry an
invisible effect marker so recovery after a remote write can find them.
A permission refusal records attention and leaves the node awaiting an
operator decision. `resolvePermissionAttention` continues the exact run, node,
and visit occurrence without retrying the request; repeated and stale
continuations are inert.

For live validation, set `HEDDLE_CONFIG` to the configuration file and run
`heddle validate --check-requires-issue <path>`. The check reads every bound
project's fields and Status options, organization issue types, repository
labels, and open issues' front-matter keys. It performs no writes.

The disposable-project qualification is opt-in:

```sh
HEDDLE_BINDING_LIVE=1 \
HEDDLE_BINDING_CREDENTIALS=/path/to/app.yml \
HEDDLE_BINDING_OWNER=sample-owner \
HEDDLE_BINDING_REPO=sample-repository \
npx vitest run --config vitest.github-live.config.ts src/binding/binding.live.test.ts
```

It creates a project, two issues, a label, and an organization text field in
the selected sandbox. It closes the issues and deletes the project, label,
and field at completion. Permission refusal uses a reduced installation grant
minted by the same App for the field-value mutation; reads use its normal grant. The normal App needs Issues write, Issue fields write,
Issue types read, and Organization projects administration for this binding.
