// ---
// relationships:
//   verifies: heddle
// ---

import { readdir, readFile } from "node:fs/promises";
import { URL } from "node:url";

import { describe, expect, it } from "vitest";

describe("workflow MCP timeout structure", () => {
  it("keeps every production MCP tool independent of raised harness request timeouts", async () => {
    const directory = new URL("./", import.meta.url);
    const productionSources = (await readdir(directory))
      .filter(
        (name) =>
          name.endsWith(".ts") &&
          !name.endsWith(".test.ts") &&
          !name.endsWith(".integration.test.ts") &&
          !name.endsWith(".test-support.ts"),
      )
      .sort();
    const forbidden = /\b(?:AbortSignal|mcpReq\.signal)\b/;
    const violations: string[] = [];
    for (const name of productionSources) {
      const source = await readFile(new URL(name, directory), "utf8");
      if (forbidden.test(source)) violations.push(name);
    }

    expect(violations).toEqual([]);
  });
});
