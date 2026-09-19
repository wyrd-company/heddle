/**
 * Schema barrel, exposed to consumers as `schemas`. One namespace per file
 * mirrors `packages/contracts/src` in the fork so names never collide.
 */
export * as common from "./common.js";
export * as auth from "./auth.js";
export * as environment from "./environment.js";
export * as httpErrors from "./http-errors.js";
export * as mcp from "./mcp.js";
export * as projects from "./projects.js";
export * as provider from "./provider.js";
export * as server from "./server.js";
export * as terminal from "./terminal.js";
export * as vcs from "./vcs.js";
export * as worktreeSetup from "./worktree-setup.js";
export * as orchestrationActivities from "./orchestration/activities.js";
export * as orchestrationCommands from "./orchestration/commands.js";
export * as orchestrationEvents from "./orchestration/events.js";
export * as orchestrationModel from "./orchestration/model.js";
export * as orchestrationReadModel from "./orchestration/read-model.js";
export * as orchestrationShell from "./orchestration/shell.js";
export * as orchestrationStream from "./orchestration/stream.js";
