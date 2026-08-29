// ---
// relationships:
//   verifies: heddle
//   references: flowcraft-gate
// ---

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("lifecycle blueprint editor contract", () => {
  it("gives the bare tldraw editor an interactive select tool", async () => {
    const source = await readFile("src/console/lifecycle-viewer.tsx", "utf8");

    expect(source).toContain('initialState="select"');
    expect(source).toContain("tools={defaultTools}");
    expect(
      source.indexOf("editor.updateInstanceState({ isReadonly: false })"),
    ).toBeLessThan(
      source.indexOf(
        "sync.applyBlueprint(editing.blueprint, editing.positions)",
      ),
    );
  });

  it("exposes native keyboard controls and a live save result", async () => {
    const source = await readFile("src/console/lifecycle-viewer.tsx", "utf8");
    const styles = await readFile("src/console/lifecycle-viewer.css", "utf8");

    expect(source).toContain('"SAVE ARTIFACT"');
    expect(source).toContain("onClick={stopEditing}");
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('role="status"');
    expect(styles).toMatch(
      /\.blueprint-editor-actions button:focus-visible \{[^}]*outline: 2px solid #df5a3c;/,
    );
    expect(styles).toContain("flex-wrap: wrap");
  });
});
