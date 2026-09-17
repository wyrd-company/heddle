---
relationships:
  implements:
    - github-client
    - github-binding-and-intake
    - node-types
---

# GitHub client

Strongly typed TypeScript access to the GitHub surfaces a workflow system needs: Projects v2, issues, pull requests, labels, milestones, organization issue types, and organization issue fields.

This is an internal Heddle module. Heddle uses it to configure GitHub to
reflect a blueprint, create and conform projects, and move issues and pull
requests through a workflow. Its technical design is
`docs/technical-designs/github-client.yml` from the repository root. The
repository `AGENTS.md` is the canonical testing and live-environment guide.

## Module boundary

Heddle code imports the preserved public surface through the module entry:

```ts
import { github } from "./github/index.js";
```

## Authentication

```ts
import { github } from "./github/index.js";

const gh = github({ auth: { token: process.env.GITHUB_TOKEN! } });
// GitHub App, installation known:
const gh2 = github({ auth: { appId, privateKey, installationId } });
// GitHub App, installation resolved from the owner login:
const gh3 = github({ auth: { appId, privateKey, owner: "pantry-labs" } });
```

A pre-minted installation token is passed as `{ token }`. The `transport`
option replaces the wire; `ScriptedTransport` from `src/github/testing.ts`
answers each operation from a script.

```ts
import { ScriptedTransport } from "./github/testing.js";
```

## Declaring a schema

Declare organization issue fields and a project once. Field names and option names become compile-time facts.

```ts
import { defineIssueFields, defineProject } from "./github/index.js";

export const issueFields = defineIssueFields({
  Priority: { type: "singleSelect", options: ["Urgent", "High", "Medium", "Low"] },
  "Target date": { type: "date" },
});

export const board = defineProject({
  title: "Recipe pipeline",
  fields: {
    Status: { type: "singleSelect", options: ["Idea", "Drafting", "Testing", "Published"] },
    Servings: { type: "number" },
    "Publish week": { type: "iteration", startDate: "2026-10-05", duration: 7 },
    Priority: { type: "issueField" },
  },
});
```

`item.set({ Status: "Drafting" })` compiles. `item.set({ Status: "Done" })` and `item.set({ Stage: "Drafting" })` do not. A project field of type `issueField` mirrors the organization field with the same name and takes its value type from the issue-field declaration.

## Projects

```ts
const pantry = gh.owner("pantry-labs", { issueFields });

const project = await pantry.project(board).ensure(); // create or conform
project.lastEnsure.changes; // created, updated, option-added, field-unmanaged, ...

await project.update({ shortDescription: "Every recipe from idea to publication" });
await project.linkRepository("pantry-labs/recipes");

const item = await project.add(pantry.repo("recipes").issue(42));
await item.set({ Status: "Drafting", Servings: 4, "Publish week": "2026-10-12" });
await item.get(); // { Status: "Drafting", Servings: 4, "Publish week": { title: "..." }, Priority: null }
await item.archive();

const draft = await project.add({ draft: { title: "Sourdough starter guide" } });
await draft.editDraft({ body: "Outline" });
const issue = await draft.convertToIssue("pantry-labs/recipes");

await project.postStatus({ status: "ON_TRACK", body: "Photography booked." });
await project.fields.delete("Servings"); // explicit; ensure never deletes
```

`ensure` creates missing fields, appends missing options, updates colours and descriptions, and reports drift it will not fix. `open()` verifies an existing project against the schema without writing and throws `SchemaMismatchError` listing every gap. `owner.project(7)` opens an undeclared project; values resolve at runtime.

## Issues

```ts
const repo = pantry.repo("recipes");

const issue = await repo.issues.create({
  title: "Green curry",
  type: "Recipe",
  labels: ["vegan"],
  milestone: "Autumn issue",
  fields: { Priority: "High", "Target date": "2026-10-20" },
});

await issue.set({
  labels: { add: ["needs-photo"] },
  assignees: ["chef-amara"],
  fields: { Priority: "Medium" },
});
await issue.link({ parent: "pantry-labs/recipes#10", blockedBy: ["pantry-labs/recipes#40"] });
await issue.link({ closedBy: [repo.pull(57)] }); // Development link
await issue.moveSubIssue("pantry-labs/recipes#43", { after: null });

const comment = await issue.comment("Testing on Thursday.");
await comment.react("ROCKET");

await issue.close({ reason: "duplicate", of: "pantry-labs/recipes#12" });
await issue.unmarkDuplicate();
await issue.close({ reason: "completed" });

for await (const data of repo.issues.list({ states: ["OPEN"] })) console.log(data.number);
```

Labels and assignees take an array to replace or `{ add, remove }` to change. `null` clears a milestone, type, or field value.

Issue loads and issue-list entries include every page of `subIssues`, `blockedBy`, `blocking`, and `closedBy`. A continuation failure rejects the load, so callers never receive a partial relationship snapshot. `github({ relationshipPageSize })` can lower the default page size of 100; GitHub accepts values from 1 through 100. Parent and duplicate relationships are singular. Labels, assignees, and organization issue-field values remain limited to their first 100 entries.

## Pull requests

```ts
const pr = await repo.pulls.create({
  title: "Green curry draft",
  head: "recipe/green-curry",
  base: "main",
  draft: true,
});

await pr.set({ draft: false, labels: { add: ["needs-photo"] }, milestone: "Autumn issue" });
await pr.link({ closes: [issue] });
await pr.requestReview({ users: ["chef-amara"], teams: ["photo-desk"] });

const thread = await pr.thread({
  path: "recipes/green-curry.md",
  line: 12,
  body: "Coconut milk amount?",
});
await thread.reply("Fixed in the next push.");
await thread.resolve();

const review = await pr.review({ event: "APPROVE", body: "Ready for the test kitchen." });
await review.dismiss("Superseded by a later review.");
await pr.close();
```

## Labels and milestones

Every named resource is a `Catalog` with `list`, `get`, `find`, `create`, `update`, `delete`, and `ensure`.

```ts
await repo.labels.ensure([
  { name: "vegan", color: "0e8a16" },
  { name: "needs-photo", color: "fbca04" },
]);
await repo.milestones.ensure({ name: "Autumn issue", dueOn: "2026-11-01" });
await repo.milestones.update("Autumn issue", { state: "closed" });
await repo.labels.delete("needs-photo"); // idempotent
```

## Organization issue types and fields

```ts
await pantry.issueTypes.ensure([
  { name: "Recipe", color: "GREEN" },
  { name: "Correction", color: "RED", description: "Fix to a published recipe" },
]);
await pantry.issueFields.ensure(); // from the declared issueFields
for await (const field of pantry.issueFields.list()) console.log(field.name, field.type);
```

## Errors

Every failure is a thrown `GitHubError` with a `code`: `NOT_FOUND`, `FORBIDDEN`, `UNAUTHENTICATED`, `RATE_LIMITED`, `VALIDATION`, `SCHEMA_MISMATCH`, `RESPONSE_SHAPE`, `NOT_DRAFT`, `AMBIGUOUS`, `UNSUPPORTED`, `UNKNOWN`. Subclasses carry detail: `NotFoundError.resource`, `RateLimitError.resetAt`, `SchemaMismatchError.gaps`, `AmbiguousError.candidates`. GraphQL partial data is never returned; any error in the response is thrown.

## Verification

```sh
task check
task test:github-live
task github-schema-refresh
```

The generated GraphQL lookup is keyed by formatted operation text. `task build`
runs codegen before type compilation. A document whose text drifted from the
generated map throws at first use. Live credentials, sandbox variables, and
cleanup behavior are documented in the repository `AGENTS.md`.

## Known limits

- Organization issue-field options cannot be appended through the API: `updateIssueField` replaces the option set, rejects names that already exist, and mints new option ids. The catalog throws `UNSUPPORTED` instead of orphaning values; edit options in the GitHub UI.
- Values of an `issueField`-backed project field live on the issue, so a draft item cannot hold one.
- Project views and built-in project workflows are read-only in the API and are not exposed.
- GitHub App installation tokens cannot assign bot users.
- A review thread or reply added outside a review lands in an implicit pending review, and GitHub allows one pending review per author. `pr.thread()` and `thread.reply()` submit that review as a comment so the thread is visible and the author can still review.
- GitHub reads a milestone `due_on` in US Pacific time. The package sends noon UTC so the calendar date holds.
