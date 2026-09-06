// ---
// relationships:
//   verifies: heddle
// ---

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { LifecycleBlueprint, LifecycleNode } from "./types.js";

type AuthoredLifecycleBlueprint = Omit<LifecycleBlueprint, "id">;

const standardTemplate = {
  blobHash: "8f266fe406517c891633d8ef90ca3716f1356f37",
  path: "handoff-templates/standard.md",
};
const remediationTemplate = {
  blobHash: "3ed4e911f9ea17b7116ca49ea90b2136cdb57817",
  path: "handoff-templates/remediation.md",
};
const waitTools = [
  "advance",
  "get_task_context",
  "report_blocked",
  "escalate",
  "create_follow_up",
  "create_finding",
  "todo_list",
  "todo_check",
  "todo_add",
  "todo_edit",
  "todo_reorder",
  "spawn",
  "liveness",
  "answer",
];

const waitNode = (
  id: "implement" | "review" | "remediate" | "retrospective",
  todoTemplate: string,
): LifecycleNode => ({
  handoff: id === "remediate" ? "remediation" : "standard",
  "handoff-template":
    id === "remediate" ? remediationTemplate : standardTemplate,
  id,
  tools:
    id === "retrospective"
      ? waitTools.filter(
          (tool) =>
            tool !== "create_finding" &&
            tool !== "spawn" &&
            tool !== "liveness" &&
            tool !== "answer",
        )
      : [...waitTools],
  "todo-template": todoTemplate,
  uses: "wait",
  ...(id === "review" || id === "remediate"
    ? { config: { joinStrategy: "any" } }
    : {}),
});

export const deliveryBlueprintFixture = (
  kind: "standard-delivery" | "trivial",
): AuthoredLifecycleBlueprint => {
  const standard = kind === "standard-delivery";
  const nodes: LifecycleNode[] = [
    { id: "prepare-worktree", uses: "prepare-worktree" },
    waitNode("implement", "standard-delivery-implement"),
    {
      config: { joinStrategy: "any" },
      id: "review-snapshot",
      uses: "review-snapshot",
    },
    waitNode("review", "standard-delivery-review"),
    waitNode("remediate", "standard-delivery-remediate"),
    { config: { joinStrategy: "any" }, id: "merge", uses: "merge" },
  ];
  if (standard)
    nodes.push(waitNode("retrospective", "standard-delivery-retrospective"));
  nodes.push({ id: "finalize", uses: "finalize" });

  return {
    "board-statuses": {
      finalize: "done",
      merge: "retrospective",
      "prepare-worktree": "in-progress",
      "review-snapshot": "review",
    },
    edges: [
      { source: "prepare-worktree", target: "implement" },
      {
        condition: "result.output.dispositions.complete",
        description: "Implementation is ready for a review snapshot",
        disposition: "complete",
        source: "implement",
        target: "review-snapshot",
      },
      { source: "review-snapshot", target: "review" },
      {
        condition: "result.output.dispositions.approve",
        description: "Approve the reviewed change",
        disposition: "approve",
        source: "review",
        target: "merge",
      },
      {
        condition: "result.output.dispositions.reject",
        description: "Return the reviewed change for remediation",
        disposition: "reject",
        source: "review",
        target: "remediate",
      },
      {
        condition: "result.output.dispositions.complete",
        description: "Remediation is ready for another review snapshot",
        disposition: "complete",
        source: "remediate",
        target: "review-snapshot",
      },
      {
        condition: "result.output.dispositions.merged",
        description: "Continue after merging the exact reviewed head",
        disposition: "merged",
        source: "merge",
        target: standard ? "retrospective" : "finalize",
      },
      {
        condition: "result.output.dispositions.remediate",
        description: "Return snapshot and branch-head drift for remediation",
        disposition: "remediate",
        source: "merge",
        target: "remediate",
      },
      ...(standard
        ? [
            {
              condition: "result.output.dispositions.complete",
              description: "Retrospective is complete",
              disposition: "complete",
              source: "retrospective",
              target: "finalize",
            },
          ]
        : []),
    ],
    nodes,
  };
};

export const writeDeliveryBlueprintFixture = async (
  repositoryRoot: string,
  kind: "standard-delivery" | "trivial" = "standard-delivery",
): Promise<string> => {
  const blueprintPath = `blueprints/${kind}.json`;
  const absolutePath = join(repositoryRoot, blueprintPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    `${JSON.stringify(deliveryBlueprintFixture(kind), null, 2)}\n`,
  );
  return blueprintPath;
};
