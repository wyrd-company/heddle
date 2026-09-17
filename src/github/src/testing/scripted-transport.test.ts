import { describe, expect, it } from "vitest";
import { ScriptedTransport } from "./scripted-transport.js";

describe("ScriptedTransport", () => {
  it("answers by operation name, in order, and records calls", async () => {
    const transport = new ScriptedTransport({
      graphql: { Load: [() => ({ n: 1 }), () => ({ n: 2 })] },
      rest: { "GET /things": () => [1, 2] },
    });
    const op = (variables: Record<string, unknown>) => ({ name: "Load", document: "", variables });
    expect(await transport.graphql(op({ a: 1 }))).toEqual({ n: 1 });
    expect(await transport.graphql(op({ a: 2 }))).toEqual({ n: 2 });
    expect(await transport.graphql(op({ a: 3 }))).toEqual({ n: 2 });
    expect(await transport.rest("GET /things")).toEqual({ status: 200, data: [1, 2], headers: {} });
    expect(transport.callsTo("Load").map((c) => c.input)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it("fails loudly on unscripted operations", async () => {
    const transport = new ScriptedTransport();
    await expect(transport.graphql({ name: "Nope", document: "", variables: {} })).rejects.toThrow(
      /unscripted graphql operation: Nope/,
    );
  });
});
