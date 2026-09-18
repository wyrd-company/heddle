// ---
// relationships:
//   implements: node-types
// ---
import type {
  T3Client,
  ModelSelection,
  ThreadCreateInput,
  OrchestrationThread,
  PendingRequest,
} from "../t3code/index.js";
import type { AwaitingDetails, Data } from "../engine/index.js";
import type { TemplateSource } from "../templates/index.js";
import type {
  ToolBinding,
  TurnEndPolicy,
  ToolOperations,
} from "../agent-tools/index.js";

export interface PassOptions {
  client: {
    projects: Pick<T3Client["projects"], "ensure" | "findByWorkspaceRoot">;
    threads: Pick<T3Client["threads"], "ensure" | "get" | "watch" | "dispatch">;
    mcp: Pick<T3Client["mcp"], "ensureRegistration" | "clear">;
  };
  toolOrigin: string;
  defaultModel: ModelSelection;
  defaultWorktree: string;
  templates: TemplateSource;
  toolOperations?: ToolOperations;
  extraToolAuthorization?: (tool: {
    name: string;
    endpoint: string;
  }) => Promise<string>;
}
export interface PassInvocation {
  key: string;
  runId: string;
  nodeId: string;
  visit: number;
  threadId: string;
  reused: boolean;
  worktree: string;
  prompt: string;
  model: ModelSelection;
  runtimeMode: NonNullable<ThreadCreateInput["runtimeMode"]>;
  commandId: string;
  messageId: string;
  createdAt: string;
  details: AwaitingDetails;
  binding: ToolBinding | null;
  tools: { name: string; endpoint: string }[];
  phase: "prepared" | "waiting" | "stopping" | "active" | "retired";
  sequence: number | null;
  dispatched: boolean;
  registrationNames: string[];
  projection: OrchestrationThread | null;
  view: PassReadModel;
}
export interface PassReadModel {
  runId: string;
  nodeId: string;
  visit: number;
  threadId: string;
  lastActivity: number | null;
  turnCount: number;
  operatorTurnCount: number;
  turns: Record<string, { source: "heddle" | "operator"; state: string }>;
  usageByModel: Record<string, TokenUsage>;
  helpers: Record<string, Data>;
  contextRatio: number | null;
  previousContextRatio: number | null;
  compactions: Data[];
  openRequests: PendingRequest[];
  turnEndPolicy: TurnEndPolicy;
  nativeSessionId: string | null;
  usageBaseline: TokenUsage | null;
  usageSessionId: string | null;
  pendingMessageId: string | null;
  started: boolean;
}
export interface TokenUsage {
  total: number;
}
