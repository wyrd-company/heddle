// ---
// relationships:
//   implements: agent-tools
// ---
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  Awaiting,
  AwaitingDetails,
  Data,
  RunStore,
} from "../engine/index.js";

export type TurnEndPolicy = "require-handoff" | "allow";
export interface ToolState extends Data {
  path: string;
  tokenHash: string;
  handoff: Data;
  context: Data;
  policy: TurnEndPolicy;
  escalation: "answer-in-place" | "ends-stage";
  revoked: boolean;
}
export interface ToolBinding {
  path: string;
  token: string;
}
export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");
export function prepareAgentTools(input: {
  threadId: string;
  handoff: Data;
  context: Data;
  policy?: TurnEndPolicy;
  escalation?: "answer-in-place" | "ends-stage";
}): { details: AwaitingDetails; binding: ToolBinding } {
  if (
    input.handoff["type"] !== "object" ||
    typeof input.handoff["description"] !== "string" ||
    !input.handoff["description"].trim()
  )
    throw new Error("Handoff requires an object schema with a description");
  new Ajv2020({ strict: false, allErrors: true }).compile(input.handoff);
  const token = randomBytes(32).toString("base64url");
  const state: ToolState = {
    path: `/agent-tools/${randomUUID()}`,
    tokenHash: hashToken(token),
    handoff: structuredClone(input.handoff),
    context: structuredClone(input.context),
    policy: input.policy ?? "require-handoff",
    escalation: input.escalation ?? "answer-in-place",
    revoked: false,
  };
  return {
    details: { kind: "pass", threadId: input.threadId, agentTools: state },
    binding: { path: state.path, token },
  };
}
export function toolState(item: Awaiting): ToolState | undefined {
  return item.details["agentTools"] as ToolState | undefined;
}
/** Update the authoritative awaiting row and both engine checkpoint carriers together. */
export function updateToolState(
  store: RunStore,
  item: Awaiting,
  state: ToolState,
): void {
  const details = { ...item.details, agentTools: state };
  const result = store.db
    .prepare(
      "UPDATE awaiting SET details=? WHERE run_id=? AND node_id=? AND visit=?",
    )
    .run(JSON.stringify(details), item.runId, item.nodeId, item.visit);
  if (result.changes !== 1) throw new Error("Pass is no longer awaiting");
  const run = store.get(item.runId);
  for (const context of [run.context, run.checkpoint.context]) {
    context["_awaitingDetails"] = {
      ...(context["_awaitingDetails"] as Data),
      [item.nodeId]: details,
    };
  }
  store.save(run.id, run.context, run.checkpoint);
}

export function requireToolState(item: Awaiting): ToolState {
  const state = toolState(item);
  if (!state) throw new Error("Pass has no generated tool state");
  return state;
}
