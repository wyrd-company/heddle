// ---
// relationships:
//   implements: engine-and-run-model
//   references: blueprint
// ---
import { Temporal } from "@js-temporal/polyfill";

export function duration(value: unknown): string | number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return value;
  if (typeof value === "string" && Temporal.Duration.from(value).sign >= 0)
    return value;
  throw new Error("Invalid authored duration");
}
export function dueAt(start: number, duration: string | number): number {
  if (typeof duration === "number") return start + duration;
  return Temporal.Instant.fromEpochMilliseconds(start)
    .toZonedDateTimeISO("UTC")
    .add(Temporal.Duration.from(duration)).epochMilliseconds;
}
