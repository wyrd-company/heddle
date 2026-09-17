// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import { ChatImageAttachment, ChatFileAttachment } from "../model.js";

export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const UserInputAttachments = z.record(
  z.string(),
  z
    .array(z.union([ChatImageAttachment, ChatFileAttachment]))
    .max(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
);
export type UserInputAttachments = z.infer<typeof UserInputAttachments>;
