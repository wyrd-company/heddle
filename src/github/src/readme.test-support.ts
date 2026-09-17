/**
 * Compile-only proof that the README examples type-check and that the declared
 * schema rejects wrong field and option names. Never executed; excluded from the
 * build and imported by nothing.
 */
import { defineIssueFields, defineProject, github } from "./index.js";

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

export async function readmeExamples(): Promise<void> {
  const gh = github({ auth: { token: "example" } });
  const pantry = gh.owner("pantry-labs", { issueFields });
  const repo = pantry.repo("recipes");

  const project = await pantry.project(board).ensure();
  await project.update({ shortDescription: "Every recipe from idea to publication" });
  await project.linkRepository("pantry-labs/recipes");

  const item = await project.add(repo.issue(42));
  await item.set({ Status: "Drafting", Servings: 4, "Publish week": "2026-10-12" });
  await item.set({ Priority: "High" });
  await item.set({ Status: null });
  // @ts-expect-error option outside the schema
  await item.set({ Status: "Done" });
  // @ts-expect-error field outside the schema
  await item.set({ Stage: "Drafting" });
  // @ts-expect-error wrong value kind
  await item.set({ Servings: "four" });
  // @ts-expect-error option outside the org field schema
  await item.set({ Priority: "Critical" });

  const draft = await project.add({ draft: { title: "Sourdough starter guide" } });
  await draft.editDraft({ body: "Outline" });
  await draft.convertToIssue("pantry-labs/recipes");
  await project.postStatus({ status: "ON_TRACK", body: "Photography booked." });

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
  // @ts-expect-error option outside the org field schema
  await issue.set({ fields: { Priority: "Critical" } });
  await issue.link({ parent: "pantry-labs/recipes#10", blockedBy: ["pantry-labs/recipes#40"] });
  await issue.link({ closedBy: [repo.pull(57)] });
  await issue.moveSubIssue("pantry-labs/recipes#43", { after: null });
  const comment = await issue.comment("Testing on Thursday.");
  await comment.react("ROCKET");
  await issue.close({ reason: "duplicate", of: "pantry-labs/recipes#12" });
  await issue.unmarkDuplicate();
  await issue.close({ reason: "completed" });

  const pr = await repo.pulls.create({
    title: "Green curry draft",
    head: "recipe/green-curry",
    base: "main",
    draft: true,
  });
  await pr.set({ draft: false, labels: { add: ["needs-photo"] }, milestone: "Autumn issue" });
  await pr.link({ closes: [issue] });
  await pr.requestReview({ users: ["chef-amara"], teams: ["photo-desk"] });
  const thread = await pr.thread({ path: "recipes/green-curry.md", line: 12, body: "Amount?" });
  await thread.reply("Fixed in the next push.");
  await thread.resolve();
  const review = await pr.review({ event: "APPROVE", body: "Ready for the test kitchen." });
  await review.dismiss("Superseded by a later review.");
  await pr.close();

  await repo.labels.ensure([
    { name: "vegan", color: "0e8a16" },
    { name: "needs-photo", color: "fbca04" },
  ]);
  await repo.milestones.ensure({ name: "Autumn issue", dueOn: "2026-11-01" });
  await repo.milestones.update("Autumn issue", { state: "closed" });
  await repo.labels.delete("needs-photo");

  await pantry.issueTypes.ensure([
    { name: "Recipe", color: "GREEN" },
    { name: "Correction", color: "RED", description: "Fix to a published recipe" },
  ]);
  await pantry.issueFields.ensure();
  for await (const field of pantry.issueFields.list()) void field.name;
}
