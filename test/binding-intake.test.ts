// ---
// relationships:
//   verifies: github-binding-and-intake
// ---
import { afterEach, expect, it } from "vitest";
import { deriveFlowcraftBlueprint } from "../src/blueprints/flowcraft.js";
import type { Blueprint } from "../src/blueprints/types.js";
import type { ClientFactory, ProjectBinding } from "../src/binding/config.js";
import { GitHubBindingService } from "../src/binding/service.js";
import { RunStore } from "../src/engine/store.js";
import { fixture } from "./binding.fixture.js";

const stores: RunStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const intake: Blueprint = {
  id: "default-intake",
  kind: "helper",
  nodes: {
    select: {
      uses: "lifecycle-start",
      params: { blueprint: "record-lifecycle" },
    },
  },
  edges: [],
};
const lifecycle: Blueprint = {
  id: "record-lifecycle",
  kind: "process",
  nodes: { work: { uses: "wait", stage: true } },
  edges: [],
};

function service(
  store: RunStore,
  bindings: readonly ProjectBinding[] = [{ owner: "sample-owner", number: 1 }],
  clients: ClientFactory = fixture().clients,
) {
  return new GitHubBindingService(
    store,
    bindings,
    clients,
    () => Promise.resolve([intake, lifecycle]),
    {
      resolveBlueprint: (_commit, id) => {
        const blueprint = [intake, lifecycle].find((item) => item.id === id);
        if (!blueprint) throw new Error(`Unknown blueprint: ${id}`);
        return Promise.resolve(deriveFlowcraftBlueprint(blueprint));
      },
    },
  );
}

it("attaches the selected lifecycle root instead of the intake root", async () => {
  const github = fixture();
  const store = new RunStore(":memory:");
  stores.push(store);
  const binding = service(store, undefined, github.clients);
  await binding.start();
  const selected = await binding.startIntake("I_1", intake.id, "revision");
  expect(selected).toMatchObject({
    blueprintId: lifecycle.id,
    status: "awaiting",
    initialContext: { issue: { id: "I_1" } },
  });
  const instance = binding.instances.get("I_1");
  expect(instance.runId).toBe('["intake:I_1","select",1]');
  expect(instance.runId).not.toBe("intake:I_1");
  expect(store.lifecycleOrigin(instance.runId ?? "missing")).toEqual({
    runId: "intake:I_1",
    nodeId: "select",
    visit: 1,
  });
  const restarted = service(store, undefined, github.clients);
  await restarted.start();
  expect(restarted.instances.get("I_1").runId).toBe(instance.runId);
  expect(store.lifecycleStarts("intake:I_1")).toHaveLength(1);
});

it("repairs an interrupted create/attach boundary from persisted identity", async () => {
  const github = fixture();
  const store = new RunStore(":memory:");
  stores.push(store);
  const first = service(store, undefined, github.clients);
  await first.start();
  store.db
    .exec(`CREATE TRIGGER interrupt_attachment BEFORE UPDATE OF run_id ON instances
    WHEN NEW.run_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'attachment interrupted'); END`);
  await expect(first.startIntake("I_1", intake.id, "revision")).rejects.toThrow(
    "attachment interrupted",
  );
  const starts = store.lifecycleStarts("intake:I_1");
  expect(starts).toHaveLength(1);
  const lifecycleId = starts[0]?.lifecycleRunId ?? "missing";
  const persisted = store.get(lifecycleId);
  const calls = github.transport.callsTo("IssueLoad").length;
  store.db.exec("DROP TRIGGER interrupt_attachment");

  const restarted = service(store, undefined, github.clients);
  await restarted.start();
  expect(restarted.instances.get("I_1").runId).toBe(lifecycleId);
  expect(store.get(lifecycleId)).toEqual(persisted);
  expect(github.transport.callsTo("IssueLoad")).toHaveLength(calls);
  expect(await restarted.startIntake("I_1", intake.id, "revision")).toEqual(
    persisted,
  );
  expect(store.lifecycleStarts("intake:I_1")).toHaveLength(1);
});

it("refuses attachment when persisted lifecycle identity disagrees", async () => {
  const github = fixture();
  const store = new RunStore(":memory:");
  stores.push(store);
  const first = service(store, undefined, github.clients);
  await first.start();
  store.db
    .exec(`CREATE TRIGGER interrupt_attachment BEFORE UPDATE OF run_id ON instances
    WHEN NEW.run_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'attachment interrupted'); END`);
  await expect(first.startIntake("I_1", intake.id, "revision")).rejects.toThrow(
    "attachment interrupted",
  );
  store.db.exec("DROP TRIGGER interrupt_attachment");
  const lifecycleId =
    store.lifecycleStarts("intake:I_1")[0]?.lifecycleRunId ?? "missing";
  const context = store.get(lifecycleId).initialContext;
  const altered = structuredClone(context) as {
    issue: { id: string };
  };
  altered.issue.id = "I_other";
  store.db
    .prepare("UPDATE runs SET initial_context=? WHERE id=?")
    .run(JSON.stringify(altered), lifecycleId);
  const restarted = service(store, undefined, github.clients);
  await expect(restarted.start()).resolves.toBeUndefined();
  expect(restarted.instances.get("I_1").runId).toBeNull();
  expect(
    store.db.prepare("SELECT project,message FROM github_attention").all(),
  ).toContainEqual({
    project: "I_1",
    message: "Lifecycle attachment issue identity does not agree",
  });
});

it("asks one durable project question and projects the selected answer", async () => {
  const firstGitHub = fixture();
  const secondGitHub = fixture("P_2");
  const store = new RunStore(":memory:");
  stores.push(store);
  const bindings = [
    { owner: "sample-owner", number: 1 },
    { owner: "other-owner", number: 1 },
  ] as const;
  const clients: ClientFactory = (owner) =>
    owner === "sample-owner" ? firstGitHub.clients() : secondGitHub.clients();
  const binding = service(store, bindings, clients);
  await binding.start();
  const question = await binding.startIntake("I_1", intake.id, "revision");
  expect(question).toMatchObject({
    id: "project-choice:I_1",
    answer: null,
    options: [{ projectId: "P_1" }, { projectId: "P_2" }],
  });
  expect(store.list()).toEqual([]);

  await binding.answerProjectChoice("I_1", "project-choice:I_1", "P_2");
  await binding.answerProjectChoice("I_1", "project-choice:I_1", "P_2");
  expect(secondGitHub.values["C_1"]?.["Heddle Project"]).toBe("other-owner/1");
  const restarted = service(store, bindings, clients);
  await restarted.start();
  expect(restarted.instances.projectChoice("I_1")).toMatchObject({
    id: "project-choice:I_1",
    answer: "P_2",
  });
  const selected = await restarted.startIntake("I_1", intake.id, "revision");
  expect(selected).toMatchObject({ blueprintId: lifecycle.id });
  expect(secondGitHub.values["C_1"]?.["Status"]).toBe("work");
  expect(firstGitHub.values["C_1"]?.["Status"]).toBeUndefined();
  expect(restarted.instances.projectChoice("I_1")).toMatchObject({
    id: "project-choice:I_1",
    answer: "P_2",
  });
  expect(
    store.db.prepare("SELECT * FROM project_choice_questions").all(),
  ).toHaveLength(1);
});

it("continues a permission attention without retrying the refused effect", async () => {
  const github = fixture();
  github.refuse();
  const store = new RunStore(":memory:");
  stores.push(store);
  const blueprint: Blueprint = {
    id: "permission-record",
    kind: "process",
    nodes: {
      change: {
        uses: "github",
        params: {
          operation: "set-field",
          scope: "organization",
          field: "Origin",
          value: "Updated",
        },
      },
    },
    edges: [],
  };
  const binding = new GitHubBindingService(
    store,
    [{ owner: "sample-owner", number: 1 }],
    github.clients,
    () => Promise.resolve([blueprint]),
    {
      resolveBlueprint: () =>
        Promise.resolve(deriveFlowcraftBlueprint(blueprint)),
    },
  );
  await binding.start();
  const run = await binding.startInstance("I_1", blueprint.id, "revision");
  expect(run.status).toBe("awaiting");
  expect(github.transport.callsTo("SetIssueFieldValue")).toHaveLength(1);
  expect(await binding.resolvePermissionAttention(run.id, "change", 1)).toBe(
    "applied",
  );
  expect(store.get(run.id).status).toBe("completed");
  expect(github.transport.callsTo("SetIssueFieldValue")).toHaveLength(1);
  expect(await binding.resolvePermissionAttention(run.id, "change", 1)).toBe(
    "late-wakeup",
  );
});

it("binds each permission continuation to its refusal occurrence", async () => {
  const github = fixture();
  github.refuse();
  const store = new RunStore(":memory:");
  stores.push(store);
  const blueprint: Blueprint = {
    id: "permission-cycle",
    kind: "process",
    entry: "change",
    nodes: {
      change: {
        uses: "github",
        params: {
          operation: "set-field",
          scope: "organization",
          field: "Origin",
          value: "Updated",
        },
      },
    },
    edges: [{ from: "change", to: "change" }],
  };
  const binding = new GitHubBindingService(
    store,
    [{ owner: "sample-owner", number: 1 }],
    github.clients,
    () => Promise.resolve([blueprint]),
    {
      resolveBlueprint: () =>
        Promise.resolve(deriveFlowcraftBlueprint(blueprint)),
    },
  );
  await binding.start();
  const run = await binding.startInstance("I_1", blueprint.id, "revision");
  expect(store.awaiting(run.id)[0]?.visit).toBe(1);
  await binding.resolvePermissionAttention(run.id, "change", 1);
  expect(store.awaiting(run.id)[0]?.visit).toBe(2);
  await binding.engine.recover(run.rootId);
  expect(await binding.resolvePermissionAttention(run.id, "change", 1)).toBe(
    "late-wakeup",
  );
  expect(store.awaiting(run.id)[0]?.visit).toBe(2);
  expect(await binding.resolvePermissionAttention(run.id, "change", 2)).toBe(
    "applied",
  );
  expect(store.awaiting(run.id)[0]?.visit).toBe(3);
});
