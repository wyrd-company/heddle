// ---
// relationships:
//   verifies:
//     - node-types
//     - blueprint-authoring
// ---
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BlueprintCatalog } from "../src/service/blueprints.js";
import {
  notifyNode,
  type Notification,
  type NotificationDelivery,
} from "../src/binding/notify.js";
import { preparePass } from "../src/pass/prepare.js";
import type { EngineNodeContext } from "../src/engine/types.js";
import type { HeddleFlowcraftBlueprint } from "../src/blueprints/flowcraft.js";
import { schemas } from "../src/t3code/index.js";
import type { PassOptions } from "../src/pass/types.js";
import { commitFixture } from "./support/blueprint-repository.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function temporary(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const results = [
  "handoff",
  "escalate",
  "timeout",
  "idle",
  "turnEnded",
  "overridden",
];

/** A repository whose blueprint sits in a subdirectory beside shared parts. */
function sampleRepository(summary: string): string {
  const root = temporary("heddle-templates-");
  mkdirSync(join(root, "shared"), { recursive: true });
  mkdirSync(join(root, "process", "prompts"), { recursive: true });
  writeFileSync(
    join(root, "shared", "greeting.njk"),
    "Open card {{ issue.ref }}.",
  );
  writeFileSync(
    join(root, "shared", "signature.njk"),
    "Filed under {{ blueprint.metadata.shelfLabel }}.",
  );
  writeFileSync(
    join(root, "process", "prompts", "brief.njk"),
    'Task: {% include "shared/greeting.njk" %}',
  );
  writeFileSync(join(root, "process", "prompts", "summary.njk"), summary);
  writeFileSync(
    join(root, "process", "sample-process.yml"),
    `id: sample-process
kind: process
metadata:
  shelfLabel: upper-shelf
nodes:
  inspect:
    uses: pass
    params:
      prompt: prompts/brief.njk
      handoff:
        type: object
        description: Submit the result.
        properties:
          accepted: { type: boolean }
        required: [accepted]
  announce:
    uses: notify
    params:
      channel: pushover
      title: { inline: "Card reviewed" }
      message: prompts/summary.njk
  finish:
    uses: terminal-result
    params:
      value: done
edges:
${results.map((result) => `  - from: inspect\n    to: announce\n    when: result.output.${result}\n`).join("")}  - from: announce
    to: finish
`,
  );
  return root;
}

function passOptions(templates: PassOptions["templates"]): PassOptions {
  return {
    client: {} as PassOptions["client"],
    toolOrigin: "http://127.0.0.1:1234",
    defaultModel: schemas.orchestrationModel.ModelSelection.parse({
      instanceId: "sample-provider",
      model: "sample-model",
    }),
    defaultWorktree: "/tmp/sample-workspace",
    templates,
  };
}

interface Sent {
  notifications: Notification[];
  delivery: NotificationDelivery;
}
function recorder(): Sent {
  const notifications: Notification[] = [];
  return {
    notifications,
    delivery: {
      send(notification) {
        notifications.push(notification);
        return Promise.resolve({ status: 1 });
      },
    },
  };
}

function nodeContext(
  blueprint: HeddleFlowcraftBlueprint,
  commit: string,
  nodeId: string,
  context: Record<string, unknown> = { issue: { ref: "cards#12" } },
): EngineNodeContext {
  const definition = blueprint.nodes.find((node) => node.id === nodeId);
  if (!definition) throw new Error(`Unknown node ${nodeId}`);
  return {
    run: {
      id: "run-1",
      blueprintId: blueprint.id,
      commit,
      blueprint,
    } as unknown as EngineNodeContext["run"],
    nodeId,
    visit: 1,
    effectKey: `run-1:${nodeId}:1`,
    params: { ...definition.params },
    input: null,
    context,
    await: () => Promise.resolve(),
  };
}

it("delivers a notify message from the file pinned at the run's commit", async () => {
  const root = sampleRepository("Reviewed {{ issue.ref }} on the first pass.");
  const commit = commitFixture(root);
  writeFileSync(
    join(root, "process", "prompts", "summary.njk"),
    "Working-tree text that no run may read.",
  );
  const catalog = new BlueprintCatalog(root);
  const blueprint = await catalog.resolve(commit, "sample-process");
  const sent = recorder();
  await notifyNode(sent.delivery, catalog)(
    nodeContext(blueprint, commit, "announce"),
  );
  expect(sent.notifications).toEqual([
    { title: "Card reviewed", message: "Reviewed cards#12 on the first pass." },
  ]);
});

it("renders dotted references in a notify template", async () => {
  const root = sampleRepository(
    "{{ issue.ref }} belongs to {{ blueprint.metadata.shelfLabel }}.",
  );
  const commit = commitFixture(root);
  const catalog = new BlueprintCatalog(root);
  const blueprint = await catalog.resolve(commit, "sample-process");
  const sent = recorder();
  await notifyNode(sent.delivery, catalog)(
    nodeContext(blueprint, commit, "announce"),
  );
  expect(sent.notifications[0]?.message).toBe(
    "cards#12 belongs to upper-shelf.",
  );
});

it("resolves a notify include from the repository root", async () => {
  const root = sampleRepository(
    'Reviewed. {% include "shared/signature.njk" %}',
  );
  const commit = commitFixture(root);
  writeFileSync(
    join(root, "shared", "signature.njk"),
    "Working-tree text that no run may read.",
  );
  const catalog = new BlueprintCatalog(root);
  const blueprint = await catalog.resolve(commit, "sample-process");
  const sent = recorder();
  await notifyNode(sent.delivery, catalog)(
    nodeContext(blueprint, commit, "announce"),
  );
  expect(sent.notifications[0]?.message).toBe(
    "Reviewed. Filed under upper-shelf.",
  );
});

it("resolves a pass prompt include from the repository root", async () => {
  const root = sampleRepository("Reviewed.");
  const commit = commitFixture(root);
  const catalog = new BlueprintCatalog(root);
  const blueprint = await catalog.resolve(commit, "sample-process");
  const invocation = await preparePass(
    nodeContext(blueprint, commit, "inspect"),
    passOptions(catalog),
  );
  expect(invocation.prompt).toBe("Task: Open card cards#12.");
});

it("refuses an include that leaves the repository root", async () => {
  const root = sampleRepository('{% include "../outside.njk" %}');
  const commit = commitFixture(root);
  const catalog = new BlueprintCatalog(root);
  const blueprint = await catalog.resolve(commit, "sample-process");
  const sent = recorder();
  await expect(
    notifyNode(sent.delivery, catalog)(
      nodeContext(blueprint, commit, "announce"),
    ),
  ).rejects.toThrow("Template path leaves the blueprint repository");
  expect(sent.notifications).toEqual([]);
});

it("fails a notify node whose template reads an undefined value", async () => {
  const root = sampleRepository("Reviewed by {{ reviewer.name }}.");
  const commit = commitFixture(root);
  const catalog = new BlueprintCatalog(root);
  const blueprint = await catalog.resolve(commit, "sample-process");
  const sent = recorder();
  await expect(
    notifyNode(sent.delivery, catalog)(
      nodeContext(blueprint, commit, "announce"),
    ),
  ).rejects.toThrow('attempted to output null or undefined value');
  expect(sent.notifications).toEqual([]);
});

it("delivers the shipped collection-catalog record message", async () => {
  const root = temporary("heddle-catalog-fixture-");
  cpSync(resolve("fixtures/blueprints/collection-catalog"), root, {
    recursive: true,
  });
  const commit = commitFixture(root);
  const catalog = new BlueprintCatalog(root);
  const blueprint = await catalog.resolve(commit, "collection-catalog");
  const sent = recorder();
  await notifyNode(sent.delivery, catalog)(
    nodeContext(blueprint, commit, "record"),
  );
  expect(sent.notifications).toEqual([
    {
      title: "Collection accepted",
      message:
        "Record the accepted collection under community-collection.\n",
    },
  ]);
});
