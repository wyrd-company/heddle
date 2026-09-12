// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import {
  heddleSessionTitle,
  MAXIMUM_SESSION_TITLE_LENGTH,
} from "./session-title.js";

describe("production session title", () => {
  it("uses only the task and stage-occurrence identities", () => {
    expect(heddleSessionTitle(42, "implement-3")).toBe("task-42 · implement-3");
    expect(heddleSessionTitle(42, "implement-3")).not.toMatch(/Heddle|epic-/);
  });

  it("contains the complete task identity", () => {
    expect(heddleSessionTitle(424_242, "implement")).toContain("task-424242");
  });

  it("distinguishes stages deterministically", () => {
    const implement = heddleSessionTitle(42, "implement-1");
    expect(implement).toBe(heddleSessionTitle(42, "implement-1"));
    expect(implement).not.toBe(heddleSessionTitle(42, "implement-2"));
  });

  it("is bounded independently of the stage input length", () => {
    expect(
      heddleSessionTitle(42, "a".repeat(10_000)).length,
    ).toBeLessThanOrEqual(MAXIMUM_SESSION_TITLE_LENGTH);
  });
});
