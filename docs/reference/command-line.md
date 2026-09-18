---
relationships:
  implements: command-line-interface
---

# Heddle command line

`heddle start` runs the production service. With no flags, it reads
`~/.config/heddle/config.yml`, keeps durable state in
`~/.local/state/heddle/`, and opens `heddle.sqlite` below that directory.

```sh
heddle start
heddle start --config /path/to/config.yml
heddle start --state /path/to/state
heddle start --database /path/to/state.sqlite
heddle start --poll-interval 30000
```

The YAML keys and CLI options are defined by
`docs/specifications/command-line-interface.yml`. CLI values override YAML
values. Startup diagnostics name resolved paths and never print secrets.

Each option is a singleton and requires one value that does not start with
`-`. An unknown option, a missing or flag-shaped value, a duplicate option, or
an invalid polling interval prints command usage and exits with status 2.
Configuration and ownership failures exit with status 1.

One process owns one database. A second service pointed at the same file exits
with an ownership error before opening SQLite. `SIGINT` and `SIGTERM` stop
intake, close listeners and clients, close SQLite, release ownership, and exit
successfully. The operating system releases ownership after `kill -9`; the next
process acquires ownership and recovers runs from the same database. The
`<database>.writer` file remains on disk as the lock anchor.

Generated-tool requests receive HTTP 503 until engine and pass recovery
finish. The external webhook listener remains closed during recovery. Hook
traffic and intake start after recovery.

Each database has its own `<identity>` socket under the state directory.
The filename is the first 16 base64url characters of the canonical database
path’s SHA-256 (96 bits). The full path must fit the operating system’s Unix
socket path limit. Different databases can share that directory. Startup prints
the exact hook socket path. Hook commands derive the default socket from `heddle.sqlite`
under `HEDDLE_STATE_DIR` or the default state directory. For a database
override, set `HEDDLE_HOOK_SOCKET` to the socket reported at startup in the
agent harness environment.

`blueprints.repository` names a Git checkout or a blueprint directory within
one. `intake.commit` selects a commit or named ref for new intake runs. Each
new root run resolves it once to a full commit and stores that identity with
its graph. A repeated start for the same run and original revision uses that
stored commit even after a named ref moves. Prompts, handoff schemas, and policies use the same commit during
execution and restart. Working-tree edits do not affect existing runs. Keep
the pinned Git objects available while their runs need them; the working tree
can move to another commit. `heddle validate` checks authored working-tree
files with the same validation contracts used for committed runtime snapshots.
Repository metadata and object-read failures name the requested revision and
do not include raw Git errors, repository URLs, or absolute repository paths.
Reference findings include the authored reference in the JSON `reference`
field. Runtime diagnostics use that field and apply the existing safe identity
filter instead of parsing the human `message` text.

Webhook listening is disabled by default. To enable it, configure both
`webhook.listen.host` and `webhook.listen.port`; there is no default port.
Use `127.0.0.1` behind a host proxy or tunnel when that proxy can reach the
service's loopback interface. Operators may select another interface, including
`0.0.0.0`. `webhook.secretFile` supplies the signature secret; the CLI
`--webhook-secret` and Feature `webhookSecretFile` override only its file path.
Polling remains available with or without webhook listening.

The external listener serves only `POST /webhook/github` after recovery and
binding startup. Other paths and methods return 404. Invalid signatures retain
the existing error response and never reach binding delivery. Generated tools
use a separate ephemeral loopback listener. Hook transport, bearer tokens, and
SQLite state are not served by the external listener. Startup output names the
configured webhook route, or `webhook=disabled`, without generated-tool endpoints.
See [host routing and acceptance checks](webhook-routing.md).
