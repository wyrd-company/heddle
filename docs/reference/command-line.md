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

Webhook and generated-tool requests receive HTTP 503 until engine and pass
recovery finish. Hook traffic and intake start after recovery.

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
its graph. Prompts, handoff schemas, and policies use the same commit during
execution and restart. Working-tree edits do not affect existing runs. Keep
the pinned Git objects available while their runs need them; the working tree
can move to another commit. `heddle validate` checks authored working-tree
files with the same validation contracts used for committed runtime snapshots.
