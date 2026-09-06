// ---
// relationships:
//   verifies: heddle
//   references: flowcraft-gate
// ---

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("lifecycle blueprint editor contract", () => {
  it("gives the bare tldraw editor an interactive select tool", async () => {
    const source = await readFile(
      "src/console/lifecycle-canvas-surface.tsx",
      "utf8",
    );
    const viewer = await readFile("src/console/lifecycle-viewer.tsx", "utf8");

    expect(source).toContain('initialState="select"');
    expect(source).toContain("tools={defaultTools}");
    expect(source).toContain("<TldrawEditor");
    expect(source).not.toContain("<Tldraw ");
    expect(
      viewer.indexOf("editor.updateInstanceState({ isReadonly: false })"),
    ).toBeLessThan(
      viewer.indexOf(
        "sync.applyBlueprint(editing.blueprint, editing.positions)",
      ),
    );
  });

  it("offers local read-only navigation and observes canvas resizes", async () => {
    const source = await readFile(
      "src/console/lifecycle-canvas-surface.tsx",
      "utf8",
    );
    const navigation = await readFile(
      "src/console/lifecycle-canvas-navigation.tsx",
      "utf8",
    );

    expect(source).toContain('aria-label="Lifecycle canvas controls"');
    expect(source).toContain('aria-label="Zoom out"');
    expect(source).toContain('aria-label="Zoom in"');
    expect(source).toContain('title="Fit readable graph"');
    expect(source).toContain('title="Focus current stage"');
    expect(source).toContain("new ResizeObserver(frame)");
    expect(navigation).toContain("MIN_READABLE_NODE_SCALE");
    expect(navigation).toContain("editor.setCameraOptions");
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

  it("invalidates artifact and rebase responses when the lifecycle selection changes", async () => {
    const source = await readFile("src/console/lifecycle-viewer.tsx", "utf8");

    expect(source).toContain(
      "const generation = ++editRequestGeneration.current;",
    );
    expect(
      source.match(
        /if \(generation !== editRequestGeneration\.current\) return;/g,
      ),
    ).toHaveLength(4);
    expect(
      source.match(
        /if \(generation !== rebaseRequestGeneration\.current\) return;/g,
      ),
    ).toHaveLength(2);
    expect(source).toMatch(
      /clear: \(\) => \{\s*resetEditing\(\);\s*resetRebase\(\);\s*snapshotRef\.current = null;/,
    );
    const replaceStart = source.indexOf("const replace = useCallback");
    const replaceReset = source.indexOf("resetEditing();", replaceStart);
    const replaceRebaseReset = source.indexOf("resetRebase();", replaceStart);
    const replaceSnapshot = source.indexOf(
      "snapshotRef.current = next;",
      replaceStart,
    );
    expect(replaceStart).toBeGreaterThan(-1);
    expect(replaceReset).toBeGreaterThan(replaceStart);
    expect(replaceReset).toBeLessThan(replaceSnapshot);
    expect(replaceRebaseReset).toBeGreaterThan(replaceReset);
    expect(replaceRebaseReset).toBeLessThan(replaceSnapshot);
  });
});
