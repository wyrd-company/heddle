// ---
// relationships:
//   implements: engine-and-run-model
// ---
import type { WorkflowBlueprint } from "flowcraft";

export type Data = Record<string, unknown>;
export type RunStatus =
  "running" | "resuming" | "awaiting" | "completed" | "failed";
export interface ResumeInput {
  runId: string;
  nodeId: string;
  result: string;
  payload?: unknown;
  visit?: number;
  wakeupId?: number;
}
export interface Checkpoint {
  context: Data;
  frontier?: string[];
  nodeId?: string;
  output?: unknown;
}
export interface Run {
  id: string;
  blueprintId: string;
  blueprint: WorkflowBlueprint;
  commit: string;
  rootId: string;
  parentId: string | null;
  parentNodeId: string | null;
  status: RunStatus;
  paused: boolean;
  initialContext: Data;
  context: Data;
  checkpoint: Checkpoint;
}
export interface AwaitingDetails extends Data {
  kind: string;
  threadId?: string;
  childRunId?: string;
  issueId?: string;
  deadline?: string | number;
  inactivity?: string | number;
  lastActivity?: number;
}
export interface Awaiting {
  runId: string;
  nodeId: string;
  visit: number;
  details: AwaitingDetails;
}
export interface Wakeup {
  id: number;
  runId: string;
  nodeId: string;
  visit: number;
  result: string;
  due: number;
}
export interface EngineNodeContext {
  run: Run;
  nodeId: string;
  visit: number;
  effectKey: string;
  params: Data;
  input: unknown;
  context: Data;
  await: (details: AwaitingDetails) => Promise<void>;
}
export type EngineNode = (context: EngineNodeContext) => Promise<unknown>;
export interface EngineOptions {
  resolveBlueprint: (commit: string, id: string) => Promise<WorkflowBlueprint>;
  nodes?: Record<string, EngineNode>;
  clock?: () => number;
}
export interface RunEvent {
  sequence: number;
  type: string;
  payload: unknown;
}
