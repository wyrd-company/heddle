// ---
// relationships:
//   implements: node-types
// ---
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import nunjucks from "nunjucks";
import { parse } from "yaml";
import { prepareAgentTools } from "../agent-tools/index.js";
import { schemas } from "../t3code/index.js";
import type { Data, EngineNodeContext } from "../engine/index.js";
import type { HeddleFlowcraftNode } from "../blueprints/flowcraft.js";
import type { PassInvocation, PassOptions } from "./types.js";

export async function preparePass(
  context: EngineNodeContext,
  options: PassOptions,
): Promise<PassInvocation> {
  const { params, run, nodeId, visit } = context;
  const definition = run.blueprint.nodes.find(
    (node) => node.id === nodeId,
  ) as HeddleFlowcraftNode;
  const read = (path: string) =>
    options.readArtifact(run.commit, run.blueprintId, path);
  const prompt = params["prompt"];
  const template =
    typeof prompt === "string" ? await read(prompt) : record(prompt)["inline"];
  if (typeof template !== "string")
    throw new Error(
      "Pass prompt requires a pinned template path or inline text",
    );
  const handoff =
    typeof params["handoff"] === "string"
      ? (parse(await read(params["handoff"])) as unknown)
      : params["handoff"];
  const model = schemas.orchestrationModel.ModelSelection.parse(
    typeof params["model"] === "string"
      ? { ...options.defaultModel, model: params["model"] }
      : (params["model"] ?? options.defaultModel),
  );
  const runtimeMode = params["runtimeMode"] ?? "full-access";
  if (
    runtimeMode !== "full-access" &&
    runtimeMode !== "auto" &&
    runtimeMode !== "auto-accept-edits" &&
    runtimeMode !== "approval-required"
  )
    throw new Error("Invalid pass runtime mode");
  const worktree = params["worktree"] ?? options.defaultWorktree;
  if (typeof worktree !== "string" || !worktree)
    throw new Error("Pass requires a worktree");
  const resume = params["resumeThread"];
  const stages = record(context.context["stages"]);
  const target =
    typeof definition.params?.["resumeThread"] === "string"
      ? record(stages[String(resume)])["threadId"]
      : resume;
  if (resume !== undefined && (typeof target !== "string" || !target))
    throw new Error("Pass resumeThread does not identify a prior thread");
  const threadId = typeof target === "string" ? target : randomUUID();
  const tools = (params["tools"] ?? []) as unknown;
  if (!Array.isArray(tools)) throw new Error("Pass tools must be a list");
  const extra = tools.map((value) => {
    const tool = record(value);
    if (
      typeof tool["name"] !== "string" ||
      typeof tool["endpoint"] !== "string"
    )
      throw new Error("Pass tools require a name and endpoint");
    if (tool["name"] === "heddle")
      throw new Error(
        "The heddle tool name belongs to the generated pass server",
      );
    return { name: tool["name"], endpoint: tool["endpoint"] };
  });
  if (new Set(extra.map((tool) => tool.name)).size !== extra.length)
    throw new Error("Pass tool names must be unique");
  const policy = params["turnEndPolicy"] ?? "require-handoff";
  if (policy !== "allow" && policy !== "require-handoff")
    throw new Error("Invalid pass turn-end policy");
  const escalation = params["escalation"] ?? "answer-in-place";
  if (escalation !== "answer-in-place" && escalation !== "ends-stage")
    throw new Error("Invalid pass escalation mode");
  const generated = prepareAgentTools({
    threadId,
    handoff: record(handoff),
    context: context.context,
    policy,
    escalation,
  });
  const environment = new nunjucks.Environment([], {
    autoescape: false,
    throwOnUndefined: true,
  });
  const rendered = environment.renderString(template, {
    ...context.context,
    metadata: definition.metadata ?? {},
    node: definition,
    input: context.input,
  });
  return {
    key: context.effectKey,
    runId: run.id,
    nodeId,
    visit,
    threadId,
    reused: resume !== undefined,
    worktree,
    prompt: rendered,
    model,
    runtimeMode,
    commandId: randomUUID(),
    messageId: randomUUID(),
    createdAt: new Date().toISOString(),
    details: {
      ...generated.details,
      runId: run.id,
      nodeId,
      turnEndPolicy: policy,
    },
    binding: generated.binding,
    tools: extra,
    phase: "prepared",
    sequence: null,
    dispatched: false,
    registrationNames: [],
    projection: null,
    view: {
      runId: run.id,
      nodeId,
      visit,
      threadId,
      lastActivity: null,
      turnCount: 0,
      operatorTurnCount: 0,
      turns: {},
      usageByModel: {},
      helpers: {},
      contextRatio: null,
      previousContextRatio: null,
      compactions: [],
      openRequests: [],
      turnEndPolicy: policy,
      nativeSessionId: null,
      usageBaseline: null,
      usageSessionId: null,
      pendingMessageId: null,
    },
  };
}
export function record(value: unknown): Data {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
}
export const projectTitle = (worktree: string): string =>
  basename(worktree) || "Workspace";
