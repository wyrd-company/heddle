// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import {
  heddleSessionTitle,
  MAXIMUM_HEDDLE_TITLE_LENGTH,
} from "./session-title.js";

describe("production session title", () => {
  it("contains the Heddle marker", () => {
    expect(heddleSessionTitle(42, "implement")).toContain("Heddle");
  });

  it("contains the complete task identity", () => {
    expect(heddleSessionTitle(424_242, "implement")).toContain("task-424242");
  });

  it("distinguishes stages deterministically", () => {
    const implement = heddleSessionTitle(42, "implement");
    expect(implement).toBe(heddleSessionTitle(42, "implement"));
    expect(implement).not.toBe(heddleSessionTitle(42, "review"));
  });

  it("is bounded independently of the stage input length", () => {
    expect(
      heddleSessionTitle(42, "a".repeat(10_000)).length,
    ).toBeLessThanOrEqual(MAXIMUM_HEDDLE_TITLE_LENGTH);
  });
});
