// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import { defineMethod } from "../spec.js";
import { ProviderInstanceId, TrimmedNonEmptyString } from "../../schemas/common.js";
import {
  ServerConfig,
  ServerConfigStreamEvent,
  ServerLifecycleStreamEvent,
  ServerProviderUpdatedPayload,
  ServerSettings,
} from "../../schemas/server.js";

export const serverMethods = {
  "server.probe": defineMethod({
    payload: z.looseObject({}),
    success: z.looseObject({}),
    stream: false,
    scope: "orchestration:read",
  }),
  "server.getConfig": defineMethod({
    payload: z.looseObject({}),
    success: ServerConfig,
    stream: false,
    scope: "orchestration:read",
  }),
  "server.getSettings": defineMethod({
    payload: z.looseObject({}),
    success: ServerSettings,
    stream: false,
    scope: "orchestration:read",
  }),
  "server.refreshProviders": defineMethod({
    payload: z.looseObject({
      instanceId: ProviderInstanceId.optional(),
      cwd: TrimmedNonEmptyString.optional(),
      refreshModels: z.boolean().optional(),
    }),
    success: ServerProviderUpdatedPayload,
    stream: false,
    scope: "orchestration:operate",
  }),
  subscribeServerConfig: defineMethod({
    payload: z.looseObject({
      environmentThemes: z.boolean().optional(),
      usageLimitSources: z.boolean().optional(),
      usageLimitsCommand: z.boolean().optional(),
    }),
    success: ServerConfigStreamEvent,
    stream: true,
    scope: "orchestration:read",
  }),
  subscribeServerLifecycle: defineMethod({
    payload: z.looseObject({}),
    success: ServerLifecycleStreamEvent,
    stream: true,
    scope: "orchestration:read",
  }),
} as const;
