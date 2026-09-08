// ---
// relationships:
//   verifies: heddle
// ---

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertQualificationIsolation,
  LIVE_BOARD_DIRECTORY,
  LIVE_T3_PORT,
  QualificationIsolationError,
} from "./driver-qualification.test-support.js";

const scratch = tmpdir();

const safeSurface = {
  boardDirectory: join(scratch, "qualification", "board"),
  port: 41_234,
  stateDirectory: join(scratch, "qualification", "state"),
  t3BaseDirectory: join(scratch, "qualification", "t3-base"),
};

describe("qualification isolation", () => {
  it("accepts a fully scratch-backed surface on an ephemeral port", () => {
    expect(() => assertQualificationIsolation(safeSurface)).not.toThrow();
  });

  it("refuses the operator's live T3 port", () => {
    expect(() =>
      assertQualificationIsolation({ ...safeSurface, port: LIVE_T3_PORT }),
    ).toThrow(QualificationIsolationError);
  });

  it("refuses the operator's live board directory", () => {
    expect(() =>
      assertQualificationIsolation({
        ...safeSurface,
        boardDirectory: LIVE_BOARD_DIRECTORY,
      }),
    ).toThrow(QualificationIsolationError);
  });

  it("refuses a task nested inside the operator's live board", () => {
    expect(() =>
      assertQualificationIsolation({
        ...safeSurface,
        boardDirectory: `${LIVE_BOARD_DIRECTORY}/tasks`,
      }),
    ).toThrow(QualificationIsolationError);
  });

  it("refuses a live board reached through a relative path", () => {
    expect(() =>
      assertQualificationIsolation({
        ...safeSurface,
        boardDirectory: `${LIVE_BOARD_DIRECTORY}/tasks/..`,
      }),
    ).toThrow(QualificationIsolationError);
  });

  it("refuses a T3 base directory outside the scratch root", () => {
    expect(() =>
      assertQualificationIsolation({
        ...safeSurface,
        t3BaseDirectory: "/home/operator/.t3",
      }),
    ).toThrow(QualificationIsolationError);
  });

  it("refuses a state directory outside the scratch root", () => {
    expect(() =>
      assertQualificationIsolation({
        ...safeSurface,
        stateDirectory: "/var/lib/heddle",
      }),
    ).toThrow(QualificationIsolationError);
  });
});
