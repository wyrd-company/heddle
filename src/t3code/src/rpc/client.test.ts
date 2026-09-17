import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeT3Server } from "../../test/support/fake-server.js";
import { T3AuthError, T3DecodeError, T3PreconditionError } from "../errors.js";
import { RpcConnection } from "../transport/rpc-connection.js";
import { SocketTransport } from "../transport/socket.js";
import { RpcClient } from "./client.js";
import { defineMethod } from "./spec.js";

const table = {
  "shapes.area": defineMethod({
    payload: z.looseObject({ width: z.number().positive(), height: z.number().positive() }),
    success: z.looseObject({ area: z.number() }),
    stream: false,
    scope: "orchestration:read",
  }),
  "shapes.watch": defineMethod({
    payload: z.looseObject({ kind: z.enum(["square", "circle"]) }),
    success: z.looseObject({ id: z.string(), sides: z.number() }),
    stream: true,
    scope: "orchestration:operate",
  }),
} as const;

describe("RpcClient", () => {
  let server: FakeT3Server;
  let connection: RpcConnection;
  let scopes: readonly string[] | undefined;

  const make = () => new RpcClient(connection, table, { getScopes: () => scopes });

  beforeEach(async () => {
    server = await FakeT3Server.start();
    scopes = undefined;
    connection = new RpcConnection(new SocketTransport({ url: async () => server.wsUrl }));
  });
  afterEach(async () => {
    await connection.close();
    await server.close();
  });

  it("validates, sends the normalised payload, and decodes the success value", async () => {
    server.handle("shapes.area", (payload) => {
      const { width, height } = payload as { width: number; height: number };
      return { kind: "value", value: { area: width * height, extra: "kept" } };
    });
    const result = await make().call("shapes.area", { width: 2, height: 3 });
    expect(result.area).toBe(6);
    expect(result).toMatchObject({ extra: "kept" });
  });

  it("raises T3PreconditionError with the zod issues before sending", async () => {
    const client = make();
    const error = await client
      .call("shapes.area", { width: -1, height: 3 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(T3PreconditionError);
    expect((error as Error).message).toContain("width");
    expect(server.connections).toHaveLength(0);
  });

  it("raises T3DecodeError when a unary success value does not decode", async () => {
    server.respond("shapes.area", { area: "six" });
    const error = await make()
      .call("shapes.area", { width: 2, height: 3 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(T3DecodeError);
    expect((error as T3DecodeError).raw).toEqual({ area: "six" });
  });

  it("streams typed items and continues past a decode error", async () => {
    server.handle("shapes.watch", () => ({
      kind: "stream",
      chunks: [[{ id: "a", sides: 4 }], [{ id: "b" }], [{ id: "c", sides: 0 }]],
    }));
    const items = [];
    for await (const item of make().stream("shapes.watch", { kind: "square" })) items.push(item);
    expect(items.map((i) => i.kind)).toEqual(["item", "decode-error", "item"]);
    expect(items[0]?.kind === "item" && items[0].value.sides).toBe(4);
    expect(items[1]?.kind === "decode-error" && items[1].error.raw).toEqual({ id: "b" });
  });

  it("checks scopes locally when they are known", async () => {
    scopes = ["orchestration:read"];
    const client = make();
    const error = await client
      .call("shapes.area", { width: 1, height: 1 })
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(T3AuthError); // scope present; fails later on unknown tag
    const iterator = client.stream("shapes.watch", { kind: "circle" })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({
      code: "insufficient_scope",
      requiredScope: "orchestration:operate",
    });
    scopes = undefined;
    server.handle("shapes.watch", () => ({ kind: "stream", chunks: [] }));
    const items = [];
    for await (const item of client.stream("shapes.watch", { kind: "circle" })) items.push(item);
    expect(items).toEqual([]);
  });

  it("callRaw and streamRaw bypass the table", async () => {
    server.respond("anything", { ok: 1 });
    server.handle("anything.stream", () => ({ kind: "stream", chunks: [["x"]] }));
    const client = make();
    await expect(client.callRaw("anything", { any: "thing" })).resolves.toEqual({ ok: 1 });
    const raw = [];
    for await (const v of client.streamRaw("anything.stream", {})) raw.push(v);
    expect(raw).toEqual(["x"]);
    expect(client.has("anything")).toBe(false);
    expect(client.has("shapes.area")).toBe(true);
  });
});
