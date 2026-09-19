import { unwrapStreamItems, type DecodedStreamItem } from "../api/stream-items.js";
import type { RpcClient } from "../rpc/client.js";
import type { AuthAccessStreamEvent } from "../rpc/methods/auth-access.js";
import type { RpcMethods } from "../rpc/registry.js";

export function watchAccess(
  rpc: RpcClient<RpcMethods>,
  options?: { readonly signal?: AbortSignal },
): AsyncIterable<DecodedStreamItem<AuthAccessStreamEvent>> {
  return unwrapStreamItems(rpc.stream("subscribeAuthAccess", {}, options));
}
