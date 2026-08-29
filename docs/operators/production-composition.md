---
relationships:
  implements: heddle
  references:
    - t3-headless
    - t3-session-visibility
---

# Production composition

One production composition owns one workspace. Construct it with
`createProductionComposition`, supply it to `startHeddleServerFromEnvironment`,
and use the same composition for the server, console, MCP endpoint, scheduler,
attention queue, and persistence lifetime. The factory rejects a second live
composition for the same board directory.

Configuration conforms to `schemas/production-configuration.json`. Required
workspace values are the absolute board, repository, state, and optional
worktree roots; the existing T3 project ID; reconciliation cadence; bounded
stop timeout; provider pacing; session provider settings; observation and
per-stage staleness thresholds; and Pushover routing. Secrets enter the
in-memory configuration from the operator's secret source and are not stored in
the repository.

The provider-usage source and session-capable T3 adapter are explicit runtime
ports. The T3 adapter must apply the accepted Codex or Claude MCP timeout before
thread creation. Heddle fails session start when this port is absent for either
provider. Every thread uses the configured workspace `projectId`, a bounded
deterministic `Heddle · task-<id> · <stage-discriminator>` title, and no
`titleSeed` on its first turn.

The scheduler starts with one immediate pass and then uses the configured
cadence. Ticks coalesce while a pass is active; passes never overlap. Stop
cancels the owned timer, refuses new passes, drains the current pass, and fails
within the configured bound if the pass cannot drain.

Attention and notification delivery use the stable attention ID from the
accepted lifecycle or escalation contract. SQLite stores attention and adapter
completion records. A restart replays an unfinished escalation route without
adding a second attention entry or repeating a completed Pushover delivery.
Pushover transport is an explicit port so qualification can use a synthetic
transport. Routine operation uses `HttpPushoverTransport`.

Qualification uses generated boards, repositories, state directories,
worktrees, and synthetic notification transport. It does not use the shared
board, the live T3 server, ambient T3 state, or live Pushover.
