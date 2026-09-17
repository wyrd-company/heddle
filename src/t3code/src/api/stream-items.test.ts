import { describe, expect, it } from "vitest";
import { z } from "zod";

import { T3DecodeError } from "../errors.js";
import type { StreamItem } from "../rpc/client.js";
import { unwrapStreamItems } from "./stream-items.js";

describe("unwrapStreamItems", () => {
  it("unwraps values and preserves decode errors", async () => {
    const parsed = z.string().safeParse(3);
    if (parsed.success) throw new Error("The fixture must not decode.");
    const error = new T3DecodeError("sample.stream", parsed.error, 3);
    async function* source(): AsyncIterable<StreamItem<string>> {
      yield { kind: "item", value: "first" };
      yield { kind: "decode-error", error };
    }

    const items = [];
    for await (const item of unwrapStreamItems(source())) items.push(item);

    expect(items).toEqual(["first", { kind: "decode-error", error }]);
  });
});
