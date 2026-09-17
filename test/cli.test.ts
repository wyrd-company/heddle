// ---
// relationships:
//   verifies: blueprint-authoring
// ---
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { runCli, type CliIo } from "../src/cli-runner.js";
import { validateBlueprintPath } from "../src/blueprints/validate.js";

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
    ["skill", "list"],
    ["hook", "stop"],
  ])("keeps %s as a non-operational skeleton", (...arguments_) => {
    const result = capture(arguments_);

    expect(result.exitCode).not.toBe(0);
    expect(result.errors.join("\n")).toContain("not implemented yet");
  });

  it("validates a blueprint file offline", () => {
    const result = capture([
      "validate",
      resolve("fixtures/blueprints/recipe-pipeline/recipe-pipeline.yml"),
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.output).toEqual([expect.stringContaining("no findings")]);
  });

  it("validates a blueprint directory offline", () => {
    const result = capture(["validate", resolve("fixtures/blueprints")]);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("prints human findings with file, node, and rule", () => {
    const file = resolve(
      "test/fixtures/blueprints/negative/unhandled-pass-result.yml",
    );
    const result = capture(["validate", file]);

    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain(
      `${file}:first [heddle.unhandled-result]`,
    );
  });

  it("emits the same findings as JSON", () => {
    const file = resolve(
      "fixtures/blueprints/recipe-pipeline/recipe-pipeline.yml",
    );
    const result = capture([
      "validate",
      "--json",
      "--check-requires-issue",
      file,
    ]);
    const findings = JSON.parse(result.output.join("\n")) as unknown[];

    expect(result.exitCode).toBe(1);
    expect(result.errors).toEqual([]);
    expect(findings).toContainEqual(
      expect.objectContaining({
        rule: "requires.issue.live",
        node: "$blueprint",
      }),
    );
    expect(findings).toEqual(
      validateBlueprintPath(file, { checkRequiresIssue: true }),
    );
  });

  it("lists the data-driven validation rules", () => {
    const result = capture(["validate", "--rules"]);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.output.join("\n")).toContain("heddle.no-subflow");
    expect(result.output.join("\n")).toContain("requires.issue.stage-name");
  });
});
