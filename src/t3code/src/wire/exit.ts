/**
 * Turns a server `Exit` into one outcome and, when it is not a success, into
 * the `T3Error` a caller receives.
 */
import { T3InterruptedError, T3RpcDefectError, T3RpcError } from "../errors.js";
import type { T3Error } from "../errors.js";
import type { ExitEncoded } from "./envelope.js";

export type RpcFailRecord = { readonly _tag: string } & Record<string, unknown>;

export type RpcExitOutcome =
  | { readonly kind: "success"; readonly value: unknown }
  | { readonly kind: "fail"; readonly error: RpcFailRecord }
  | { readonly kind: "die"; readonly defect: unknown }
  | { readonly kind: "interrupt" };

/** First cause wins, with `Fail` preferred over `Die` and `Die` over `Interrupt`. */
export function normalizeExit(exit: ExitEncoded): RpcExitOutcome {
  if (exit._tag === "Success") return { kind: "success", value: exit.value };
  const fail = exit.cause.find((entry) => entry._tag === "Fail");
  if (fail) return { kind: "fail", error: toFailRecord(fail.error) };
  const die = exit.cause.find((entry) => entry._tag === "Die");
  if (die) return { kind: "die", defect: die.defect };
  if (exit.cause.some((entry) => entry._tag === "Interrupt")) return { kind: "interrupt" };
  return { kind: "die", defect: "The server reported a failure without a cause." };
}

function toFailRecord(error: unknown): RpcFailRecord {
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    const tag = record["_tag"];
    if (typeof tag === "string") return record as RpcFailRecord;
    return { ...record, _tag: "UnknownError" };
  }
  return { _tag: "UnknownError", value: error };
}

/** The error for a non-success outcome. `method` names the RPC for the message. */
export function exitToError(
  outcome: Exclude<RpcExitOutcome, { kind: "success" }>,
  method: string,
): T3Error {
  switch (outcome.kind) {
    case "fail":
      return new T3RpcError(method, outcome.error);
    case "die":
      return new T3RpcDefectError(method, outcome.defect);
    case "interrupt":
      return new T3InterruptedError(`${method} was interrupted.`);
  }
}
