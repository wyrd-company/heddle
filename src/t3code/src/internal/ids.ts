import { randomUUID } from "node:crypto";

/** A fresh UUID v4. Used for command, message, thread, and project ids this client generates. */
export function newId(): string {
  return randomUUID();
}
