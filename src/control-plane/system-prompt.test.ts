// ---
// relationships:
//   verifies: heddle
// ---

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { composeSystemPrompt } from "./handoff-renderer.js";
import { builtInSystemPrompt } from "./system-prompt.js";

describe("system prompt", () => {
  it("bundles the Markdown default into the compiled control-plane module", async () => {
    const source = await readFile("src/control-plane/system-prompt.md", "utf8");
    const metadataBoundary = source.indexOf("\n---\n", 4);
    const compiled = await readFile(
      "dist/control-plane/system-prompt.js",
      "utf8",
    );

    expect(metadataBoundary).toBeGreaterThan(0);
    expect(builtInSystemPrompt).toBe(
      source.slice(metadataBoundary + 5).replace(/^\n/, ""),
    );
    expect(compiled).toContain("# Heddle stage session");
    expect(compiled).not.toContain("system-prompt.md");
    expect(compiled).not.toContain("readFile");
    expect(builtInSystemPrompt).not.toContain("relationships:");
  });

  it("prepends one effective prompt without moving the identity token", () => {
    const prompt = "# Session guidance\n\nUse the workflow tools.";
    const handoff = '---\ncorrelationToken: "sample-token"\n---\n\n# Work';

    const rendered = composeSystemPrompt(prompt, handoff, "sample-token");

    expect(rendered).toBe(`${prompt}\n\n${handoff}`);
    expect(rendered.split("sample-token")).toHaveLength(2);
  });

  it("refuses a prompt that contains the correlation token", () => {
    expect(() =>
      composeSystemPrompt(
        "Use sample-token for access.",
        'correlationToken: "sample-token"',
        "sample-token",
      ),
    ).toThrow("System prompt must not contain the correlation token");
  });
});
