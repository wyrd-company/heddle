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

One process owns one database. A second service pointed at the same file exits
with an ownership error before opening SQLite. `SIGINT` and `SIGTERM` stop
intake, close listeners and clients, close SQLite, release ownership, and exit
successfully. After `kill -9`, the next process recognizes the dead owner and
recovers runs from the same database.
