import { z } from "zod";

import { ThreadId } from "./common.js";

export const ExternalMcpName = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u)
  .refine((name) => name !== "t3-code", { message: 'The name "t3-code" is reserved.' });
export type ExternalMcpName = z.infer<typeof ExternalMcpName>;

export const ExternalMcpRegistration = z.looseObject({
  name: ExternalMcpName.optional(),
  threadId: ThreadId,
  endpoint: z.string().regex(/^https?:\/\/\S+$/u),
  authorizationHeader: z.string().regex(/^Bearer [^\s\r\n]{1,8192}$/u),
});
export type ExternalMcpRegistration = z.infer<typeof ExternalMcpRegistration>;

export const ExternalMcpClear = z.looseObject({
  name: ExternalMcpName.optional(),
  threadId: ThreadId,
});
export type ExternalMcpClear = z.infer<typeof ExternalMcpClear>;

export const ExternalMcpProviderSessionQuery = z.looseObject({ threadId: ThreadId });
export type ExternalMcpProviderSessionQuery = z.infer<typeof ExternalMcpProviderSessionQuery>;

/** The native harness session identity, returned exactly as the harness reports it. */
export const ExternalMcpProviderSession = z.looseObject({ nativeSessionId: z.string() });
export type ExternalMcpProviderSession = z.infer<typeof ExternalMcpProviderSession>;
