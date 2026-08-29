// ---
// relationships:
//   implements: heddle
// ---

import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

import type { JsonValue } from "../persistence/index.js";
import type {
  CorrelationTokenMatch,
  StageHandoffDocument,
  StoredStageHandoff,
  WorkflowMcpPersistence,
  WorkflowMcpSessionBinding,
} from "./types.js";
import { isWorkflowMcpStageContract } from "./stage-contract.js";
import { advanceOperationId } from "./operations.js";

export class CorrelationTokenError extends Error {
  constructor() {
    super("The correlation token is not bound to one stage session");
    this.name = "CorrelationTokenError";
  }
}

const tokenEquals = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};

const isStoredStageHandoff = (value: JsonValue): value is StoredStageHandoff =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  value["kind"] === "stage-handoff" &&
  typeof value["sessionKey"] === "string" &&
  typeof value["correlationToken"] === "string" &&
  typeof value["handoff"] === "string" &&
  value["workflowMcp"] !== undefined &&
  isWorkflowMcpStageContract(value["workflowMcp"]);

const parseHandoff = (
  serialized: string,
  expectedToken: string,
): StageHandoffDocument => {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new CorrelationTokenError();
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Partial<StageHandoffDocument>).format !==
      "heddle.stage-handoff" ||
    (value as Partial<StageHandoffDocument>).version !== 1 ||
    typeof (value as Partial<StageHandoffDocument>).correlationToken !==
      "string" ||
    !tokenEquals(
      (value as Partial<StageHandoffDocument>).correlationToken!,
      expectedToken,
    ) ||
    typeof (value as Partial<StageHandoffDocument>).stage !== "object" ||
    (value as Partial<StageHandoffDocument>).stage === null ||
    typeof (value as StageHandoffDocument).stage.name !== "string" ||
    !Object.hasOwn(value, "taskContract")
  ) {
    throw new CorrelationTokenError();
  }
  return value as StageHandoffDocument;
};

export const isAuthorityValidStoredStageHandoff = (
  value: JsonValue,
): value is StoredStageHandoff => {
  if (!isStoredStageHandoff(value)) return false;
  try {
    return (
      parseHandoff(value.handoff, value.correlationToken).stage.name ===
      value.workflowMcp.stage
    );
  } catch {
    return false;
  }
};

export const bearerCorrelationToken = (
  authorization: string | null,
): string | undefined => {
  const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? "");
  return match?.[1];
};

export class WorkflowMcpSessionResolver {
  constructor(private readonly persistence: WorkflowMcpPersistence) {}

  authenticate(token: string): CorrelationTokenMatch {
    const matches: CorrelationTokenMatch[] = [];
    for (const instance of this.persistence.listInstances()) {
      for (const [sessionKey, candidate] of Object.entries(
        instance.state.correlationTokens,
      )) {
        if (tokenEquals(candidate, token)) {
          matches.push({ instance, sessionKey, token });
        }
      }
    }
    if (matches.length !== 1) throw new CorrelationTokenError();
    return matches[0]!;
  }

  async resolve(token: string): Promise<WorkflowMcpSessionBinding> {
    const match = this.authenticate(token);
    const storedHandoffs = match.instance.state.handoffs
      .filter(isAuthorityValidStoredStageHandoff)
      .filter(
        (handoff) =>
          handoff.sessionKey === match.sessionKey &&
          tokenEquals(handoff.correlationToken, token),
      );
    if (storedHandoffs.length !== 1) throw new CorrelationTokenError();
    const handoff = parseHandoff(storedHandoffs[0]!.handoff, token);
    const context = match.instance.state.flowcraftContext;
    if (
      typeof context !== "object" ||
      context === null ||
      Array.isArray(context) ||
      typeof context["blueprintBlobHash"] !== "string" ||
      typeof context["blueprintPath"] !== "string" ||
      !Array.isArray(context["awaitingNodeIds"]) ||
      typeof context["completedOperations"] !== "object" ||
      context["completedOperations"] === null ||
      Array.isArray(context["completedOperations"])
    ) {
      throw new CorrelationTokenError();
    }
    const isCurrentStage =
      context["awaitingNodeIds"].length === 1 &&
      context["awaitingNodeIds"][0] === handoff.stage.name;
    const isCompletedStage = Object.hasOwn(
      context["completedOperations"],
      advanceOperationId(match.sessionKey),
    );
    if (!isCurrentStage && !isCompletedStage) {
      throw new CorrelationTokenError();
    }
    const stageContract = storedHandoffs[0]!.workflowMcp;
    if (
      stageContract.stage !== handoff.stage.name ||
      stageContract.blueprintBlobHash !== context["blueprintBlobHash"]
    ) {
      throw new CorrelationTokenError();
    }
    const tools = isCompletedStage
      ? stageContract.tools.filter((tool) => tool === "advance")
      : stageContract.tools;

    return {
      dispositions: stageContract.dispositions,
      instance: match.instance,
      sessionKey: match.sessionKey,
      stage: { id: stageContract.stage, tools },
      taskContext: handoff.taskContract,
      token,
    };
  }
}
