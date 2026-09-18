---
relationships:
  describes: github-binding-and-intake
  references:
    - engine-and-run-model
    - node-types
    - blueprint-authoring
---

# GitHub binding, delivery, and intake

`GitHubBindingService` binds GitHub Projects to workflow instances. `start()`
first checks every node in the loaded blueprint repository against the node
types composed into that service. An unavailable type stops startup with the
blueprint id, node id, type, and required configuration before project
reconciliation, recovery, intake, or other external effects. After that check,
`start()` reconciles project fields, discovers open issues, repairs lifecycle
attachments, and starts the configured intake for every instance without a lifecycle.
`poll()` performs the same discovery and intake work before it diffs known issue
and card snapshots.

Configure automatic intake with `options.intake.blueprintId` and its captured
blueprint repository commit. The intake run is an implementation detail of
selection. An instance's `runId` identifies the selected top-level lifecycle.
The lifecycle keeps the `lifecycle-start` origin and its immutable initial issue
and mapped inputs. Startup repairs an interrupted attachment from those durable
values and does not reload live issue data to reconstruct them.

## Event delivery

`events.webhook(event, signature, body, secret)` verifies the HMAC SHA-256
signature before parsing an `issues`, `projects_v2_item`, `issue_comment`, or
`pull_request` payload. `poll()` emits synthesized payloads through the same
handler. A snapshot and its issue update time form the durable delivery
identity. An equivalent webhook and poll result updates the instance and wakes
matching `on-issue-change` nodes once, including after restart.

`on-issue-change.params.when` evaluates with the changed issue as its JSONata
root. `params.bindings` maps JSONata variable names to immutable values captured
in the run context. For example:

```yaml
params:
  when: type = $expectedtype
  bindings:
    expectedtype: expectedType
```

Validation rejects an unknown binding source and an unbound variable. Delivery
updates the instance's current snapshot. It does not change an existing run's
`initialContext` or the values captured by the waiting node.

## Operator flows

An issue in several bound projects creates one durable project-choice question.
Read it from `startIntake()` and answer it with
`answerProjectChoice(issueId, occurrenceId, projectId)`. A valid answer writes
`Heddle Project` to the selected card. Repeated delivery and restart retain the
answer and target Status projection to that card.

`pauseInstance(issueId)` and `resumeInstance(issueId)` change the engine state
and project the effective state to the card's `Paused` field. A person changing
that field invokes the same engine operations. A person changing Status while a
pass waits resumes that pass with `overridden`. Snapshot deduplication prevents
either projection from feeding back into another operation.

A GitHub permission refusal records an awaiting `github-attention` occurrence.
After the operator resolves the external permission problem, call
`resolvePermissionAttention(runId, nodeId, visit)`. The call continues that
exact occurrence without retrying the refused effect. Replaying it immediately
or after restart is inert. A later refusal has a new visit and requires its own
resolution call. Explicit attention reopening is not supported.

## Shipped helper blueprints

The package ships `blueprints/default-intake.yml`,
`blueprints/hold-then-attention.yml`, and
`blueprints/rules/default-intake.yml`. They are ordinary blueprint repository
files. Copy them into the user's blueprint repository and replace or edit them
there.

The default policy maps the generic `Work item` issue type to
`standard-lifecycle`. Replace that rule and target with the user's issue types
and lifecycle ids. Its fallback starts `hold-then-attention`. The hold helper
keeps the expected issue type in one input, uses that input for its immutable
wake binding and notification message, retries intake after a matching change,
and sends attention after its authored `PT24H` deadline.

Register `PushoverDelivery` as `options.notifications` when any loaded blueprint
uses `notify`. Notification delivery remains optional when the loaded repository
does not use `notify`. The service rejects startup when a loaded `notify` node
has no configured delivery. This service compatibility check does not apply to
the `heddle validate` authoring command.

```ts
new PushoverDelivery({
  token: process.env["PUSHOVER_APPLICATION_TOKEN"] ?? "",
  user: process.env["PUSHOVER_CHANNEL_KEY"] ?? "",
});
```

The delivery sends `title`, `message`, and optional `url` as a Pushover form.
Tests inject a fetch implementation and generic test-channel values.
