import type { NameCache } from "./cache.js";
import type { Execute } from "./transport/execute.js";
import type { Transport } from "./transport/transport.js";

/** Everything a family module needs. Constructed once per `github()` call. */
export interface Context {
  readonly transport: Transport;
  readonly cache: NameCache;
  readonly execute: Execute;
  readonly relationshipPageSize: number;
}
