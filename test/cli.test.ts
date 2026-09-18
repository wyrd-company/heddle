// ---
// relationships:
//   verifies: blueprint-authoring
// ---
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runCli, type CliIo } from "../src/cli-runner.js";
import { parseStartOverrides, runConfiguredCli } from "../src/binding/cli.js";
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

async function captureConfigured(arguments_: readonly string[]): Promise<{
  readonly errors: string[];
  readonly exitCode: number;
  readonly output: string[];
}> {
  const errors: string[] = [];
  const output: string[] = [];
  const io: CliIo = {
    error: (message) => errors.push(message),
    output: (message) => output.push(message),
  };

  return {
    errors,
    exitCode: await runConfiguredCli(arguments_, io),
    output,
  };
}

const startOptions = [
  ["--config", "/example/config.yml"],
  ["--state", "/example/state"],
  ["--database", "/example/store.sqlite"],
  ["--poll-interval", "41000"],
  ["--github-app-credentials", "/example/credentials.yml"],
  ["--t3-token", "/example/token"],
  ["--webhook-secret", "/example/secret"],
] as const;

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

  it("keeps hook as a non-operational skeleton", () => {
    const arguments_ = ["hook", "stop"];
    const result = capture(arguments_);

    expect(result.exitCode).not.toBe(0);
    expect(result.errors.join("\n")).toContain("not implemented yet");
  });

  it("lists and exports the embedded blueprint authoring skill", () => {
    const root = mkdtempSync(join(tmpdir(), "heddle-skill-"));
    try {
      expect(capture(["skill", "list"])).toEqual({
        exitCode: 0,
        errors: [],
        output: ["blueprint-authoring"],
      });
      const result = capture(["skill", "export", "blueprint-authoring", root]);
      expect(result).toEqual({ exitCode: 0, errors: [], output: [] });
      const skill = readFileSync(
        join(root, "blueprint-authoring", "SKILL.md"),
        "utf8",
      );
      expect(skill).toContain("name: blueprint-authoring");
      expect(skill).toContain("heddle validate --json");
      expect(
        readFileSync(
          join(
            root,
            "blueprint-authoring",
            "references",
            "blueprint-author-reference.md",
          ),
          "utf8",
        ),
      ).toContain("## Node types");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    expect(result.output.join("\n")).toContain(
      "Entry is declared only when every node has an incoming edge, and names an authored node.",
    );
    expect(result.output.join("\n")).toContain("policy.schema");
    expect(result.output.join("\n")).toContain("policy.rule-id");
    expect(result.output.join("\n")).toContain("policy.fallback-order");
    expect(result.output.join("\n")).toContain("requires.issue.stage-name");
  });
});

describe("start options", () => {
  it.each(startOptions)(
    "rejects a missing %s value as usage error",
    async (flag) => {
      const result = await captureConfigured(["start", flag]);

      expect(result.exitCode).toBe(2);
      expect(result.output).toEqual([]);
      expect(result.errors).toEqual([
        `${flag} requires a value`,
        expect.stringContaining("Usage: heddle start"),
      ]);
    },
  );

  it.each(startOptions)(
    "rejects a flag-shaped %s value as usage error",
    async (flag) => {
      const result = await captureConfigured(["start", flag, "--other"]);

      expect(result.exitCode).toBe(2);
      expect(result.output).toEqual([]);
      expect(result.errors).toEqual([
        `${flag} requires a value that does not start with '-'`,
        expect.stringContaining("Usage: heddle start"),
      ]);
    },
  );

  it.each(startOptions)(
    "rejects duplicate singleton option %s",
    async (flag, value) => {
      const result = await captureConfigured([
        "start",
        flag,
        value,
        flag,
        value,
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.output).toEqual([]);
      expect(result.errors).toEqual([
        `Duplicate heddle start option: ${flag}`,
        expect.stringContaining("Usage: heddle start"),
      ]);
    },
  );

  it.each([
    [["--other", "value"], "Unknown heddle start option: --other"],
    [["config.yml"], "Expected a heddle start option, received: config.yml"],
  ] as const)(
    "rejects invalid option input %#",
    async (arguments_, message) => {
      const result = await captureConfigured(["start", ...arguments_]);

      expect(result.exitCode).toBe(2);
      expect(result.output).toEqual([]);
      expect(result.errors).toEqual([
        message,
        expect.stringContaining("Usage: heddle start"),
      ]);
    },
  );

  it("preserves defaults and every documented override", () => {
    expect(parseStartOverrides([])).toEqual({});
    expect(parseStartOverrides(startOptions.flat())).toEqual({
      configPath: "/example/config.yml",
      stateDirectory: "/example/state",
      databasePath: "/example/store.sqlite",
      pollingIntervalMs: 41000,
      githubCredentialFile: "/example/credentials.yml",
      t3TokenFile: "/example/token",
      webhookSecretFile: "/example/secret",
    });
  });

  it("rejects an invalid polling interval as usage error", async () => {
    const result = await captureConfigured([
      "start",
      "--poll-interval",
      "invalid",
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.errors).toEqual([
      "--poll-interval must be a positive integer",
      expect.stringContaining("Usage: heddle start"),
    ]);
  });
});
