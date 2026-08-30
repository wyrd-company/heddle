// ---
// relationships:
//   verifies: heddle
// ---

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { builtInSystemPrompt } from "../control-plane/index.js";
import { configurationDirectorySystemPromptResolver } from "./system-prompt.js";

describe("configuration-directory system prompt", () => {
  let root = "";

  afterEach(async () => {
    if (root !== "") await rm(root, { force: true, recursive: true });
  });

  it("falls back to the bundled prompt when heddle.md is absent", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-system-prompt-"));

    await expect(
      configurationDirectorySystemPromptResolver(root)(),
    ).resolves.toBe(builtInSystemPrompt);
  });

  it("reads the operator override wholesale without adding provenance", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-system-prompt-"));
    const override = "# Operator guidance\n\nUse the configured workflow.";
    await writeFile(join(root, "heddle.md"), override);

    const resolved = await configurationDirectorySystemPromptResolver(root)();

    expect(resolved).toBe(override);
    expect(resolved).not.toContain(root);
    expect(resolved).not.toContain("heddle.md");
    expect(resolved).not.toContain("Heddle stage session");
  });

  it("fails closed when heddle.md exists but cannot be read as a file", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-system-prompt-"));
    await mkdir(join(root, "heddle.md"));

    await expect(
      configurationDirectorySystemPromptResolver(root)(),
    ).rejects.toThrow("System prompt override");
  });
});
