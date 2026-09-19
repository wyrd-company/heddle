// ---
// relationships:
//   verifies: AGENTS.md
// ---
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ESLint } from "eslint";
import { afterEach, describe, expect, it } from "vitest";

/** Each test lints a synthetic file with a full ESLint run, so allow for a
 * busy machine rather than the runner's default per-test budget. */
const eslintRunTimeout = 60_000;

const temporaryFiles: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryFiles
      .splice(0)
      .map(async (filePath) => rm(filePath, { force: true })),
  );
});

async function lintSource(
  source: string,
  directory = "src",
): Promise<readonly ESLint.LintResult[]> {
  const filePath = join(
    process.cwd(),
    directory,
    `lint-probe-${randomUUID()}.ts`,
  );
  temporaryFiles.push(filePath);
  await writeFile(filePath, source);

  const eslint = new ESLint({ cwd: process.cwd() });
  return eslint.lintFiles([filePath]);
}

describe("source restrictions", { timeout: eslintRunTimeout }, () => {
  it("allows source files with 300 lines", async () => {
    const results = await lintSource(
      Array.from({ length: 300 }, () => "// line").join("\n"),
    );

    expect(
      results
        .flatMap((result) => result.messages)
        .map((message) => message.ruleId),
    ).not.toContain("max-lines");
  });

  it("rejects source files over 300 lines", async () => {
    const results = await lintSource(
      Array.from({ length: 301 }, () => "// line").join("\n"),
    );

    expect(
      results
        .flatMap((result) => result.messages)
        .map((message) => message.ruleId),
    ).toContain("max-lines");
  });

  it("does not count comments toward the T3 Code module line limit", async () => {
    const results = await lintSource(
      Array.from({ length: 301 }, () => "// contract").join("\n"),
      "src/t3code",
    );

    expect(
      results
        .flatMap((result) => result.messages)
        .map((message) => message.ruleId),
    ).not.toContain("max-lines");
  });

  it("still rejects T3 Code source over 300 non-comment lines", async () => {
    const results = await lintSource(
      Array.from({ length: 301 }, () => "void 0;").join("\n"),
      "src/t3code",
    );

    expect(
      results
        .flatMap((result) => result.messages)
        .map((message) => message.ruleId),
    ).toContain("max-lines");
  });

  it.each(["child_process", "node:child_process"])(
    "rejects imports from %s",
    async (moduleName) => {
      const results = await lintSource(`import ${JSON.stringify(moduleName)};`);

      expect(
        results
          .flatMap((result) => result.messages)
          .map((message) => message.ruleId),
      ).toContain("no-restricted-imports");
    },
  );

  it.each([
    'void import("child_process");',
    "void import(`child_process`);",
    'require("node:child_process");',
    'createRequire(import.meta.url)("child_process");',
    'process.getBuiltinModule("node:child_process");',
    'module.require("child_process");',
  ])("rejects shell access form: %s", async (source) => {
    const results = await lintSource(source);

    expect(
      results
        .flatMap((result) => result.messages)
        .map((message) => message.ruleId),
    ).toContain("no-restricted-syntax");
  });
});
