import { describe, expect, it, vi } from "vitest";
import { T3ConnectionError } from "../errors.js";
import type { Logger } from "../internal/logger.js";
import { decodeServerFrame, encodeClientEnvelope, requestEnvelope } from "./envelope.js";

const logger = (): Logger & { warnings: string[] } => {
  const warnings: string[] = [];
  return { warnings, debug() {}, info() {}, error() {}, warn: (m) => void warnings.push(m) };
};

describe("decodeServerFrame", () => {
  it("decodes a single envelope and an array of envelopes", () => {
    const single = decodeServerFrame('{"_tag":"Pong"}');
    expect(single).toEqual([{ _tag: "Pong" }]);
    const many = decodeServerFrame(
      JSON.stringify([
        { _tag: "Chunk", requestId: "1", values: [1, 2] },
        { _tag: "Exit", requestId: 1, exit: { _tag: "Success", value: { ok: true } } },
      ]),
    );
    expect(many).toEqual([
      { _tag: "Chunk", requestId: "1", values: [1, 2] },
      { _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: { ok: true } } },
    ]);
  });

  it("decodes every failure cause shape and a Defect", () => {
    const [exit] = decodeServerFrame(
      JSON.stringify({
        _tag: "Exit",
        requestId: "9",
        exit: {
          _tag: "Failure",
          cause: [
            { _tag: "Fail", error: { _tag: "SomeError", message: "no" } },
            { _tag: "Die", defect: 'Missing key\n  at ["x"]' },
            { _tag: "Interrupt", fiberId: 797 },
          ],
        },
      }),
    );
    expect(exit?._tag).toBe("Exit");
    const [defect] = decodeServerFrame('{"_tag":"Defect","defect":{"message":"boom"}}');
    expect(defect).toEqual({ _tag: "Defect", defect: { message: "boom" } });
  });

  it("accepts a Success exit without a value key (Stream<void>)", () => {
    const [exit] = decodeServerFrame('{"_tag":"Exit","requestId":"1","exit":{"_tag":"Success"}}');
    expect(exit).toEqual({ _tag: "Exit", requestId: "1", exit: { _tag: "Success" } });
  });

  it("keeps unknown keys on known envelopes", () => {
    const [chunk] = decodeServerFrame('{"_tag":"Chunk","requestId":"1","values":[],"extra":1}');
    expect(chunk).toMatchObject({ extra: 1 });
  });

  it("skips unknown tags and untagged records with a warning", () => {
    const log = logger();
    const out = decodeServerFrame(
      JSON.stringify([{ _tag: "Future" }, { nope: 1 }, { _tag: "Pong" }]),
      log,
    );
    expect(out).toEqual([{ _tag: "Pong" }]);
    expect(log.warnings).toHaveLength(2);
  });

  it("throws a protocol T3ConnectionError on a malformed known tag", () => {
    const malformed = [
      '{"_tag":"Chunk","requestId":"1"}',
      '{"_tag":"Chunk","values":[]}',
      '{"_tag":"Exit","requestId":"1"}',
      '{"_tag":"Exit","requestId":"1","exit":{"_tag":"Failure"}}',
      '[{"_tag":"Pong"},{"_tag":"Exit","requestId":"1","exit":{"_tag":"Success"},"x":1},{"_tag":"Chunk"}]',
    ];
    for (const frame of malformed) {
      const error = (() => {
        try {
          decodeServerFrame(frame);
          return undefined;
        } catch (e) {
          return e;
        }
      })();
      expect(error, frame).toBeInstanceOf(T3ConnectionError);
      expect((error as T3ConnectionError).reason).toBe("protocol");
    }
    expect(decodeServerFrame('{"_tag":"Defect"}')).toEqual([{ _tag: "Defect" }]);
  });

  it("throws a protocol T3ConnectionError on invalid JSON", () => {
    expect(() => decodeServerFrame("{nope")).toThrowError(T3ConnectionError);
    try {
      decodeServerFrame("{nope");
    } catch (error) {
      expect(error).toBeInstanceOf(T3ConnectionError);
      expect((error as T3ConnectionError).reason).toBe("protocol");
    }
  });
});

describe("encodeClientEnvelope", () => {
  it("always includes headers on a Request", () => {
    const text = encodeClientEnvelope(requestEnvelope("1", "server.probe", {}));
    expect(JSON.parse(text)).toEqual({
      _tag: "Request",
      id: "1",
      tag: "server.probe",
      payload: {},
      headers: [],
    });
    expect(encodeClientEnvelope({ _tag: "Ack", requestId: "1" })).toBe(
      '{"_tag":"Ack","requestId":"1"}',
    );
    vi.restoreAllMocks();
  });
});
