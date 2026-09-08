// ---
// relationships:
//   verifies: heddle
// ---

import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

  it("refuses a live board reached by a path that only normalizes to it", () => {
    // Shares no prefix with the live board until it is resolved, so only
    // normalization can catch it.
    expect(() =>
      assertQualificationIsolation({
        ...safeSurface,
        boardDirectory: "/workspaces/tools/../kanban",
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

  it("gives each native row only its selected provider credential store", async () => {
    const directory = resolve(".devcontainer/driver-qualification");
    const expected = {
      "claude-code": [
        "${localEnv:HOME}/.claude",
        "${localEnv:HOME}/.claude.json",
      ],
      codex: ["${localEnv:HOME}/.codex"],
      cursor: ["${localEnv:HOME}/.cursor"],
      grok: ["${localEnv:HOME}/.grok"],
      opencode: [
        "${localEnv:HOME}/.config/opencode",
        "${localEnv:HOME}/.local/share/opencode",
      ],
    } as const;

    for (const [driver, sources] of Object.entries(expected)) {
      const configuration = JSON.parse(
        await readFile(join(directory, driver, "devcontainer.json"), "utf8"),
      ) as { mounts?: string[] };
      const credentialMounts = (configuration.mounts ?? []).filter((mount) =>
        mount.includes("target=/run/heddle-credentials/"),
      );
      expect(
        credentialMounts.map((mount) => mount.match(/^source=([^,]+)/)?.[1]),
        driver,
      ).toEqual(sources);
      expect(
        credentialMounts.every((mount) => mount.endsWith(",readonly")),
        driver,
      ).toBe(true);
    }

    const common = await readFile(join(directory, "devcontainer.json"), "utf8");
    expect(common).not.toContain("heddle-credentials");
    expect(common).not.toContain("localEnv:HOME");
  });
});
