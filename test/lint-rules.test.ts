// ---
// relationships:
//   verifies: repository-conventions
// ---
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ESLint } from "eslint";
import { afterEach, describe, expect, it } from "vitest";

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
): Promise<readonly ESLint.LintResult[]> {
  const filePath = join(process.cwd(), "src", `lint-probe-${randomUUID()}.ts`);
  temporaryFiles.push(filePath);
  await writeFile(filePath, source);

  const eslint = new ESLint({ cwd: process.cwd() });
  return eslint.lintFiles([filePath]);
}

describe("source restrictions", () => {
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
    ['void import("child_process");', "no-restricted-syntax"],
    ['require("node:child_process");', "no-restricted-syntax"],
  ])("rejects source that uses a shell module", async (source, ruleId) => {
    const results = await lintSource(source);

    expect(
      results
        .flatMap((result) => result.messages)
        .map((message) => message.ruleId),
    ).toContain(ruleId);
  });
});
