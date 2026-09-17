// ---
// relationships:
//   verifies: blueprint-authoring
// ---
import { describe, expect, it } from "vitest";

import { runCli, type CliIo } from "../src/cli-runner.js";

function capture(arguments_: readonly string[]): {
  readonly errors: string[];
  readonly exitCode: number;
  readonly output: string[];
} {
  const errors: string[] = [];
  const output: string[] = [];
  const io: CliIo = {
    error: (message) => errors.push(message),
    output: (message) => output.push(message),
  };

  return { errors, exitCode: runCli(arguments_, io), output };
}

describe("command help", () => {
  it("lists every command", () => {
    const result = capture(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.output.join("\n")).toMatch(/\bstart\b/);
    expect(result.output.join("\n")).toMatch(/\bvalidate\b/);
    expect(result.output.join("\n")).toMatch(/\bskill\b/);
    expect(result.output.join("\n")).toMatch(/\bhook\b/);
  });

  it.each(["start", "validate", "skill", "hook"])(
    "prints %s usage without running the command",
    (command) => {
      const result = capture([command, "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.output).toEqual([
        expect.stringContaining(`Usage: heddle ${command}`),
      ]);
    },
  );
});

describe("command arguments", () => {
  it("prints root usage when no command is given", () => {
    const result = capture([]);

    expect(result.exitCode).not.toBe(0);
    expect(result.errors.join("\n")).toContain("Usage: heddle <command>");
  });

  it.each(["start", "validate", "skill", "hook"])(
    "prints %s usage and fails when required input is absent",
    (command) => {
      const result = capture([command]);

      expect(result.exitCode).not.toBe(0);
      expect(result.errors).toEqual([
        expect.stringContaining(`Usage: heddle ${command}`),
      ]);
    },
  );

  it.each(["unknown", "toString", "constructor", "__proto__"])(
    "rejects unknown command %s",
    (command) => {
      const result = capture([command]);

      expect(result.exitCode).not.toBe(0);
      expect(result.errors.join("\n")).toContain(`Unknown command: ${command}`);
      expect(result.errors.join("\n")).toContain("Usage: heddle <command>");
    },
  );

  it("rejects help for an inherited prototype name", () => {
    const result = capture(["toString", "--help"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toEqual([]);
    expect(result.errors.join("\n")).toContain("Unknown command: toString");
  });

  it.each([
    ["validate", "fixture.yml"],
    ["skill", "list"],
    ["hook", "stop"],
  ])("keeps %s as a non-operational skeleton", (...arguments_) => {
    const result = capture(arguments_);

    expect(result.exitCode).not.toBe(0);
    expect(result.errors.join("\n")).toContain("not implemented yet");
  });
});
