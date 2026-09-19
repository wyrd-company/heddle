import type { RpcClient } from "../rpc/client.js";
import type { RpcMethods } from "../rpc/registry.js";
import type { RpcPayload, RpcSuccess } from "../rpc/spec.js";
import { unwrapStreamItems, type DecodedStreamItem } from "./stream-items.js";

export class VcsApi {
  constructor(readonly rpc: RpcClient<RpcMethods>) {}

  listRefs(
    input: RpcPayload<RpcMethods, "vcs.listRefs">,
    signal?: AbortSignal,
  ): Promise<RpcSuccess<RpcMethods, "vcs.listRefs">> {
    return this.rpc.call("vcs.listRefs", input, signal);
  }

  status(
    input: RpcPayload<RpcMethods, "vcs.refreshStatus">,
    signal?: AbortSignal,
  ): Promise<RpcSuccess<RpcMethods, "vcs.refreshStatus">> {
    return this.rpc.call("vcs.refreshStatus", input, signal);
  }

  createWorktree(
    input: RpcPayload<RpcMethods, "vcs.createWorktree">,
    signal?: AbortSignal,
  ): Promise<RpcSuccess<RpcMethods, "vcs.createWorktree">> {
    return this.rpc.call("vcs.createWorktree", input, signal);
  }

  removeWorktree(
    input: RpcPayload<RpcMethods, "vcs.removeWorktree">,
    signal?: AbortSignal,
  ): Promise<RpcSuccess<RpcMethods, "vcs.removeWorktree">> {
    return this.rpc.call("vcs.removeWorktree", input, signal);
  }

  createRef(
    input: RpcPayload<RpcMethods, "vcs.createRef">,
    signal?: AbortSignal,
  ): Promise<RpcSuccess<RpcMethods, "vcs.createRef">> {
    return this.rpc.call("vcs.createRef", input, signal);
  }

  switchRef(
    input: RpcPayload<RpcMethods, "vcs.switchRef">,
    signal?: AbortSignal,
  ): Promise<RpcSuccess<RpcMethods, "vcs.switchRef">> {
    return this.rpc.call("vcs.switchRef", input, signal);
  }

  watchStatus(
    input: RpcPayload<RpcMethods, "subscribeVcsStatus">,
    options?: { readonly signal?: AbortSignal },
  ): AsyncIterable<DecodedStreamItem<RpcSuccess<RpcMethods, "subscribeVcsStatus">>> {
    return unwrapStreamItems(this.rpc.stream("subscribeVcsStatus", input, options));
  }
}
