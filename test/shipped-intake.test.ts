// ---
// relationships:
//   verifies: github-binding-and-intake
// ---
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import jsonata from "jsonata";
import { parse } from "yaml";
import { afterEach, expect, it } from "vitest";
import { deriveFlowcraftBlueprint } from "../src/blueprints/flowcraft.js";
import { lintHeddle } from "../src/blueprints/heddle-lint.js";
import type { Blueprint, BlueprintNode } from "../src/blueprints/types.js";
import {
  loadValidatedBlueprint,
  validateBlueprintPath,
} from "../src/blueprints/validate.js";
import {
  PushoverDelivery,
  type NotificationDelivery,
} from "../src/binding/notify.js";
import { GitHubBindingService } from "../src/binding/service.js";
import { resolveValues } from "../src/engine/runtime.js";
import { RunStore } from "../src/engine/store.js";
import { fixture, recipe } from "./binding.fixture.js";

const directory = resolve("blueprints");
const stores: RunStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function shipped(id: string): Blueprint {
  return loadValidatedBlueprint(resolve(directory, `${id}.yml`)).blueprint;
}

const lifecycle: Blueprint = {
  id: "standard-lifecycle",
  kind: "process",
  nodes: { work: { uses: "wait", stage: true } },
  edges: [],
};

function policyNode() {
  return async ({ params }: { params: Record<string, unknown> }) => {
    const policy = parse(
      readFileSync(resolve(directory, String(params["rules"])), "utf8"),
    ) as {
      rules: {
        id: string;
        when?: string;
        blueprint: string;
        inputs?: Record<string, unknown>;
      }[];
    };
    const input = params["input"] as Record<string, unknown>;
    for (const rule of policy.rules) {
      if (
        rule.when === undefined ||
        Boolean(await jsonata(rule.when).evaluate(input))
      )
        return {
          id: rule.id,
          blueprint: rule.blueprint,
          inputs: await resolveValues(rule.inputs ?? {}, input),
        };
    }
    throw new Error("No intake policy matched");
  };
}

function setup(
  options: {
    now?: () => number;
    notification?: NotificationDelivery | null;
    type?: string;
  } = {},
) {
  const github = fixture();
  const issue = github.issues[0];
  if (!issue) throw new Error("Fixture issue missing");
  if (options.type !== undefined) issue.issueType = { name: options.type };
  const store = new RunStore(":memory:");
  stores.push(store);
  const blueprints = [
    shipped("default-intake"),
    shipped("hold-then-attention"),
    lifecycle,
  ];
  const service = new GitHubBindingService(
    store,
    [{ owner: "sample-owner", number: 1 }],
    github.clients,
    () => Promise.resolve(blueprints),
    {
      resolveBlueprint: (_commit, id) => {
        const blueprint = blueprints.find((candidate) => candidate.id === id);
        if (!blueprint) throw new Error(`Unknown blueprint: ${id}`);
        return Promise.resolve(deriveFlowcraftBlueprint(blueprint));
      },
      nodes: { policy: policyNode() },
      ...(options.now === undefined ? {} : { clock: options.now }),
    },
    {
      intake: { blueprintId: "default-intake", commit: "revision" },
      ...(options.notification === null
        ? {}
        : {
            notifications:
              options.notification ??
              ({
                send: () => Promise.resolve(),
              } satisfies NotificationDelivery),
          }),
    },
  );
  return { github, service, store };
}

it("ships valid replaceable intake and hold blueprints", () => {
  expect(validateBlueprintPath(directory)).toEqual([]);
});

it("rejects the shipped notify node before startup effects when notification delivery is absent", async () => {
  const { github, service, store } = setup({ notification: null });

  await expect(service.start()).rejects.toThrow(
    'Blueprint runtime capability check failed:\n- blueprint "hold-then-attention", node "notify-attention": node type "notify" is unavailable; configure options.notifications to enable notification delivery',
  );
  expect(github.transport.calls).toHaveLength(0);
  expect(store.list()).toHaveLength(0);
});

it("binds the hold condition and prompt to its one expected type input", () => {
  const blueprint = structuredClone(shipped("hold-then-attention"));
  const nodes = blueprint.nodes as Record<string, BlueprintNode>;
  const wait = nodes["wait-for-type"];
  const notify = nodes["notify-attention"];
  if (!wait || !notify) throw new Error("Shipped hold nodes are missing");
  nodes["wait-for-type"] = {
    ...wait,
    params: {
      ...wait.params,
      bindings: { expectedtype: "missing" },
    },
  };
  expect(lintHeddle("hold.yml", blueprint, {})).toContainEqual(
    expect.objectContaining({
      node: "wait-for-type",
      rule: "heddle.context-key",
      message: "Bound value expectedtype cannot be provided: missing",
    }),
  );

  const restored = shipped("hold-then-attention").nodes["wait-for-type"];
  if (!restored) throw new Error("Shipped wait node is missing");
  nodes["wait-for-type"] = restored;
  nodes["notify-attention"] = {
    ...notify,
    params: {
      ...notify.params,
      message: { inline: "Issue type {{ missing }} is still required." },
    },
  };
  expect(lintHeddle("hold.yml", blueprint, {})).toContainEqual(
    expect.objectContaining({
      node: "notify-attention",
      rule: "heddle.context-key",
      message: "Template context key cannot be provided: missing",
    }),
  );
});

it("starts the lifecycle selected by the default intake", async () => {
  const { service, store } = setup({ type: "Work item" });
  await service.start();
  const instance = service.instances.get("I_1");
  expect(instance.runId).not.toBeNull();
  expect(store.get(instance.runId ?? "missing")).toMatchObject({
    blueprintId: "standard-lifecycle",
    status: "awaiting",
    initialContext: { issue: { id: "I_1", type: "Work item" } },
  });
  expect(store.lifecycleStarts("intake:I_1")).toHaveLength(1);
});

it("starts intake when delivery discovers a new issue", async () => {
  const { github, service, store } = setup({ type: "Recipe" });
  await service.start();
  const added = recipe(2);
  added.issueType = { name: "Work item" };
  added.updatedAt = "2026-01-02T00:00:00Z";
  github.issues.push(added);

  expect(
    await service.deliver("issues", {
      issue: { node_id: added.id, updated_at: added.updatedAt },
    }),
  ).toBe(true);
  const instance = service.instances.get(added.id);
  expect(store.get(instance.runId ?? "missing")).toMatchObject({
    blueprintId: "standard-lifecycle",
    initialContext: { issue: { id: added.id, type: "Work item" } },
  });
});

it("polling discovers and starts intake without a webhook", async () => {
  const { github, service, store } = setup({ type: "Recipe" });
  await service.start();
  const added = recipe(2);
  added.issueType = { name: "Work item" };
  github.issues.push(added);

  expect(await service.poll()).toBe(0);
  const instance = service.instances.get(added.id);
  expect(store.get(instance.runId ?? "missing")).toMatchObject({
    blueprintId: "standard-lifecycle",
    initialContext: { issue: { id: added.id, type: "Work item" } },
  });
});

it("wakes unmatched intake and attaches the selected lifecycle", async () => {
  const { github, service, store } = setup({ type: "Recipe" });
  await service.start();
  expect(service.instances.get("I_1").runId).toBeNull();
  expect(
    store.list().some((run) => run.blueprintId === "hold-then-attention"),
  ).toBe(true);

  const issue = github.issues[0];
  if (!issue) throw new Error("Fixture issue missing");
  issue.issueType = { name: "Work item" };
  issue.updatedAt = "2026-01-02T00:00:00Z";
  expect(await service.poll()).toBe(1);

  const instance = service.instances.get("I_1");
  expect(store.get(instance.runId ?? "missing")).toMatchObject({
    blueprintId: "standard-lifecycle",
    initialContext: { issue: { id: "I_1", type: "Work item" } },
  });
  expect(store.lifecycleStarts()).toHaveLength(1);
});

it("notifies the configured Pushover channel after the authored deadline", async () => {
  let now = 0;
  const calls: { input: string | URL | Request; init?: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    calls.push({
      input,
      ...(init === undefined ? {} : { init }),
    });
    return Promise.resolve(
      new Response(JSON.stringify({ status: 1 }), { status: 200 }),
    );
  };
  const notification = new PushoverDelivery({
    token: "test-application-token",
    user: "test-channel-key",
    endpoint: "https://example.invalid/messages",
    fetch,
  });
  const { service } = setup({
    type: "Recipe",
    now: () => now,
    notification,
  });
  await service.start();
  now = 24 * 60 * 60 * 1000;
  await service.engine.tick();

  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (!call) throw new Error("Notification request missing");
  expect(call.input).toBe("https://example.invalid/messages");
  const { init } = call;
  expect(init?.method).toBe("POST");
  expect(init?.body).toBeInstanceOf(URLSearchParams);
  const body = init?.body as URLSearchParams;
  expect(Object.fromEntries(body)).toEqual({
    token: "test-application-token",
    user: "test-channel-key",
    title: "Issue intake needs attention",
    message: "Issue type Work item is still required.",
  });
});
