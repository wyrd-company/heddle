// ---
// relationships:
//   verifies: github-binding-and-intake
// ---
import { createHmac } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { deriveFlowcraftBlueprint } from "../src/blueprints/flowcraft.js";
import { lintHeddle } from "../src/blueprints/heddle-lint.js";
import type { Blueprint } from "../src/blueprints/types.js";
import { GitHubBindingService } from "../src/binding/service.js";
import { RunStore } from "../src/engine/store.js";
import type { EngineNode } from "../src/engine/types.js";
import { fixture, type BindingRelation } from "./binding.fixture.js";

const stores: RunStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function binding(
  blueprint: Blueprint,
  github: ReturnType<typeof fixture>,
  store: RunStore,
  nodes = {},
) {
  return new GitHubBindingService(
    store,
    [{ owner: "sample-owner", number: 1 }],
    github.clients,
    () => Promise.resolve([blueprint]),
    {
      resolveBlueprint: (_commit, id) => {
        if (id !== blueprint.id) throw new Error(`Unknown blueprint: ${id}`);
        return Promise.resolve(deriveFlowcraftBlueprint(blueprint));
      },
      nodes,
    },
  );
}

function setup(blueprint: Blueprint, nodes = {}) {
  const github = fixture();
  const store = new RunStore(":memory:");
  stores.push(store);
  const service = binding(blueprint, github, store, nodes);
  return { github, store, service };
}

const waitBlueprint = (
  bindings: Record<string, string> = { expectedType: "expectedType" },
): Blueprint => ({
  id: "wait-for-record",
  kind: "helper",
  inputs: { expectedType: { type: "string" } },
  nodes: {
    wait: {
      uses: "on-issue-change",
      params: { when: "type = $expectedType", bindings },
    },
  },
  edges: [],
});

it("applies one signed webhook/poll change and keeps run inputs immutable", async () => {
  const f = setup(waitBlueprint());
  await f.service.start();
  const original = structuredClone(f.service.instances.get("I_1").issue);
  const waiting = await f.service.engine.start({
    id: "waiting",
    blueprintId: "wait-for-record",
    commit: "revision",
    context: { issue: original, expectedType: "Collection request" },
  });
  expect(waiting.status).toBe("awaiting");

  const changedAt = "2026-01-02T00:00:00Z";
  const issue = f.github.issues[0];
  if (!issue) throw new Error("fixture issue missing");
  issue.updatedAt = changedAt;
  issue.issueType = { name: "Collection request" };
  const body = Buffer.from(
    JSON.stringify({ issue: { node_id: "I_1", updated_at: changedAt } }),
  );
  const secret = "test-webhook-secret";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  expect(
    await f.service.events.webhook("issues", signature, body, secret),
  ).toBe(true);
  expect(f.store.get("waiting")).toMatchObject({
    status: "completed",
    initialContext: { issue: original, expectedType: "Collection request" },
  });
  expect(f.service.instances.get("I_1").issue.type).toBe("Collection request");

  const restarted = binding(waitBlueprint(), f.github, f.store);
  await restarted.start();
  expect(await restarted.poll()).toBe(0);
  expect(
    await restarted.deliver("issues", {
      issue: { node_id: "I_1", updated_at: changedAt },
    }),
  ).toBe(false);
  expect(
    f.store.events("waiting").filter((event) => event.type === "resume"),
  ).toHaveLength(1);
});

it("refreshes an issue when a linked pull request changes", async () => {
  const f = setup(waitBlueprint());
  const issue = f.github.issues[0];
  if (!issue) throw new Error("Fixture issue missing");
  (issue.closedByPullRequestsReferences.nodes as BindingRelation[]).push({
    id: "PR_7",
    number: 7,
    repository: { name: "changes", owner: { login: "sample-owner" } },
  });
  await f.service.start();
  const waiting = await f.service.engine.start({
    id: "pull-wait",
    blueprintId: "wait-for-record",
    commit: "revision",
    context: {
      issue: f.service.instances.get("I_1").issue,
      expectedType: "Work item",
    },
  });
  issue.title = "Updated garden soup";
  issue.issueType = { name: "Work item" };
  issue.updatedAt = "2026-01-05T00:00:00Z";

  expect(
    await f.service.deliver("pull_request", {
      repository: { full_name: "sample-owner/changes" },
      pull_request: {
        node_id: "PR_7",
        number: 7,
        updated_at: issue.updatedAt,
      },
    }),
  ).toBe(true);
  expect(f.store.get(waiting.id)).toMatchObject({ status: "completed" });
  expect(f.service.instances.get("I_1").issue.title).toBe(
    "Updated garden soup",
  );
});

it("refuses an invalid webhook signature before loading GitHub", async () => {
  const f = setup(waitBlueprint());
  await f.service.start();
  const calls = f.github.transport.calls.length;
  await expect(
    f.service.events.webhook(
      "issues",
      "sha256=wrong",
      Buffer.from("{}"),
      "test-webhook-secret",
    ),
  ).rejects.toThrow("signature is invalid");
  expect(f.github.transport.calls).toHaveLength(calls);
});

it("retains distinct card changes that share an issue update time", async () => {
  const f = setup(waitBlueprint());
  await f.service.start();
  const issue = f.github.issues[0];
  if (!issue) throw new Error("Fixture issue missing");
  const updatedAt = issue.updatedAt;
  f.github.values["C_1"] = { Paused: "Yes" };
  expect(
    await f.service.deliver("projects_v2_item", {
      projects_v2_item: {
        content_node_id: issue.id,
        updated_at: updatedAt,
      },
    }),
  ).toBe(true);
  f.github.values["C_1"] = { Paused: "Yes", Status: "Backlog" };
  expect(
    await f.service.deliver("projects_v2_item", {
      projects_v2_item: {
        content_node_id: issue.id,
        updated_at: updatedAt,
      },
    }),
  ).toBe(true);
  expect(
    f.store.db
      .prepare("SELECT * FROM issue_deliveries WHERE issue_id=?")
      .all(issue.id),
  ).toHaveLength(2);
});

it("rejects an unknown immutable binding before awaiting", async () => {
  const blueprint = waitBlueprint({ expectedType: "missing" });
  expect(lintHeddle("wait.yml", blueprint, {})).toContainEqual(
    expect.objectContaining({
      node: "wait",
      rule: "heddle.context-key",
      message: "Bound value expectedType cannot be provided: missing",
    }),
  );
  const f = setup(blueprint);
  await f.service.start();
  const issue = f.service.instances.get("I_1").issue;
  const run = await f.service.engine.start({
    id: "invalid-binding",
    blueprintId: "wait-for-record",
    commit: "revision",
    context: { issue, expectedType: "Collection request" },
  });
  expect(run.status).toBe("failed");
  expect(f.store.awaiting(run.id)).toEqual([]);
  expect(f.store.events(run.id)).toContainEqual(
    expect.objectContaining({
      type: "failure",
    }),
  );
});

it("captures issue-change bindings from immutable run inputs", async () => {
  const blueprint: Blueprint = {
    ...waitBlueprint(),
    nodes: {
      mutate: { uses: "mutate" },
      ...waitBlueprint().nodes,
    },
    edges: [{ from: "mutate", to: "wait" }],
  };
  const mutate: EngineNode = (context) => {
    context.context["expectedType"] = "Changed after the run started";
    return Promise.resolve(null);
  };
  const f = setup(blueprint, { mutate });
  await f.service.start();
  const run = await f.service.engine.start({
    id: "immutable-binding",
    blueprintId: blueprint.id,
    commit: "revision",
    context: {
      issue: f.service.instances.get("I_1").issue,
      expectedType: "Collection request",
    },
  });
  const issue = f.github.issues[0];
  if (!issue) throw new Error("Fixture issue missing");
  issue.issueType = { name: "Collection request" };
  issue.updatedAt = "2026-01-06T00:00:00Z";
  await f.service.deliver("issues", {
    issue: { node_id: issue.id, updated_at: issue.updatedAt },
  });
  expect(f.store.get(run.id)).toMatchObject({ status: "completed" });
});

it("projects operator pause and applies manual Paused changes through one operation", async () => {
  const blueprint: Blueprint = {
    id: "paused-record",
    kind: "process",
    nodes: { work: { uses: "wait" } },
    edges: [],
  };
  const f = setup(blueprint);
  await f.service.start();
  const run = await f.service.startInstance("I_1", blueprint.id, "revision");
  expect(run.status).toBe("awaiting");

  await f.service.pauseInstance("I_1");
  expect(f.store.get(run.id).paused).toBe(true);
  expect(f.github.values["C_1"]?.["Paused"]).toBe("Yes");

  f.github.values["C_1"] ??= {};
  f.github.values["C_1"]["Paused"] = "No";
  const issue = f.github.issues[0];
  if (!issue) throw new Error("fixture issue missing");
  issue.updatedAt = "2026-01-03T00:00:00Z";
  await f.service.deliver("projects_v2_item", {
    projects_v2_item: {
      content_node_id: "I_1",
      updated_at: issue.updatedAt,
    },
  });
  expect(f.store.get(run.id).paused).toBe(false);
  expect(f.store.get(run.id).status).toBe("awaiting");

  await f.service.resumeInstance("I_1");
  expect(f.github.values["C_1"]["Paused"]).toBe("No");
  expect(
    await f.service.deliver("projects_v2_item", {
      projects_v2_item: {
        content_node_id: "I_1",
        updated_at: issue.updatedAt,
      },
    }),
  ).toBe(false);
  expect(
    f.store.events(run.id).filter((event) => event.type === "instance-resumed"),
  ).toHaveLength(1);
});

it("turns a manual Status move into the paused pass overridden result", async () => {
  const blueprint: Blueprint = {
    id: "status-record",
    kind: "process",
    nodes: { assess: { uses: "pass", stage: true, params: {} } },
    edges: [],
  };
  const f = setup(blueprint, {
    pass: async (context: {
      await(details: { kind: string }): Promise<void>;
    }) => context.await({ kind: "pass" }),
  });
  await f.service.start();
  const run = await f.service.startInstance("I_1", blueprint.id, "revision");
  expect(run.status).toBe("awaiting");
  expect(f.github.values["C_1"]?.["Status"]).toBe("assess");

  f.github.values["C_1"] ??= {};
  f.github.values["C_1"]["Status"] = "Deferred";
  const issue = f.github.issues[0];
  if (!issue) throw new Error("fixture issue missing");
  issue.updatedAt = "2026-01-04T00:00:00Z";
  await f.service.deliver("projects_v2_item", {
    projects_v2_item: {
      content_node_id: "I_1",
      updated_at: issue.updatedAt,
    },
  });
  expect(f.store.get(run.id).status).toBe("completed");
  expect(f.store.get(run.id).context["assess"]).toMatchObject({
    overridden: true,
    payload: { status: "Deferred" },
  });
});
