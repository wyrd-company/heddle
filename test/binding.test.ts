// ---
// relationships:
//   verifies: github-binding-and-intake
// ---
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../src/engine/store.js";
import { GitHubBindingService } from "../src/binding/service.js";
import { deriveFlowcraftBlueprint } from "../src/blueprints/flowcraft.js";
import type { Blueprint } from "../src/blueprints/types.js";
import { lintHeddle } from "../src/blueprints/heddle-lint.js";
import { frontMatter } from "../src/binding/snapshot.js";
import { githubEffect } from "../src/binding/effects.js";
import {
  liveRequirementFacts,
  requirementFindings,
} from "../src/binding/validate.js";
import { fixture, recipe } from "./binding.fixture.js";
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
const dirs: string[] = [];
const stores: RunStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function setup(
  blueprints: Blueprint[] = [
    {
      id: "cook",
      kind: "process",
      nodes: { prepare: { uses: "wait", stage: true } },
    },
  ],
) {
  const wire = fixture();
  const dir = mkdtempSync(join(tmpdir(), "binding-"));
  dirs.push(dir);
  const path = join(dir, "state.db");
  const store = new RunStore(path);
  stores.push(store);
  const service = new GitHubBindingService(
    store,
    [{ owner: "sample-owner", number: 1 }],
    wire.clients,
    () => Promise.resolve(blueprints),
    {
      resolveBlueprint: (_commit, id) => {
        const found = blueprints.find((b) => b.id === id);
        if (!found) throw new Error("Missing fixture blueprint");
        return Promise.resolve(deriveFlowcraftBlueprint(found));
      },
    },
  );
  return { ...wire, path, store, service, blueprints };
}
it("reconciles the union append-only, discovers new issues, caches snapshots and preserves initial context across restart", async () => {
  const f = setup();
  f.blueprints.push({
    id: "bake",
    kind: "process",
    nodes: { bake: { uses: "wait", stage: true } },
  });
  await f.service.start();
  expect(
    (
      present(f.fields.at(0))["options"] as {
        name: string;
      }[]
    ).map((o) => o.name),
  ).toEqual(["Backlog", "prepare", "bake"]);
  expect(f.fields.some((x) => x["name"] === "Paused")).toBe(true);
  const writes = f.transport.callsTo("UpdateProjectField").length;
  await f.service.start();
  expect(f.transport.callsTo("UpdateProjectField")).toHaveLength(writes);
  f.blueprints.pop();
  await f.service.reconcile();
  expect(
    (
      present(f.fields.at(0))["options"] as {
        name: string;
      }[]
    ).map((o) => o.name),
  ).toContain("bake");
  const snapshot = f.service.instances.get("I_1").issue;
  expect(snapshot).toMatchObject({
    id: "I_1",
    ref: "sample-owner/recipes#1",
    repository: "sample-owner/recipes",
    number: 1,
    url: "https://example.invalid/recipe",
    title: "Garden soup",
    body: snapshot.body,
    type: "Recipe",
    labels: [],
    assignees: ["sample-user"],
    milestone: null,
    state: "open",
    fields: { Origin: "Garden" },
    project: {
      id: "P_1",
      owner: "sample-owner",
      number: 1,
      itemId: "C_1",
      fields: {},
    },
    parent: null,
    subIssues: [],
    blockedBy: [],
    blocking: [],
    duplicateOf: null,
    closedBy: [],
    frontMatter: { servings: 4 },
  });
  present(f.issues.at(0)).body = "Changed outside the service";
  const run = await f.service.startInstance("I_1", "cook", "revision");
  expect(run.initialContext["issue"]).toEqual(snapshot);
  expect(run.status).toBe("awaiting");
  expect(f.values["C_1"]?.["Status"]).toBe("prepare");
  expect((await f.service.startInstance("I_1", "cook", "revision")).id).toBe(
    run.id,
  );
  const loads = f.transport.callsTo("IssueLoad").length;
  await f.service.discover();
  expect(f.transport.callsTo("IssueLoad")).toHaveLength(loads);
  f.issues.push(recipe(2));
  await f.service.discover();
  expect(f.service.instances.list()).toHaveLength(2);
  f.store.close();
  stores.splice(stores.indexOf(f.store), 1);
  const store = new RunStore(f.path);
  stores.push(store);
  expect(store.get(run.id).initialContext["issue"]).toEqual(snapshot);
});
it.each([
  { operation: "set-field", field: "Notes", value: "Chopped" },
  { operation: "comment", body: "Ready" },
  { operation: "add-labels", labels: ["vegetarian"] },
])("replays $operation once and preserves later user edits", async (params) => {
  const f = setup();
  await f.service.start();
  const run = await f.service.startInstance("I_1", "cook", "revision");
  const context = {
    run,
    nodeId: "effect",
    visit: 1,
    effectKey: "effect-1",
    params,
    input: null,
    context: { issue: f.service.instances.get("I_1").issue },
    await: () => Promise.resolve(),
  };
  const client = f.clients();
  const project = await client.owner("sample-owner").project(1).open();
  await githubEffect(context, project, client, f.service.instances);
  const calls = f.transport.calls.length;
  (f.values["C_1"] ??= {})["Notes"] = "Later user change";
  await githubEffect(context, project, client, f.service.instances);
  expect(f.transport.calls).toHaveLength(calls);
  expect((f.values["C_1"] ??= {})["Notes"]).toBe("Later user change");
  if (params.operation === "comment") expect(f.comments).toHaveLength(1);
  if (params.operation === "add-labels")
    expect(present(f.issues.at(0)).labels.nodes.map((l) => l.name)).toEqual([
      "vegetarian",
    ]);
  await expect(
    githubEffect(
      { ...context, params: { ...params, extra: true } },
      project,
      client,
      f.service.instances,
    ),
  ).rejects.toThrow("identity reused");
});
it("raises permission attention and holds dispatch without failing the run", async () => {
  const f = setup([
    {
      id: "cook",
      kind: "process",
      nodes: {
        change: {
          uses: "github",
          params: {
            operation: "set-field",
            scope: "organization",
            field: "Origin",
            value: "Market",
          },
        },
      },
    },
  ]);
  await f.service.start();
  f.refuse();
  const run = await f.service.startInstance("I_1", "cook", "revision");
  expect(run.status).toBe("awaiting");
  expect(f.store.awaiting(run.id)[0]?.details.kind).toBe("github-attention");
  expect(
    f.store.events(run.id).find((e) => e.type === "attention")?.payload,
  ).toMatchObject({ refusal: "Organization field write refused" });
  expect(f.store.events(run.id).some((e) => e.type === "failure")).toBe(false);
  await f.service.engine.recover();
  expect(f.transport.callsTo("SetIssueFieldValue")).toHaveLength(1);
});
it("checks live requirements from the wire and refuses missing names", async () => {
  const f = setup();
  await f.service.start();
  const facts = await liveRequirementFacts(f.clients, [
    { owner: "sample-owner", number: 1 },
  ]);
  expect(
    requirementFindings(
      "cook.yml",
      {
        ...present(f.blueprints[0]),
        requires: {
          issue: {
            fields: ["Origin", "Notes"],
            type: ["Recipe"],
            labels: ["vegetarian"],
            frontMatter: ["servings"],
          },
        },
      },
      facts,
    ),
  ).toEqual([]);
  expect(
    requirementFindings(
      "cook.yml",
      {
        ...present(f.blueprints[0]),
        requires: {
          issue: {
            fields: ["Missing"],
            type: ["Missing"],
            labels: ["Missing"],
            frontMatter: ["Missing"],
          },
        },
      },
      facts,
    ).map((x) => x.message),
  ).toHaveLength(4);
});
it("parses only top comment front matter and rejects non-mappings", () => {
  expect(frontMatter("Text\n<!--\n---\nx: 1\n---\n-->")).toEqual({});
  expect(() => frontMatter("<!--\n---\n- value\n---\n-->")).toThrow("mapping");
});

it.each(["Status", "Paused"])(
  "keeps %s writes out of the github brick",
  async (field) => {
    const f = setup();
    await f.service.start();
    const run = await f.service.startInstance("I_1", "cook", "revision");
    const client = f.clients();
    const project = await client.owner("sample-owner").project(1).open();
    await expect(
      githubEffect(
        {
          run,
          nodeId: "effect",
          visit: 1,
          effectKey: "owned-field",
          params: { operation: "set-field", field, value: "Other" },
          input: null,
          context: { issue: f.service.instances.get("I_1").issue },
          await: () => Promise.resolve(),
        },
        project,
        client,
        f.service.instances,
      ),
    ).rejects.toThrow("owned by the service");
  },
);
it("recovers a comment accepted before the local effect commit without duplication", async () => {
  const f = setup();
  await f.service.start();
  const run = await f.service.startInstance("I_1", "cook", "revision");
  const client = f.clients();
  const project = await client.owner("sample-owner").project(1).open();
  const context = {
    run,
    nodeId: "effect",
    visit: 1,
    effectKey: "comment-crash",
    params: { operation: "comment", body: "Ready" },
    input: null,
    context: { issue: f.service.instances.get("I_1").issue },
    await: () => Promise.resolve(),
  };
  await githubEffect(context, project, client, f.service.instances);
  f.store.db
    .prepare("DELETE FROM github_effects WHERE id=?")
    .run(context.effectKey);
  await githubEffect(context, project, client, f.service.instances);
  expect(f.comments).toHaveLength(1);
  expect(f.transport.callsTo("AddComment")).toHaveLength(1);
});
it("restores a completed effect snapshot on checkpoint replay", async () => {
  const f = setup();
  await f.service.start();
  const run = await f.service.startInstance("I_1", "cook", "revision");
  const client = f.clients();
  const project = await client.owner("sample-owner").project(1).open();
  const old = f.service.instances.get("I_1").issue;
  const context = {
    run,
    nodeId: "effect",
    visit: 1,
    effectKey: "snapshot-crash",
    params: { operation: "set-field", field: "Notes", value: "Ready" },
    input: null,
    context: { issue: structuredClone(old) },
    await: () => Promise.resolve(),
  };
  await githubEffect(context, project, client, f.service.instances);
  context.context.issue = old;
  await githubEffect(context, project, client, f.service.instances);
  expect(context.context.issue.project.fields["Notes"]).toBe("Ready");
});
it("requires one explicit project choice for an issue in multiple bound projects", async () => {
  const f = setup();
  await f.service.start();
  const issue = f.service.instances.get("I_1").issue;
  f.service.instances.membership({
    ...issue,
    project: { ...issue.project, id: "P_2", itemId: "C_2" },
  });
  await expect(
    f.service.startInstance("I_1", "cook", "revision"),
  ).rejects.toThrow("select its project");
  f.service.instances.chooseProject("I_1", "P_1");
  expect(
    (await f.service.startInstance("I_1", "cook", "revision")).status,
  ).toBe("awaiting");
});

it.each(["Status", "Paused"])(
  "rejects authored %s writes at validation",
  (field) => {
    expect(
      lintHeddle(
        "recipe.yml",
        {
          id: "recipe",
          kind: "process",
          nodes: {
            change: {
              uses: "github",
              params: { operation: "set-field", field, value: "Other" },
            },
          },
        },
        {},
      ).map((f) => f.rule),
    ).toContain("heddle.owned-field");
  },
);

it("holds a stage before its node implementation when Status projection is refused", async () => {
  const f = setup([
    {
      id: "cook",
      kind: "process",
      nodes: {
        prepare: {
          uses: "github",
          stage: true,
          params: { operation: "comment", body: "Ready" },
        },
      },
    },
  ]);
  await f.service.start();
  f.refuseStatus();
  const run = await f.service.startInstance("I_1", "cook", "revision");
  expect(run.status).toBe("awaiting");
  expect(f.store.awaiting(run.id)[0]?.details.kind).toBe("github-attention");
  expect(f.comments).toEqual([]);
});
it("raises attention and withholds a project with incompatible Status", async () => {
  const f = setup();
  f.fields[0] = {
    __typename: "ProjectV2Field",
    id: "F_status",
    name: "Status",
    dataType: "TEXT",
    isIssueField: false,
    issueField: null,
  };
  await f.service.start();
  expect(f.service.instances.list()).toEqual([]);
  expect(
    f.store.db
      .prepare("SELECT message FROM github_attention")
      .all()
      .map((r) => String(r["message"]))
      .join(" "),
  ).toContain("type-mismatch");
});

it("discovers only open issue cards", async () => {
  const f = setup();
  const closed = recipe(2);
  closed.state = "CLOSED";
  f.issues.push(closed, recipe(3));
  f.itemTypes[3] = "PULL_REQUEST";
  await f.service.start();
  expect(f.service.instances.list().map((i) => i.id)).toEqual(["I_1"]);
});
it.each([undefined, true, Number.NaN, ["valid", 1], { other: "value" }])(
  "rejects invalid field values without completing an effect",
  async (value) => {
    const f = setup();
    await f.service.start();
    const run = await f.service.startInstance("I_1", "cook", "revision");
    const client = f.clients();
    const project = await client.owner("sample-owner").project(1).open();
    await expect(
      githubEffect(
        {
          run,
          nodeId: "effect",
          visit: 1,
          effectKey: "invalid",
          params: { operation: "set-field", field: "Notes", value },
          input: null,
          context: { issue: f.service.instances.get("I_1").issue },
          await: () => Promise.resolve(),
        },
        project,
        client,
        f.service.instances,
      ),
    ).rejects.toThrow("supported field value");
    expect(f.store.db.prepare("SELECT * FROM github_effects").all()).toEqual(
      [],
    );
  },
);
it("keeps equal project numbers in different owners separate", async () => {
  const f = setup();
  const other = fixture("P_2");
  other.issues.splice(0, 1, recipe(2));
  const service = new GitHubBindingService(
    f.store,
    [
      { owner: "sample-owner", number: 1 },
      { owner: "other-owner", number: 1 },
    ],
    (owner) => (owner === "sample-owner" ? f.clients() : other.clients()),
    () => Promise.resolve(f.blueprints),
    {
      resolveBlueprint: () =>
        Promise.resolve(deriveFlowcraftBlueprint(present(f.blueprints[0]))),
    },
  );
  await service.start();
  expect(
    service.instances
      .list()
      .map((i) => [i.id, i.issue.project.id, i.issue.project.owner]),
  ).toEqual([
    ["I_1", "P_1", "sample-owner"],
    ["I_2", "P_2", "other-owner"],
  ]);
});

it("reads before a new field write even when the effect identity differs", async () => {
  const f = setup();
  await f.service.start();
  const run = await f.service.startInstance("I_1", "cook", "revision");
  const client = f.clients();
  const project = await client.owner("sample-owner").project(1).open();
  const context = {
    run,
    nodeId: "effect",
    visit: 1,
    effectKey: "first",
    params: { operation: "set-field", field: "Notes", value: "Ready" },
    input: null,
    context: { issue: f.service.instances.get("I_1").issue },
    await: () => Promise.resolve(),
  };
  await githubEffect(context, project, client, f.service.instances);
  const writes = f.transport.callsTo("UpdateItemFieldValue").length;
  await githubEffect(
    { ...context, effectKey: "second" },
    project,
    client,
    f.service.instances,
  );
  expect(f.transport.callsTo("UpdateItemFieldValue")).toHaveLength(writes);
});
