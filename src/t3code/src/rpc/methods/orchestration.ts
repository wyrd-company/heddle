// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import { defineMethod } from "../spec.js";
import { ClientOrchestrationCommand } from "../../schemas/orchestration/commands.js";
import {
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationSubscribeShellInput,
  OrchestrationSubscribeThreadInput,
} from "../../schemas/orchestration/shell.js";
import {
  DispatchResult,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationGetWorkflowScriptInput,
  OrchestrationGetWorkflowScriptResult,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  OrchestrationThreadStreamItem,
} from "../../schemas/orchestration/stream.js";

export const orchestrationMethods = {
  "orchestration.dispatchCommand": defineMethod({
    payload: ClientOrchestrationCommand,
    success: DispatchResult,
    stream: false,
    scope: "orchestration:operate",
  }),
  "orchestration.getWorkflowScript": defineMethod({
    payload: OrchestrationGetWorkflowScriptInput,
    success: OrchestrationGetWorkflowScriptResult,
    stream: false,
    scope: "orchestration:read",
  }),
  "orchestration.getTurnDiff": defineMethod({
    payload: OrchestrationGetTurnDiffInput,
    success: OrchestrationGetTurnDiffResult,
    stream: false,
    scope: "orchestration:read",
  }),
  "orchestration.getFullThreadDiff": defineMethod({
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationGetFullThreadDiffResult,
    stream: false,
    scope: "orchestration:read",
  }),
  "orchestration.searchThreads": defineMethod({
    payload: OrchestrationSearchThreadsInput,
    success: OrchestrationSearchThreadsResult,
    stream: false,
    scope: "orchestration:read",
  }),
  "orchestration.getArchivedShellSnapshot": defineMethod({
    payload: z.looseObject({}),
    success: OrchestrationShellSnapshot,
    stream: false,
    scope: "orchestration:read",
  }),
  "orchestration.subscribeShell": defineMethod({
    payload: OrchestrationSubscribeShellInput,
    success: OrchestrationShellStreamItem,
    stream: true,
    scope: "orchestration:read",
  }),
  "orchestration.subscribeThread": defineMethod({
    payload: OrchestrationSubscribeThreadInput,
    success: OrchestrationThreadStreamItem,
    stream: true,
    scope: "orchestration:read",
  }),
} as const;
