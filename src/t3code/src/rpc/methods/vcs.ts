// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import { defineMethod } from "../spec.js";
import {
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsRemoveWorktreeInput,
  VcsStatusInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
} from "../../schemas/vcs.js";
import {
  WorktreeSetupCancelInput,
  WorktreeSetupCancelResult,
  WorktreeSetupStreamEvent,
  WorktreeSetupSubscribeInput,
} from "../../schemas/worktree-setup.js";

export const vcsMethods = {
  "vcs.listRefs": defineMethod({
    payload: VcsListRefsInput,
    success: VcsListRefsResult,
    stream: false,
    scope: "orchestration:read",
  }),
  "vcs.createWorktree": defineMethod({
    payload: VcsCreateWorktreeInput,
    success: VcsCreateWorktreeResult,
    stream: false,
    scope: "orchestration:operate",
  }),
  "vcs.createRef": defineMethod({
    payload: VcsCreateRefInput,
    success: VcsCreateRefResult,
    stream: false,
    scope: "orchestration:operate",
  }),
  "vcs.switchRef": defineMethod({
    payload: VcsSwitchRefInput,
    success: VcsSwitchRefResult,
    stream: false,
    scope: "orchestration:operate",
  }),
  "vcs.removeWorktree": defineMethod({
    payload: VcsRemoveWorktreeInput,
    success: z.void(),
    stream: false,
    scope: "orchestration:operate",
  }),
  "vcs.refreshStatus": defineMethod({
    payload: VcsStatusInput,
    success: VcsStatusResult,
    stream: false,
    scope: "orchestration:read",
  }),
  subscribeVcsStatus: defineMethod({
    payload: VcsStatusInput,
    success: VcsStatusStreamEvent,
    stream: true,
    scope: "orchestration:read",
  }),
  subscribeWorktreeSetup: defineMethod({
    payload: WorktreeSetupSubscribeInput,
    success: WorktreeSetupStreamEvent,
    stream: true,
    scope: "orchestration:read",
  }),
  "worktreeSetup.cancel": defineMethod({
    payload: WorktreeSetupCancelInput,
    success: WorktreeSetupCancelResult,
    stream: false,
    scope: "orchestration:operate",
  }),
} as const;
