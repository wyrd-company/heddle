// ---
// relationships:
//   verifies: heddle
// ---

import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { deliveryBlueprintFixture } from "../engine/lifecycle-blueprint.test-support.js";
import { readLifecycleContext, type LifecycleNode } from "../engine/index.js";
import { advanceOperationId } from "../mcp-server/operations.js";
import type { StoredStageHandoff } from "../mcp-server/types.js";
import { createProductionComposition } from "./composition.js";
import {
  execute,
  prepareProductionEpicFixture,
  SyntheticT3,
  type ProductionFixture,
} from "./composition.test-support.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/**
 * One delivery workflow spelled two ways. Heddle reads the `uses` of each
 * node and the edges between them; the identifiers and disposition names are
 * the author's. Both spellings must produce the same effects, contracts,
 * transitions, and status projections.
 */
type Spelling = {
  artifact: string;
  dispositions: {
    approve: string;
    complete: string;
    reject: string;
    wrap: string;
  };
  nodes: {
    finalize: string;
    implement: string;
    merge: string;
    prepare: string;
    remediate: string;
    retrospective: string;
    review: string;
    snapshot: string;
  };
};

const familiar: Spelling = {
  artifact: "familiar-delivery",
  dispositions: {
    approve: "approve",
    complete: "complete",
    reject: "reject",
    wrap: "complete",
  },
  nodes: {
    finalize: "finalize",
    implement: "implement",
    merge: "merge",
    prepare: "prepare-worktree",
    remediate: "remediate",
    retrospective: "retrospective",
    review: "review",
    snapshot: "review-snapshot",
  },
};

const kitchen: Spelling = {
  artifact: "kitchen-service",
  dispositions: {
    approve: "ship",
    complete: "ready",
    reject: "sendBack",
    wrap: "closeKitchen",
  },
  nodes: {
    finalize: "wipe-down",
    implement: "cook",
    merge: "serve",
    prepare: "open-kitchen",
    remediate: "season",
    retrospective: "debrief",
    review: "taste",
    snapshot: "plate",
  },
};

const spell = (spelling: Spelling, templateCommitSha: string) => {
  const source = deliveryBlueprintFixture("standard-delivery");
  const nodeId: Record<string, string> = {
    finalize: spelling.nodes.finalize,
    implement: spelling.nodes.implement,
    merge: spelling.nodes.merge,
    "prepare-worktree": spelling.nodes.prepare,
    remediate: spelling.nodes.remediate,
    retrospective: spelling.nodes.retrospective,
    review: spelling.nodes.review,
    "review-snapshot": spelling.nodes.snapshot,
  };
  const disposition = (edge: { disposition?: string; source: string }) => {
    if (edge.disposition === undefined) return undefined;
    if (edge.source === "review" && edge.disposition === "approve") {
      return spelling.dispositions.approve;
    }
    if (edge.source === "review" && edge.disposition === "reject") {
      return spelling.dispositions.reject;
    }
    if (edge.source === "retrospective") return spelling.dispositions.wrap;
    if (edge.source === "implement" || edge.source === "remediate") {
      return spelling.dispositions.complete;
    }
    return edge.disposition;
  };
  const nodes: LifecycleNode[] = source.nodes.map((node) => {
    if (node.uses !== "wait") return { ...node, id: nodeId[node.id]! };
    return {
      ...node,
      "handoff-template": {
        commitSha: templateCommitSha,
        path:
          node.id === "remediate"
            ? "handoff-templates/remediation.md"
            : "handoff-templates/standard.md",
      },
      id: nodeId[node.id]!,
      "todo-template": "sample-stage",
      tools: ["advance"],
    };
  });
  const edges = source.edges.map((edge) => {
    const name = disposition(edge);
    return {
      ...edge,
      ...(name === undefined
        ? {}
        : {
            condition: `result.output.dispositions.${name}`,
            disposition: name,
          }),
      source: nodeId[edge.source]!,
      target: nodeId[edge.target]!,
    };
  });
  return {
    $schema: "https://wyrd.company/heddle/lifecycle-blueprint.schema.json",
    "board-statuses": source["board-statuses"],
    edges,
    nodes,
    relationships: {
      implements: "heddle",
      uses: ["remediation", "review-findings", "sample-stage", "standard"],
    },
  };
};

const git = async (cwd: string, ...arguments_: string[]): Promise<string> =>
  (await execute("git", arguments_, { cwd })).stdout.trim();

const commitBlueprint = async (
  fixture: ProductionFixture,
  artifact: string,
  blueprint: unknown,
  message: string,
): Promise<void> => {
  const root = fixture.blueprintsRepositoryRoot;
  await writeFile(
    join(root, "blueprints", `${artifact}.json`),
    `${JSON.stringify(blueprint, null, 2)}\n`,
  );
  await execute("git", ["add", `blueprints/${artifact}.json`], { cwd: root });
  await execute(
    "git",
    [
      "-c",
      "user.name=Fixture User",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      message,
    ],
    { cwd: root },
  );
  await execute("git", ["push", "--quiet", "origin", "main"], { cwd: root });
};

const installSpelling = async (
  fixture: ProductionFixture,
  spelling: Spelling,
): Promise<void> => {
  const templateCommitSha = await git(
    fixture.blueprintsRepositoryRoot,
    "rev-parse",
    "HEAD",
  );
  await commitBlueprint(
    fixture,
    spelling.artifact,
    spell(spelling, templateCommitSha),
    `Add ${spelling.artifact}`,
  );
  await execute(
    "kanban-md",
    [
      "--dir",
      fixture.configuration.boardDirectory,
      "edit",
      String(fixture.taskId),
      "--remove-tag",
      "lifecycle:sample",
      "--add-tag",
      `lifecycle:${spelling.artifact}`,
      "--json",
    ],
    { cwd: fixture.root },
  );
};

const compose = (fixture: ProductionFixture) =>
  createProductionComposition({
    blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
    configuration: fixture.configuration,
    providerUsage: {
      readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
    },
    pushoverTransport: { send: vi.fn(async () => undefined) },
    t3: new SyntheticT3(),
    workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
  });

const statusOf = async (fixture: ProductionFixture): Promise<string> => {
  const result = await execute(
    "kanban-md",
    [
      "--dir",
      fixture.configuration.boardDirectory,
      "show",
      String(fixture.taskId),
      "--json",
    ],
    { cwd: fixture.root },
  );
  return (JSON.parse(result.stdout) as { status: string }).status;
};

type Composition = ReturnType<typeof compose>;

const activations = (composition: Composition, instanceId: string) =>
  composition.persistence
    .replayEvents(instanceId)
    .filter(({ type }) => type === "session:activated")
    .map(({ payload }) => (payload as { sessionKey: string }).sessionKey);

const stageContracts = (composition: Composition, instanceId: string) =>
  composition.persistence
    .getInstance(instanceId)!
    .state.handoffs.filter(
      (handoff): handoff is StoredStageHandoff =>
        typeof handoff === "object" &&
        handoff !== null &&
        !Array.isArray(handoff) &&
        handoff["kind"] === "stage-handoff",
    )
    .map(({ sessionKey, workflowMcp }) => ({
      dispositions: workflowMcp.dispositions.map(
        ({ description, name, outputContract }) => ({
          description,
          name,
          ...(outputContract === undefined ? {} : { outputContract }),
        }),
      ),
      sessionKey,
      stage: workflowMcp.stage,
      tools: workflowMcp.tools,
    }));

describe("production delivery under two spellings", () => {
  it.each([familiar, kitchen])(
    "runs the $artifact delivery by capability, across a restart, with the same contracts and projections",
    async (spelling) => {
      const fixture = await prepareProductionEpicFixture();
      cleanup = fixture.cleanup;
      await installSpelling(fixture, spelling);
      const instanceId = `task-${fixture.taskId}`;
      const { nodes, dispositions } = spelling;
      const session = (stage: string, activation: number) =>
        `${instanceId}:${stage}:${activation}`;
      const worktree = join(
        fixture.configuration.session.worktreesRoot!,
        String(fixture.taskId),
        "sample-repository",
      );

      let composition = compose(fixture);
      const statusWrites: string[] = [];
      const observeStatuses = (target: Composition) => {
        const original = target.board.mirrorTaskStatus.bind(target.board);
        vi.spyOn(target.board, "mirrorTaskStatus").mockImplementation(
          async (taskId, status) => {
            statusWrites.push(status);
            return original(taskId, status);
          },
        );
      };
      observeStatuses(composition);
      await composition.start();

      // The prepare-worktree capability ran, whatever its node is called.
      await expect(stat(join(worktree, ".git"))).resolves.toBeDefined();
      expect(await statusOf(fixture)).toBe("in-progress");
      expect(activations(composition, instanceId)).toEqual([
        session(nodes.implement, 1),
      ]);

      await composition.lifecycle.resume({
        disposition: dispositions.complete,
        instanceId,
        operationId: advanceOperationId(session(nodes.implement, 1)),
      });
      await composition.scheduler.trigger();
      expect(await statusOf(fixture)).toBe("review");
      expect(activations(composition, instanceId)).toEqual([
        session(nodes.implement, 1),
        session(nodes.review, 1),
      ]);

      await composition.lifecycle.resume({
        disposition: dispositions.reject,
        instanceId,
        operationId: advanceOperationId(session(nodes.review, 1)),
        output: { findings: [{ summary: "Season to taste" }] },
      });
      await composition.scheduler.trigger();
      expect(activations(composition, instanceId)).toEqual([
        session(nodes.implement, 1),
        session(nodes.review, 1),
        session(nodes.remediate, 1),
      ]);
      const remediation = composition.persistence
        .replayEvents(instanceId)
        .filter(({ type }) => type === "session:activated")
        .at(-1)!.payload as { renderedDocument: string };
      expect(remediation.renderedDocument).toContain("Season to taste");

      await composition.lifecycle.resume({
        disposition: dispositions.complete,
        instanceId,
        operationId: advanceOperationId(session(nodes.remediate, 1)),
      });
      await composition.scheduler.trigger();
      expect(activations(composition, instanceId)).toEqual([
        session(nodes.implement, 1),
        session(nodes.review, 1),
        session(nodes.remediate, 1),
        session(nodes.review, 2),
      ]);
      const pinnedBlob = readLifecycleContext(
        composition.persistence.getInstance(instanceId)!,
      ).blueprintBlobHash;
      await composition.close();

      // The upstream catalog moves on; the running instance does not.
      const templateCommitSha = await git(
        fixture.blueprintsRepositoryRoot,
        "rev-parse",
        "HEAD",
      );
      const drifted = spell(spelling, templateCommitSha);
      for (const node of drifted.nodes) node.id = `${node.id}-next`;
      for (const edge of drifted.edges) {
        edge.source = `${edge.source}-next`;
        edge.target = `${edge.target}-next`;
      }
      await commitBlueprint(
        fixture,
        spelling.artifact,
        drifted,
        "Rename every stage upstream",
      );

      composition = compose(fixture);
      observeStatuses(composition);
      await composition.start();
      expect(
        readLifecycleContext(composition.persistence.getInstance(instanceId)!),
      ).toMatchObject({
        awaitingNodeIds: [nodes.review],
        blueprintBlobHash: pinnedBlob,
      });
      expect(activations(composition, instanceId)).toHaveLength(4);

      await composition.lifecycle.resume({
        disposition: dispositions.approve,
        instanceId,
        operationId: advanceOperationId(session(nodes.review, 2)),
      });
      await composition.scheduler.trigger();
      expect(await statusOf(fixture)).toBe("retrospective");
      expect(activations(composition, instanceId)).toEqual([
        session(nodes.implement, 1),
        session(nodes.review, 1),
        session(nodes.remediate, 1),
        session(nodes.review, 2),
        session(nodes.retrospective, 1),
      ]);

      await composition.lifecycle.resume({
        disposition: dispositions.wrap,
        instanceId,
        operationId: advanceOperationId(session(nodes.retrospective, 1)),
      });
      await composition.scheduler.trigger();
      await composition.scheduler.trigger();
      expect(await statusOf(fixture)).toBe("done");
      await expect(stat(worktree)).rejects.toMatchObject({ code: "ENOENT" });
      expect(statusWrites).toEqual([
        "in-progress",
        "review",
        "review",
        "retrospective",
        "done",
      ]);
      expect(
        composition.persistence
          .listReconcilerRuntime()
          .find((runtime) => runtime.instanceId === instanceId),
      ).toMatchObject({ boardStatus: "done", state: "done" });
      expect(
        composition.attention
          .list()
          .filter(({ taskId }) => taskId === fixture.taskId),
      ).toEqual([]);

      // Session contracts follow the pinned node, not a familiar name.
      const contract = (stage: string) =>
        expect.objectContaining({ stage, tools: ["advance"] });
      expect(stageContracts(composition, instanceId)).toEqual([
        contract(nodes.implement),
        contract(nodes.review),
        contract(nodes.remediate),
        contract(nodes.review),
        contract(nodes.retrospective),
      ]);
      const byName = (left: { name: string }, right: { name: string }) =>
        left.name.localeCompare(right.name);
      expect(
        [...stageContracts(composition, instanceId)[1]!.dispositions].sort(
          byName,
        ),
      ).toEqual(
        [
          {
            description: "Approve the reviewed change",
            name: dispositions.approve,
          },
          {
            description: "Return the reviewed change for remediation",
            name: dispositions.reject,
            outputContract: "review-findings",
          },
        ].sort(byName),
      );
      expect(
        readLifecycleContext(composition.persistence.getInstance(instanceId)!),
      ).toMatchObject({ awaitingNodeIds: [], status: "completed" });
      await composition.close();
    },
    60_000,
  );
});
