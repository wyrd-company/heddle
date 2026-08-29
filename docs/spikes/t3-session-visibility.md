---
relationships:
  references: t3-headless
---

# Investigation: T3 Code thread visibility

Build-to-learn investigation (kanban #654). Question: how does T3 Code surface,
name, group, and hide threads, and which controls are available to Heddle through
`POST /api/orchestration/dispatch`?

## Verdict

T3 has no thread label, tag, arbitrary group, or create-time visibility field.
An API caller can set the thread title and project, then use ordinary dispatch
commands to archive, settle, snooze, or pin the thread. These are the same
commands used by the clients; they are not UI-only operations.

Heddle should give every created thread a stable, stage-specific `title`, omit
`titleSeed` from `thread.turn.start` so T3 does not replace that title, and
archive the thread after its stage is terminal and no operator participation is
pending. It should not snooze active work because snooze deliberately suppresses
the row while the agent continues to run.

## Source and version boundary

The findings use the shallow T3 checkout at
`/workspaces/references/t3code`, inspected at upstream commit
`d22709f759ced90b0ae7b7cb73d7ad22c2ce962b` (2026-08-28). That commit is two
commits after nightly tag `v0.0.37-nightly.20260829.1218`. The latest stable npm
release observed during the investigation was `t3` 0.0.36.

The earlier headless spike ran T3 0.0.35 at commit `b0ae3f3a8`. The dispatch
commands described here are present in both 0.0.35 and 0.0.36. Current source
also carries active development of the sidebar behavior, so Heddle must treat
these private, unversioned contracts as version-pinned. The running s6 server on
`:3773`, the global `t3`, and `/home/vscode/.t3` were not touched.

The create/archive path was also executed against an isolated T3 0.0.36 server
on `127.0.0.1:3802` with a fresh base directory and a generic scratch Git
repository. `project.create`, `thread.create`, and `thread.archive` returned
sequences 1, 2, and 3. The shell snapshot showed the exact supplied title and
`archivedAt:null` after creation, then omitted the thread after archive. The
server was stopped after the check. The source contracts and client list
partitions supply the remaining behavior that does not require a browser.

## Creation and title behavior

`thread.create` requires these fields:

```json
{
  "type": "thread.create",
  "commandId": "<uuid>",
  "threadId": "<uuid>",
  "projectId": "<uuid>",
  "title": "Heddle · <stage> · <task>",
  "modelSelection": {
    "instanceId": "<provider-instance>",
    "model": "<model-slug>"
  },
  "runtimeMode": "auto-accept-edits",
  "interactionMode": "default",
  "branch": "<branch-or-null>",
  "worktreePath": "<absolute-path-or-null>",
  "createdAt": "<iso-date-time>"
}
```

There is no `label`, `tag`, `group`, `hidden`, `archived`, `settled`, `snoozed`,
or `pinned` field on this command. `projectId` is the only create-time placement
control. A title can later be changed with:

```json
{
  "type": "thread.meta.update",
  "commandId": "<uuid>",
  "threadId": "<uuid>",
  "title": "Heddle · <stage> · <task>"
}
```

The UI derives a provisional title from the first prompt. Mobile collapses
whitespace and truncates the value to 72 characters; web also derives and
truncates a prompt or attachment-based seed. Both pass that value as the
create-time `title` and the optional `thread.turn.start.titleSeed`.

The server may replace a title after the first turn only when the current title
is exactly `"New thread"` or exactly matches `titleSeed`. Therefore a decomposed
HTTP caller can keep a deterministic title by setting it on `thread.create` and
omitting `titleSeed` from `thread.turn.start`. `titleSeed` is not required:

```json
{
  "type": "thread.turn.start",
  "commandId": "<uuid>",
  "threadId": "<uuid>",
  "message": {
    "messageId": "<uuid>",
    "role": "user",
    "text": "<stage instruction>",
    "attachments": []
  },
  "runtimeMode": "auto-accept-edits",
  "interactionMode": "default",
  "createdAt": "<iso-date-time>"
}
```

For the WebSocket-only bootstrap path, the corresponding create title is
`thread.turn.start.bootstrap.createThread.title`. The same recommendation
applies: set that field and omit the top-level `titleSeed`.

## What the clients list by default

The normal shell snapshot excludes archived threads at the server query:
`deleted_at IS NULL AND archived_at IS NULL`. Archived threads have a separate
snapshot and appear in web Settings > Archived threads and the mobile Archived
Threads settings screen. Unarchive returns them to the normal shell.

Within the normal web sidebar, unarchived threads are partitioned in this order:

1. Pinned threads.
2. Active threads.
3. Snoozed shelf, collapsed by default and ordered by nearest wake time.
4. Settled shelf, expanded by default, with the first 10 rows rendered before
   “Show more”.

Snooze outranks settlement and pinning. A snoozed thread returns to the active
classification when its time passes or it raises its hand through pending
approval, pending user input, a new failure, or turn completion. Settled threads
remain in the live shell and remain searchable; archive is the operation that
removes a thread from the default sidebar.

The default client settings auto-settle eligible inactive threads after three
days and on pull-request merge. Pending approval or user input, a starting or
running session, queued work, and an open pull request keep a thread active.

Projects, not threads, provide grouping. The clients group project records by
repository by default, with `repository_path` and `separate` as client setting
alternatives. These modes and per-project grouping overrides are client-local
settings, not thread creation or dispatch fields. Heddle can select `projectId`,
but it cannot force an operator's project grouping preference through the
orchestration API.

## Visibility commands available through HTTP dispatch

The HTTP endpoint accepts `ClientOrchestrationCommand`, whose union includes all
of these commands.

### Archive and restore

Archive is the correct terminal cleanup for a short-lived Heddle stage. It is
reversible and preserves conversation history outside the default sidebar.
Archiving active running work is rejected.

```json
{"type":"thread.archive","commandId":"<uuid>","threadId":"<uuid>"}
```

```json
{"type":"thread.unarchive","commandId":"<uuid>","threadId":"<uuid>"}
```

### Settle and return to active

Settle moves eligible work to the visible Settled shelf; it is not a hide or
archive operation. The inverse command requires the literal reason `"user"`.

```json
{"type":"thread.settle","commandId":"<uuid>","threadId":"<uuid>"}
```

```json
{
  "type":"thread.unsettle",
  "commandId":"<uuid>",
  "threadId":"<uuid>",
  "reason":"user"
}
```

### Snooze and wake

Snooze hides the row in a collapsed shelf until its deadline or a raised-hand
condition. It does not stop the agent. Pending approval, pending user input, and
queued work prevent snoozing. The inverse command requires `reason:"user"`.

```json
{
  "type":"thread.snooze",
  "commandId":"<uuid>",
  "threadId":"<uuid>",
  "snoozedUntil":"<iso-date-time>"
}
```

```json
{
  "type":"thread.unsnooze",
  "commandId":"<uuid>",
  "threadId":"<uuid>",
  "reason":"user"
}
```

### Pin and reorder

Pin places a thread above the active list. `orderKey` is optional when pinning
and required for explicit reorder. It is a fractional index string managed by
the clients, so Heddle should not synthesize it unless it owns the complete
pinned ordering policy.

```json
{"type":"thread.pin","commandId":"<uuid>","threadId":"<uuid>"}
```

```json
{"type":"thread.unpin","commandId":"<uuid>","threadId":"<uuid>"}
```

```json
{
  "type":"thread.pin.reorder",
  "commandId":"<uuid>",
  "threadId":"<uuid>",
  "orderKey":"<fractional-index>"
}
```

## Recommendation for Heddle

1. Use one existing T3 project for the workspace and set its `projectId` on
   every stage thread. Do not create synthetic projects as a grouping device.
2. Set a concise deterministic title containing the Heddle marker, stage, and
   task identity. Keep the stable discriminator at the start so truncation does
   not erase it.
3. Omit `thread.turn.start.titleSeed` so provider-generated title replacement
   cannot remove the Heddle identity.
4. Leave running and operator-blocked threads active. Do not snooze them.
5. Dispatch `thread.archive` after a stage reaches its terminal state and no
   approval, user-input request, or conversational handoff remains. Retain the
   `threadId` in Heddle's execution record so the thread can be found or
   unarchived later.
6. Do not pin, settle, or reorder by default. Pin is operator attention policy;
   settle still consumes normal-sidebar space; reorder requires ownership of a
   user-arranged ordering.

The only new Heddle lifecycle obligation is the terminal archive dispatch. The
title and `titleSeed` choices belong at thread creation and first-turn dispatch,
respectively.
