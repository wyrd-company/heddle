// ---
// relationships:
//   implements: heddle
// ---

import {
  boardRecordIdentity,
  boardTaskMatchesRecord,
  type BoardTask,
  type CreateBoardRecord,
} from "../board-adapter/index.js";
import type {
  DynamicTaskIntentRecord,
  JsonValue,
} from "../persistence/index.js";

type StoredDynamicTaskRequest = {
  body: string;
  dependsOn: number[];
  operationKey: string;
  priority: string | null;
  status: string | null;
  title: string;
};

export const dynamicTaskIntentRequest = (
  record: CreateBoardRecord,
): StoredDynamicTaskRequest => ({
  body: record.body,
  dependsOn: record.dependsOn ?? [],
  operationKey: record.operationKey,
  priority: record.priority ?? null,
  status: record.status ?? null,
  title: record.title,
});

const requireStoredRequest = (value: JsonValue): StoredDynamicTaskRequest => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value["body"] !== "string" ||
    value["body"].trim() === "" ||
    !Array.isArray(value["dependsOn"]) ||
    !value["dependsOn"].every(
      (id) => Number.isSafeInteger(id) && (id as number) > 0,
    ) ||
    typeof value["operationKey"] !== "string" ||
    (value["priority"] !== null &&
      (typeof value["priority"] !== "string" ||
        value["priority"].trim() === "")) ||
    (value["status"] !== null &&
      (typeof value["status"] !== "string" || value["status"].trim() === "")) ||
    typeof value["title"] !== "string" ||
    value["title"].trim() === ""
  ) {
    throw new Error("Dynamic task intent request is malformed");
  }
  return value as StoredDynamicTaskRequest;
};

const recordFromIntent = (
  intent: DynamicTaskIntentRecord,
): CreateBoardRecord => {
  const request = requireStoredRequest(intent.request);
  return {
    body: request.body,
    dependsOn: request.dependsOn,
    kind: intent.kind,
    lifecycle: intent.lifecycle,
    operationKey: request.operationKey,
    parent: intent.parentEpicId,
    ...(request.priority === null ? {} : { priority: request.priority }),
    ...(request.status === null ? {} : { status: request.status }),
    title: request.title,
  };
};

export const dynamicTaskOperationTag = (
  intent: DynamicTaskIntentRecord,
): string => `heddle-operation:${intent.operationDigest}`;

export const dynamicTaskRecordTag = (intent: DynamicTaskIntentRecord): string =>
  `heddle-record:${intent.recordDigest}`;

export const dynamicTaskMatchesIntent = (
  task: BoardTask,
  intent: DynamicTaskIntentRecord,
): boolean => {
  const record = recordFromIntent(intent);
  let operation: unknown;
  try {
    operation = JSON.parse(record.operationKey) as unknown;
  } catch {
    throw new Error("Dynamic task operation key is malformed");
  }
  if (
    !/^[a-f0-9]{64}$/.test(intent.operationDigest) ||
    !/^[a-f0-9]{64}$/.test(intent.recordDigest) ||
    !/^[a-z][a-z-]*$/.test(intent.lifecycle) ||
    !Array.isArray(operation) ||
    operation.length !== 4 ||
    !operation.every((value) => typeof value === "string") ||
    operation[0] !== intent.sourceInstanceId ||
    operation[1] !== intent.sourceSessionKey ||
    operation[2] !== intent.kind ||
    operation[3]!.trim() === "" ||
    intent.sourceInstanceId !== `task-${intent.sourceTaskId}`
  ) {
    throw new Error("Dynamic task source identity is malformed");
  }
  const derived = boardRecordIdentity(record);
  if (
    derived.operationDigest !== intent.operationDigest ||
    derived.recordDigest !== intent.recordDigest
  ) {
    throw new Error("Dynamic task digest identity is malformed");
  }
  return boardTaskMatchesRecord(task, record, derived);
};
