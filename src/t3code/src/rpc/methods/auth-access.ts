// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import { AuthClientSession, AuthPairingLink } from "../../schemas/auth.js";
import {
  AuthSessionId,
  TrimmedNonEmptyString,
  taggedUnionWithUnknown,
} from "../../schemas/common.js";

export const AuthAccessStreamClientRemovedEvent = z.looseObject({
  version: z.literal(1),
  revision: z.number(),
  type: z.literal("clientRemoved"),
  payload: z.looseObject({ sessionId: AuthSessionId }),
});
export type AuthAccessStreamClientRemovedEvent = z.infer<typeof AuthAccessStreamClientRemovedEvent>;
export const AuthAccessStreamClientUpsertedEvent = z.looseObject({
  version: z.literal(1),
  revision: z.number(),
  type: z.literal("clientUpserted"),
  payload: AuthClientSession,
});
export type AuthAccessStreamClientUpsertedEvent = z.infer<
  typeof AuthAccessStreamClientUpsertedEvent
>;
export const AuthAccessStreamPairingLinkRemovedEvent = z.looseObject({
  version: z.literal(1),
  revision: z.number(),
  type: z.literal("pairingLinkRemoved"),
  payload: z.looseObject({ id: TrimmedNonEmptyString }),
});
export type AuthAccessStreamPairingLinkRemovedEvent = z.infer<
  typeof AuthAccessStreamPairingLinkRemovedEvent
>;
export const AuthAccessStreamPairingLinkUpsertedEvent = z.looseObject({
  version: z.literal(1),
  revision: z.number(),
  type: z.literal("pairingLinkUpserted"),
  payload: AuthPairingLink,
});
export type AuthAccessStreamPairingLinkUpsertedEvent = z.infer<
  typeof AuthAccessStreamPairingLinkUpsertedEvent
>;
export const AuthAccessSnapshot = z.looseObject({
  pairingLinks: z.array(AuthPairingLink),
  clientSessions: z.array(AuthClientSession),
});
export type AuthAccessSnapshot = z.infer<typeof AuthAccessSnapshot>;
export const AuthAccessStreamSnapshotEvent = z.looseObject({
  version: z.literal(1),
  revision: z.number(),
  type: z.literal("snapshot"),
  payload: AuthAccessSnapshot,
});
export type AuthAccessStreamSnapshotEvent = z.infer<typeof AuthAccessStreamSnapshotEvent>;
export const AuthAccessStreamEvent = taggedUnionWithUnknown("type", [
  AuthAccessStreamSnapshotEvent,
  AuthAccessStreamPairingLinkUpsertedEvent,
  AuthAccessStreamPairingLinkRemovedEvent,
  AuthAccessStreamClientUpsertedEvent,
  AuthAccessStreamClientRemovedEvent,
]);
export type AuthAccessStreamEvent = z.infer<typeof AuthAccessStreamEvent>;

import { defineMethod } from "../spec.js";
export const authAccessMethods = {
  subscribeAuthAccess: defineMethod({
    payload: z.looseObject({}),
    success: AuthAccessStreamEvent,
    stream: true,
    scope: "access:read",
  }),
} as const;
