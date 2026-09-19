import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeT3Server } from "../../test/support/fake-server.js";
import { T3ConnectionError, T3InterruptedError, T3RpcDefectError, T3RpcError } from "../errors.js";
import { RpcConnection } from "./rpc-connection.js";
import { SocketTransport } from "./socket.js";

const until = async (check: () => boolean, ms = 3_000): Promise<void> => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("Timed out.");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("RpcConnection", () => {
  let server: FakeT3Server;
  let rpc: RpcConnection;
  let ids: number;

  beforeEach(async () => {
    server = await FakeT3Server.start();
    ids = 0;
    rpc = new RpcConnection(
      new SocketTransport({
        url: async () => server.wsUrl,
        backoff: { initialMs: 10, factor: 1, maxMs: 10 },
      }),
      { idGenerator: () => String(++ids) },
    );
  });
  afterEach(async () => {
    await rpc.close();
    await server.close();
  });

  it("connects lazily and resolves a unary call", async () => {
    server.handle("server.probe", (payload) => ({ kind: "value", value: { echo: payload } }));
    expect(server.connections).toHaveLength(0);
    await expect(rpc.call("server.probe", { a: 1 })).resolves.toEqual({ echo: { a: 1 } });
    expect(server.lastConnection.received[0]).toEqual({
      _tag: "Request",
      id: "1",
      tag: "server.probe",
      payload: { a: 1 },
      headers: [],
    });
  });

  it("rejects with T3RpcError on Fail, T3RpcDefectError on Die and on an unknown tag", async () => {
    server.handle("x.fail", () => ({
      kind: "fail",
      error: { _tag: "SomeError", message: "nope" },
    }));
    server.handle("x.die", () => ({ kind: "die", defect: 'Missing key\n  at ["threadId"]' }));
    await expect(rpc.call("x.fail", {})).rejects.toMatchObject({
      code: "rpc_failed",
      tag: "SomeError",
    });
    const die = await rpc.call("x.die", {}).catch((e: unknown) => e);
    expect(die).toBeInstanceOf(T3RpcDefectError);
    expect((die as T3RpcDefectError).defect).toContain("Missing key");
    await expect(rpc.call("no.such", {})).rejects.toMatchObject({
      code: "rpc_defect",
      defect: "Unknown request tag: no.such",
    });
    const fail = await rpc.call("x.fail", {}).catch((e: unknown) => e);
    expect(fail).toBeInstanceOf(T3RpcError);
  });

  it("streams chunk values and acks a chunk only after the consumer drained it", async () => {
    server.handle("s", () => ({ kind: "stream", chunks: [[1, 2], [3], [4, 5]] }));
    const seen: unknown[] = [];
    for await (const value of rpc.stream("s", {})) {
      seen.push(value);
      if (value === 2) {
        // Chunk 2 must not have been sent before our Ack for chunk 1.
        const conn = server.lastConnection;
        expect(conn.sent.filter((e) => e["_tag"] === "Chunk")).toHaveLength(1);
      }
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    const conn = server.lastConnection;
    expect(conn.acks).toEqual(["1", "1", "1"]);
    const order = conn.log.map((e) => `${e.direction}:${String(e.envelope["_tag"])}`);
    expect(order).toEqual([
      "in:Request",
      "out:Chunk",
      "in:Ack",
      "out:Chunk",
      "in:Ack",
      "out:Chunk",
      "in:Ack",
      "out:Exit",
    ]);
  });

  it("acks early when highWaterMark allows buffering", async () => {
    server.handle("s", () => ({ kind: "stream", chunks: [[1, 2, 3], [4]] }));
    const iterator = rpc.stream("s", {}, { highWaterMark: 5 })[Symbol.asyncIterator]();
    await iterator.next();
    await until(() => server.lastConnection.sent.filter((e) => e["_tag"] === "Exit").length === 1);
    expect(server.lastConnection.acks).toEqual(["1", "1"]);
    await iterator.return?.();
  });

  it("ends a stream with the Exit error", async () => {
    server.handle("s", () => ({
      kind: "stream",
      chunks: [[1]],
      exit: { kind: "fail", error: { _tag: "StreamError" } },
    }));
    const seen: unknown[] = [];
    const error = await (async () => {
      try {
        for await (const v of rpc.stream("s", {})) seen.push(v);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(seen).toEqual([1]);
    expect(error).toBeInstanceOf(T3RpcError);
  });

  it("sends Interrupt on early return and completes", async () => {
    server.handle("s", () => ({ kind: "stream", chunks: [[1], [2], [3]] }));
    for await (const value of rpc.stream("s", {})) {
      if (value === 1) break;
    }
    await until(() => server.lastConnection.interrupts.length === 1);
    expect(server.lastConnection.interrupts).toEqual(["1"]);
    await until(() => server.lastConnection.sent.some((e) => e["_tag"] === "Exit"));
    expect(rpc.inFlight).toBe(0);
  });

  it("sends Interrupt and throws T3InterruptedError when the signal aborts", async () => {
    server.handle("s", () => ({ kind: "stream", chunks: [[1]] }));
    const controller = new AbortController();
    const error = await (async () => {
      try {
        for await (const value of rpc.stream("s", {}, { signal: controller.signal })) {
          if (value === 1) controller.abort();
        }
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(T3InterruptedError);
    await until(() => server.lastConnection.interrupts.length === 1);
    expect(server.lastConnection.interrupts).toEqual(["1"]);
  });

  it("aborts a unary call with Interrupt", async () => {
    server.handle("hang", () => ({ kind: "hang" }));
    const controller = new AbortController();
    const pending = rpc.call("hang", {}, controller.signal);
    await until(
      () => server.connections.length === 1 && server.lastConnection.received.length === 1,
    );
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(T3InterruptedError);
    await until(() => server.lastConnection.interrupts.length === 1);
    expect(server.lastConnection.interrupts).toEqual(["1"]);
    const already = new AbortController();
    already.abort();
    await expect(rpc.call("hang", {}, already.signal)).rejects.toBeInstanceOf(T3InterruptedError);
  });

  it("rejects in-flight calls and ends streams when the socket drops", async () => {
    server.handle("hang", () => ({ kind: "hang" }));
    const pending = rpc.call("hang", {});
    const iterator = rpc.stream("hang", {})[Symbol.asyncIterator]();
    const streamNext = iterator.next();
    await until(
      () => server.connections.length === 1 && server.lastConnection.received.length === 2,
    );
    server.lastConnection.drop();
    await expect(pending).rejects.toMatchObject({ code: "connection", reason: "closed" });
    await expect(streamNext).rejects.toBeInstanceOf(T3ConnectionError);
    // Still usable after the reconnect.
    server.respond("ping", "pong");
    await expect(rpc.call("ping", {})).resolves.toBe("pong");
    expect(server.connections).toHaveLength(2);
  });

  it("fails everything in flight on a connection Defect", async () => {
    server.handle("hang", () => ({ kind: "hang" }));
    const pending = rpc.call("hang", {});
    await until(
      () => server.connections.length === 1 && server.lastConnection.received.length === 1,
    );
    server.lastConnection.send({ _tag: "Defect", defect: { message: "server went away" } });
    await expect(pending).rejects.toMatchObject({ code: "rpc_defect", method: "hang" });
  });

  it("close rejects in-flight calls with closed", async () => {
    server.handle("hang", () => ({ kind: "hang" }));
    const pending = rpc.call("hang", {});
    await until(
      () => server.connections.length === 1 && server.lastConnection.received.length === 1,
    );
    await rpc.close();
    await expect(pending).rejects.toMatchObject({ reason: "closed" });
    await expect(rpc.call("hang", {})).rejects.toMatchObject({ reason: "closed" });
  });

  it("fails in-flight work with a protocol error when a known envelope is malformed", async () => {
    server.handle("hang", () => ({ kind: "hang" }));
    const pending = rpc.call("hang", {});
    const iterator = rpc.stream("hang", {})[Symbol.asyncIterator]();
    const streamNext = iterator.next();
    await until(
      () => server.connections.length === 1 && server.lastConnection.received.length === 2,
    );
    server.lastConnection.sendRaw('{"_tag":"Exit","requestId":"1"}');
    await expect(pending).rejects.toMatchObject({ code: "connection", reason: "protocol" });
    await expect(streamNext).rejects.toMatchObject({ code: "connection", reason: "protocol" });
    expect(rpc.inFlight).toBe(0);
  });

  it("leaves no abort listeners behind on a shared signal", async () => {
    server.respond("unary", "ok");
    server.handle("s", () => ({ kind: "stream", chunks: [[1], [2]] }));
    server.handle("s.fail", () => ({
      kind: "stream",
      chunks: [[1]],
      exit: { kind: "fail", error: { _tag: "StreamError" } },
    }));
    const { signal, live } = countingSignal();

    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i += 1) {
      work.push(rpc.call("unary", {}, signal));
      work.push(
        (async () => {
          for await (const _value of rpc.stream("s", {}, { signal })) {
            // drain
          }
        })(),
      );
      work.push(
        (async () => {
          for await (const _value of rpc.stream("s.fail", {}, { signal })) {
            // drain until the Exit failure
          }
        })().catch(() => undefined),
      );
      work.push(
        (async () => {
          for await (const _value of rpc.stream("s", {}, { signal })) break;
        })(),
      );
    }
    await Promise.all(work);
    expect(live.peak).toBeGreaterThan(0);
    expect(live.size).toBe(0);
  });
});

/** An AbortSignal that tracks which listeners are attached right now. */
function countingSignal(): { signal: AbortSignal; live: Set<unknown> & { peak: number } } {
  const { signal } = new AbortController();
  const live = Object.assign(new Set<unknown>(), { peak: 0 });
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  vi.spyOn(signal, "addEventListener").mockImplementation((type, listener, options) => {
    live.add(listener);
    live.peak = Math.max(live.peak, live.size);
    add(type, listener, options);
  });
  vi.spyOn(signal, "removeEventListener").mockImplementation((type, listener, options) => {
    live.delete(listener);
    remove(type, listener, options);
  });
  return { signal, live };
}
