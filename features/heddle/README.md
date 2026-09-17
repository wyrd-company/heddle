# Heddle Dev Container Feature

Installs the packed `@wyrd-company/heddle` npm package and registers `heddle
start` as a native s6-overlay 3 longrun service.

The Feature requires a Debian or Ubuntu image with s6-overlay 3 and `/init` as
PID 1. Node.js 24 is supplied by the official Dev Container Node Feature. Set
`"overrideCommand": false` in `devcontainer.json` so s6 remains PID 1.

The published Feature artifact contains the package tarball produced from the
same accepted source revision. The source directory does not contain a checked-in
tarball; its qualification task stages one with `npm pack` before the isolated
Dev Container build.

## Options

| Option                     | Type   | Default                              | Purpose                                  |
| -------------------------- | ------ | ------------------------------------ | ---------------------------------------- |
| `configFile`               | string | `/etc/heddle/config.yml`             | Bind-mounted service configuration file. |
| `stateDirectory`           | string | `/var/lib/heddle`                    | Bind-mounted SQLite and durable state.   |
| `githubAppCredentialsFile` | string | `/run/secrets/heddle-github-app.yml` | Bind-mounted GitHub App credential file. |
| `t3CodeTokenFile`          | string | `/run/secrets/heddle-t3-token`       | Bind-mounted T3 Code bearer-token file.  |
| `webhookSecretFile`        | string | `/run/secrets/heddle-webhook-secret` | Bind-mounted GitHub webhook secret file. |
| `serviceUser`              | string | `automatic`                          | Account that runs the service.           |

Every secret option is a file location. Secret values do not enter Feature
options, generated launchers, or installation logs.

The current `start` scaffold writes its usage and exits with status 2, so s6
restarts it in a loop. The Feature is not operational until the later service
integration replaces the scaffold with a durable process and eliminates that
restart loop.

See the repository [README](../../README.md#dev-container-feature) for the
configuration schema, bind mounts, GitHub App permissions, and T3 Code pairing.
