import type { T3DecodeError } from "../errors.js";
import type { StreamItem } from "../rpc/client.js";

export type DecodedStreamItem<T> =
  T | { readonly kind: "decode-error"; readonly error: T3DecodeError };

export function unwrapStreamItems<T>(
  source: AsyncIterable<StreamItem<T>>,
): AsyncIterable<DecodedStreamItem<T>> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const item of source) {
        yield item.kind === "item" ? item.value : item;
      }
    },
  };
}
