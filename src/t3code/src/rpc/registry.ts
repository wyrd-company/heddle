// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { orchestrationMethods } from "./methods/orchestration.js";
import { serverMethods } from "./methods/server.js";
import { vcsMethods } from "./methods/vcs.js";
import { projectsMethods } from "./methods/projects.js";
import { terminalMethods } from "./methods/terminal.js";
import { authAccessMethods } from "./methods/auth-access.js";

export const rpcMethods = {
  ...orchestrationMethods,
  ...serverMethods,
  ...vcsMethods,
  ...projectsMethods,
  ...terminalMethods,
  ...authAccessMethods,
};
export type RpcMethods = typeof rpcMethods;
export type RpcMethodName = keyof RpcMethods;
