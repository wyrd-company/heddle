import { describe, expect, it } from "vitest";
import { T3InterruptedError, T3RpcDefectError, T3RpcError } from "../errors.js";
import { exitToError, normalizeExit } from "./exit.js";

describe("normalizeExit", () => {
  it("maps Success", () => {
    expect(normalizeExit({ _tag: "Success", value: 1 })).toEqual({ kind: "success", value: 1 });
  });

  it("prefers Fail over Die over Interrupt", () => {
    expect(
      normalizeExit({
        _tag: "Failure",
        cause: [
          { _tag: "Interrupt", fiberId: 1 },
          { _tag: "Die", defect: "d" },
          { _tag: "Fail", error: { _tag: "E", message: "m" } },
        ],
      }),
    ).toEqual({ kind: "fail", error: { _tag: "E", message: "m" } });
    expect(
      normalizeExit({
        _tag: "Failure",
        cause: [
          { _tag: "Interrupt", fiberId: 1 },
          { _tag: "Die", defect: "d" },
        ],
      }),
    ).toEqual({ kind: "die", defect: "d" });
    expect(
      normalizeExit({ _tag: "Failure", cause: [{ _tag: "Interrupt", fiberId: null }] }),
    ).toEqual({ kind: "interrupt" });
  });

  it("treats an empty cause as a defect and wraps untagged Fail errors", () => {
    expect(normalizeExit({ _tag: "Failure", cause: [] }).kind).toBe("die");
    expect(normalizeExit({ _tag: "Failure", cause: [{ _tag: "Fail", error: "plain" }] })).toEqual({
      kind: "fail",
      error: { _tag: "UnknownError", value: "plain" },
    });
  });
});

describe("exitToError", () => {
  it("maps each outcome to its T3Error", () => {
    const fail = exitToError(
      { kind: "fail", error: { _tag: "OrchestrationDispatchCommandError", message: "bad" } },
      "m",
    );
    expect(fail).toBeInstanceOf(T3RpcError);
    expect((fail as T3RpcError).tag).toBe("OrchestrationDispatchCommandError");
    expect(fail.message).toContain("bad");
    const die = exitToError({ kind: "die", defect: "Missing key" }, "m");
    expect(die).toBeInstanceOf(T3RpcDefectError);
    expect((die as T3RpcDefectError).defect).toBe("Missing key");
    expect(exitToError({ kind: "interrupt" }, "m")).toBeInstanceOf(T3InterruptedError);
  });
});
