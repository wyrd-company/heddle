// ---
// relationships:
//   verifies: github-binding-and-intake
// ---
import { afterEach, expect, it, vi } from "vitest";
import { RunStore } from "../src/engine/store.js";
import { GitHubBindingService } from "../src/binding/service.js";
import { InstanceStore } from "../src/binding/store.js";
import { githubEffect } from "../src/binding/effects.js";
import { liveRequirementFacts } from "../src/binding/validate.js";
import { deriveFlowcraftBlueprint } from "../src/blueprints/flowcraft.js";
import { fixture, recipe } from "./binding.fixture.js";

const stores: RunStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});
function setup() {
  const first = fixture();
  const second = fixture("P_2");
  second.issues.splice(0, 1, recipe(3));
  const store = new RunStore(":memory:");
  stores.push(store);
  const blueprint = {
    id: "cook",
    kind: "process" as const,
    nodes: {
      prepare: {
        uses: "github",
        stage: true,
        params: { operation: "comment", body: "Ready" },
      },
    },
  };
  const bindings = [
    { owner: "sample-owner", number: 1 },
    { owner: "other-owner", number: 1 },
  ];
  const clients = (owner: string) =>
    owner === "sample-owner" ? first.clients() : second.clients();
  const service = new GitHubBindingService(
    store,
    bindings,
    clients,
    () => Promise.resolve([blueprint]),
    {
      resolveBlueprint: () =>
        Promise.resolve(deriveFlowcraftBlueprint(blueprint)),
    },
  );
  return { first, second, store, service, bindings, clients };
}
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const body = (yaml: string) => `<!--\n---\n${yaml}\n---\n-->`;

it.each(["value: [broken", "- item", "scalar"])(
  "isolates invalid front matter %s and discovers later cards and projects",
  async (yaml) => {
    const f = setup();
    f.first.issues.splice(0, 1, { ...recipe(), body: body(yaml) }, recipe(2));
    await f.service.start();
    expect(f.service.instances.list().map((i) => i.id)).toEqual(["I_2", "I_3"]);
    const attention = f.store.db
      .prepare("SELECT project,message FROM github_attention")
      .all();
    expect(attention).toHaveLength(1);
    expect(attention[0]?.["project"]).toBe("P_1");
    expect(attention[0]?.["message"]).toContain("sample-owner/recipes#1");
    // A repaired issue can enter a later pass; other snapshots remain cached.
    f.first.issues[0] = recipe();
    await f.service.discover();
    expect(f.service.instances.get("I_1").issue.frontMatter).toEqual({
      servings: 4,
    });
  },
);

it.each(["value: [broken", "- item", "scalar"])(
  "names the offending issue in live validation for %s",
  async (yaml) => {
    const f = setup();
    f.second.issues[0] = { ...recipe(3), body: body(yaml) };
    await expect(liveRequirementFacts(f.clients, f.bindings)).rejects.toThrow(
      "Issue sample-owner/recipes#3:",
    );
  },
);

it("rejects organization iteration values before any read or write", async () => {
  const f = setup();
  await f.service.start();
  const run = await f.service.startInstance("I_1", "cook", "revision");
  const client = f.first.clients();
  const project = await client.owner("sample-owner").project(1).open();
  const calls = f.first.transport.calls.length;
  await expect(
    githubEffect(
      {
        run,
        nodeId: "change",
        visit: 1,
        effectKey: "invalid-iteration",
        params: {
          operation: "set-field",
          scope: "organization",
          field: "Origin",
          value: { title: "Summer" },
        },
        input: null,
        context: { issue: f.service.instances.get("I_1").issue },
        await: () => Promise.resolve(),
      },
      project,
      client,
      f.service.instances,
    ),
  ).rejects.toThrow("Organization field cannot use an iteration value");
  expect(f.first.transport.calls).toHaveLength(calls);
  expect(
    f.store.db
      .prepare("SELECT 1 FROM github_effects WHERE id=?")
      .get("invalid-iteration"),
  ).toBeUndefined();
});

it("dispatches stage and github nodes against the complete prior map during reconciliation", async () => {
  const f = setup();
  await f.service.start();
  const entered = signal();
  const released = signal();
  const original = f.second.transport.graphql.bind(f.second.transport);
  vi.spyOn(f.second.transport, "graphql").mockImplementation(async (op) => {
    if (op.name === "ProjectByNumber") {
      entered.resolve();
      await released.promise;
    }
    return original(op);
  });
  const reconciliation = f.service.reconcile();
  await entered.promise;
  try {
    for (const id of ["I_1", "I_3"]) {
      const run = await f.service.engine.start({
        id: `during:${id}`,
        blueprintId: "cook",
        commit: "revision",
        context: { issue: f.service.instances.get(id).issue },
      });
      expect(run.status).toBe("completed");
    }
    expect(f.first.values["C_1"]?.["Status"]).toBe("prepare");
    expect(f.second.values["C_3"]?.["Status"]).toBe("prepare");
    expect(f.first.comments).toHaveLength(1);
    expect(f.second.comments).toHaveLength(1);
  } finally {
    released.resolve();
    await reconciliation;
  }
});

it("withholds an incompatible project after publishing the replacement map", async () => {
  const f = setup();
  await f.service.start();
  f.first.fields[0] = {
    __typename: "ProjectV2Field",
    id: "F_status",
    name: "Status",
    dataType: "TEXT",
    isIssueField: false,
    issueField: null,
  };
  await f.service.reconcile();
  await expect(
    f.service.startInstance("I_1", "cook", "revision"),
  ).rejects.toThrow("Project reconciliation requires attention");
  expect(
    (await f.service.startInstance("I_3", "cook", "revision")).status,
  ).toBe("completed");
});

it("looks up each discovered card by id without listing all snapshots", async () => {
  const f = setup();
  for (let n = 4; n < 14; n++) f.first.issues.push(recipe(n));
  await f.service.start();
  const loads = f.first.transport.callsTo("IssueLoad").length;
  const list = vi.spyOn(f.service.instances, "list");
  const find = vi.spyOn(f.service.instances, "find");
  await f.service.discover();
  expect(list).not.toHaveBeenCalled();
  expect(find.mock.calls.map(([id]) => id)).toEqual([
    "I_1",
    ...Array.from({ length: 10 }, (_, i) => `I_${String(i + 4)}`),
    "I_3",
  ]);
  expect(f.first.transport.callsTo("IssueLoad")).toHaveLength(loads);
});

it("deduplicates repeated ambiguity and schema attention while preserving distinct issues", async () => {
  const f = setup();
  f.first.issues.push(recipe(2));
  f.second.issues.splice(0, 1, recipe(), recipe(2));
  await f.service.start();
  for (let n = 0; n < 3; n++) await f.service.discover();
  const rows = () =>
    f.store.db.prepare("SELECT project,message FROM github_attention").all();
  expect(rows()).toHaveLength(2);
  expect(rows().map((r) => r["message"])).toEqual([
    expect.stringContaining("recipes#1"),
    expect.stringContaining("recipes#2"),
  ]);
  f.first.fields[0] = {
    __typename: "ProjectV2Field",
    id: "F_status",
    name: "Status",
    dataType: "TEXT",
    isIssueField: false,
    issueField: null,
  };
  await f.service.reconcile();
  const initial = rows();
  expect(initial.length).toBeGreaterThan(2);
  for (let n = 0; n < 3; n++) await f.service.reconcile();
  expect(rows()).toEqual(initial);
});

it("deduplicates existing attention rows on store reopen and retains distinct keys", () => {
  const f = setup();
  f.store.db.exec("DROP INDEX github_attention_identity");
  const insert = f.store.db.prepare(
    "INSERT INTO github_attention(project,message) VALUES (?,?)",
  );
  insert.run("P_1", "first");
  insert.run("P_1", "first");
  insert.run("P_1", "second");
  insert.run("P_2", "first");
  const reopened = new InstanceStore(f.store.db);
  reopened.attention("P_1", "first");
  expect(
    f.store.db
      .prepare("SELECT project,message FROM github_attention ORDER BY id")
      .all(),
  ).toEqual([
    { project: "P_1", message: "first" },
    { project: "P_1", message: "second" },
    { project: "P_2", message: "first" },
  ]);
});

it("propagates storage failures instead of classifying them as invalid front matter", async () => {
  const f = setup();
  f.store.db.exec(`CREATE TRIGGER refuse_instance BEFORE INSERT ON instances
    BEGIN SELECT RAISE(FAIL, 'Storage rejected instance'); END;`);
  await expect(f.service.start()).rejects.toThrow("Storage rejected instance");
  expect(f.store.db.prepare("SELECT * FROM github_attention").all()).toEqual(
    [],
  );
});
