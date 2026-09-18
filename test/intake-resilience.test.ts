// ---
// relationships:
//   verifies: github-binding-and-intake
// ---
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { GitHubBindingService } from "../src/binding/service.js";
import { RunStore } from "../src/engine/store.js";
import { BlueprintCatalog } from "../src/service/blueprints.js";
import { serviceNodes } from "../src/service/nodes.js";
import { commitFixture, fixtureGit } from "./support/blueprint-repository.js";
import { fixture, recipe } from "./binding.fixture.js";

const stores: RunStore[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const INTAKE = `# Select a lifecycle, holding the issue until a rule matches.
id: sample-intake
kind: helper
entry: classify
nodes:
  classify:
    uses: policy
    config:
      joinStrategy: any
    params:
      rules: rules/sample.yml
      input: { from: issue }
  start-lifecycle:
    uses: lifecycle-start
    params:
      blueprint: { from: classify.blueprint }
      inputs: { from: classify.inputs }
  hold-for-fix:
    uses: on-issue-change
    params:
      deadline: PT24H
  wait-for-fix:
    uses: on-issue-change
edges:
  - from: classify
    to: start-lifecycle
    when: result.output.matched
  - from: classify
    to: hold-for-fix
    when: "result.output.matched = false"
  - from: hold-for-fix
    to: classify
    when: result.output.changed
  - from: hold-for-fix
    to: wait-for-fix
    when: result.output.timeout
  - from: wait-for-fix
    to: classify
    when: result.output.changed
`;
const LIFECYCLE = `id: sample-lifecycle
kind: process
nodes:
  work:
    uses: wait
    stage: true
edges: []
`;

function rules(target: string): string {
  return `rules:\n  - id: matched\n    when: type = 'Work item'\n    blueprint: ${target}\n    inputs: {}\n`;
}

/** A blueprint root under git, so a revision can move between attempts. */
function blueprintRoot(target: string): string {
  const root = mkdtempSync(join(tmpdir(), "intake-resilience-"));
  roots.push(root);
  mkdirSync(join(root, "rules"));
  writeFileSync(join(root, "sample-intake.yml"), INTAKE);
  writeFileSync(join(root, "sample-lifecycle.yml"), LIFECYCLE);
  writeFileSync(join(root, "rules", "sample.yml"), rules(target));
  commitFixture(root);
  return root;
}

function bind(
  store: RunStore,
  root: string,
  clients = fixture().clients,
  bindings: readonly { owner: string; number: number }[] = [
    { owner: "sample-owner", number: 1 },
  ],
) {
  const catalog = new BlueprintCatalog(root);
  return new GitHubBindingService(
    store,
    bindings,
    clients,
    () => catalog.list("HEAD"),
    {
      pinCommit: (revision) => catalog.pin(revision),
      resolveBlueprint: (commit, id) => catalog.resolve(commit, id),
      nodes: serviceNodes(catalog.policyNode, () =>
        Promise.reject(new Error("No pass service")),
      ),
    },
    { intake: { blueprintId: "sample-intake", revision: "HEAD" } },
  );
}

function intakeRuns(store: RunStore) {
  return store
    .list()
    .filter((run) => run.blueprintId === "sample-intake")
    .map((run) => [run.id, run.status]);
}

it("reports whether a policy rule matched instead of failing the run", async () => {
  const root = blueprintRoot("sample-lifecycle");
  const catalog = new BlueprintCatalog(root);
  const commit = await catalog.pin("HEAD");
  const run = { commit } as Parameters<typeof catalog.policyNode>[0]["run"];
  const call = (type: string) =>
    catalog.policyNode({
      run,
      params: { rules: "rules/sample.yml", input: { type } },
    } as unknown as Parameters<typeof catalog.policyNode>[0]);

  await expect(call("Work item")).resolves.toEqual({
    matched: true,
    id: "matched",
    blueprint: "sample-lifecycle",
    inputs: {},
  });
  await expect(call("Something else")).resolves.toEqual({ matched: false });
});

it("keeps a failed intake attempt and starts a new one only when the revision moves", async () => {
  const root = blueprintRoot("missing-lifecycle");
  const github = fixture();
  const issue = github.issues[0];
  if (!issue) throw new Error("Fixture issue missing");
  issue.issueType = { name: "Work item" };
  const store = new RunStore(":memory:");
  stores.push(store);
  const service = bind(store, root, github.clients);

  await service.start();
  expect(intakeRuns(store)).toEqual([["intake:I_1", "failed"]]);
  const cause = store
    .events("intake:I_1")
    .filter((event) => event.type === "attention")
    .map((event) => (event.payload as { message: string }).message);
  expect(cause.join("\n")).toContain("missing-lifecycle");

  // An unchanged issue starts nothing, however often it is polled or delivered.
  await expect(service.poll()).resolves.toBe(0);
  await expect(
    service.deliver("issues", {
      issue: { node_id: "I_1", updated_at: issue.updatedAt },
    }),
  ).resolves.toBe(false);
  expect(intakeRuns(store)).toEqual([["intake:I_1", "failed"]]);

  // The revision moves to a fixed rules file.
  writeFileSync(join(root, "rules", "sample.yml"), rules("sample-lifecycle"));
  fixtureGit(root, "add", ".");
  fixtureGit(
    root,
    "-c",
    "user.name=Example",
    "-c",
    "user.email=example@example.invalid",
    "commit",
    "-qm",
    "Point the rule at a known lifecycle",
  );

  await service.poll();
  expect(intakeRuns(store)).toEqual([
    ["intake:I_1", "failed"],
    ["intake:I_1:2", "completed"],
  ]);
  expect(store.events("intake:I_1").length).toBeGreaterThan(0);
  const instance = service.instances.get("I_1");
  expect(store.get(instance.runId ?? "missing").blueprintId).toBe(
    "sample-lifecycle",
  );
});

it("survives a restart mid-hold without starting another attempt", async () => {
  const root = blueprintRoot("sample-lifecycle");
  const github = fixture();
  const issue = github.issues[0];
  if (!issue) throw new Error("Fixture issue missing");
  const state = mkdtempSync(join(tmpdir(), "intake-restart-"));
  roots.push(state);
  const path = join(state, "heddle.sqlite");

  const first = new RunStore(path);
  await bind(first, root, github.clients).start();
  expect(intakeRuns(first)).toEqual([["intake:I_1", "awaiting"]]);
  const held = first.awaiting("intake:I_1").map((item) => item.nodeId);
  first.close();

  const second = new RunStore(path);
  stores.push(second);
  const restarted = bind(second, root, github.clients);
  await restarted.start();
  expect(intakeRuns(second)).toEqual([["intake:I_1", "awaiting"]]);
  expect(second.awaiting("intake:I_1").map((item) => item.nodeId)).toEqual(
    held,
  );

  // The issue is fixed after the restart and the waiting run still owns it.
  issue.issueType = { name: "Work item" };
  issue.updatedAt = "2026-01-02T00:00:00Z";
  expect(await restarted.poll()).toBe(1);
  expect(intakeRuns(second)).toEqual([["intake:I_1", "completed"]]);
  const instance = restarted.instances.get("I_1");
  expect(second.get(instance.runId ?? "missing")).toMatchObject({
    blueprintId: "sample-lifecycle",
    initialContext: { issue: { id: "I_1", type: "Work item" } },
  });
});

it("isolates a poisoned instance from another issue's delivery, a poll, and start", async () => {
  const root = blueprintRoot("sample-lifecycle");
  const github = fixture();
  const first = github.issues[0];
  if (!first) throw new Error("Fixture issue missing");
  const second = recipe(2);
  second.issueType = { name: "Work item" };
  github.issues.push(second);
  const store = new RunStore(":memory:");
  stores.push(store);
  const service = bind(store, root, github.clients);
  await service.start();

  // Issue one holds; end its attempt and poison the next attempt id with a
  // different invocation, the shape that used to fail the whole service.
  expect(service.instances.get(first.id).runId).toBeNull();
  store.status("intake:I_1", "failed");
  await service.engine.start({
    id: "intake:I_1:2",
    blueprintId: "sample-lifecycle",
    commit: "HEAD",
    context: { unrelated: true },
  });
  store.db
    .prepare("UPDATE intake_attempts SET snapshot='{}' WHERE issue_id=?")
    .run(first.id);

  await expect(service.start()).resolves.toBeUndefined();
  await expect(service.poll()).resolves.toBeGreaterThanOrEqual(0);
  second.updatedAt = "2026-01-03T00:00:00Z";
  await expect(
    service.deliver("issues", {
      issue: { node_id: second.id, updated_at: second.updatedAt },
    }),
  ).resolves.toBe(true);

  expect(
    store.db
      .prepare("SELECT project,message FROM github_attention")
      .all()
      .map((row) => row["project"]),
  ).toContain(first.id);
  expect(service.instances.get(second.id).runId).not.toBeNull();
});

const reproDirectory = "/home/vscode/.heddle-dev/uat-961/repro";
const repro = existsSync(join(reproDirectory, "heddle.sqlite")) ? it : it.skip;

repro(
  "starts against the recorded database and gives issue 34 a new attempt",
  async () => {
    const root = blueprintRoot("sample-lifecycle");
    const state = mkdtempSync(join(tmpdir(), "intake-repro-"));
    roots.push(state);
    cpSync(join(reproDirectory, "heddle.sqlite"), join(state, "heddle.sqlite"));
    const store = new RunStore(join(state, "heddle.sqlite"));
    stores.push(store);
    // No bound project: the persisted instances are the whole input.
    const service = bind(store, root, fixture().clients, []);

    await expect(service.start()).resolves.toBeUndefined();

    const held = "I_kwDOUTck2M8AAAABSAo9rw";
    const attempt = service.instances.intakeAttempt(held);
    expect(attempt?.attempt).toBe(2);
    expect(attempt?.runId).toBe(`intake:${held}:2`);
    expect(store.get(`intake:${held}`).status).toBe("failed");
    expect(store.get(`intake:${held}:2`).status).toBe("awaiting");
  },
);
