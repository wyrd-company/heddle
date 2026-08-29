// ---
// relationships:
//   validates: heddle
// ---

import { describe, expect, it } from "vitest";

import { consoleClient, consolePage, consoleStyles } from "./page.js";

const colorToken = (name: string): string => {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, "i").exec(
    consoleStyles,
  );
  if (match?.[1] === undefined) throw new Error(`missing color token ${name}`);
  return match[1];
};

const relativeLuminance = (hex: string): number => {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);
  if (channels === undefined || channels.length !== 3) {
    throw new Error(`invalid color ${hex}`);
  }
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
};

const contrastRatio = (first: string, second: string): number => {
  const [lighter, darker] = [
    relativeLuminance(first),
    relativeLuminance(second),
  ].sort((left, right) => right - left);
  return (lighter! + 0.05) / (darker! + 0.05);
};

describe("console page state", () => {
  it("clears stale projection and scope state when a scoped reload fails", () => {
    expect(consoleClient).toMatch(
      /const renderLoadFailure = \(error\) => \{\s*scopeElement\.selectedIndex = -1;\s*boardElement\.replaceChildren\(\);\s*graphCanvasElement\.replaceChildren\(\);\s*lifecycleTaskElement\.textContent = "";\s*attentionListElement\.replaceChildren\(\);\s*statusElement\.dataset\.error = "true";\s*statusElement\.textContent = error instanceof Error \? error\.message : "Console load failed";\s*\};/,
    );
    expect(consoleClient).toMatch(
      /catch \(error\) \{\s*if \(generation !== loadGeneration\) return;\s*window\.heddleLifecycleViewer\?\.clear\(\);\s*renderLoadFailure\(error\);\s*\}/,
    );
  });

  it("binds graph scope and lifecycle navigation to the URL contract", () => {
    expect(consoleClient).toContain(
      'fetchJson("/api/dependency-graph?scope=" + encodeURIComponent(requestedScope))',
    );
    expect(consoleClient).toContain(
      'link.href = consoleUrl("lifecycle", "task:" + node.id)',
    );
    expect(consoleClient).toContain(
      'url.searchParams.set("scope", scopeElement.value)',
    );
    expect(consolePage).toContain(
      '<ul class="graph-legend" aria-label="Node status legend">',
    );
    for (const treatment of ["done", "running", "attention", "blocked"]) {
      expect(consolePage).toContain(`data-treatment="${treatment}"`);
      expect(consoleStyles).toContain(
        `.graph-node[data-treatment="${treatment}"]`,
      );
    }
    expect(consoleStyles).toMatch(
      /\.graph-edge\[data-trace="true"\] \{[^}]*stroke: var\(--signal\);[^}]*stroke-width: 4;[^}]*\}/,
    );
    expect(consoleStyles).toMatch(
      /\.graph-edge \{[^}]*marker-end: url\(#dependency-arrow\);[^}]*\}/,
    );
    expect(consoleClient).toContain('id: "dependency-arrow"');
    expect(consoleClient).toContain('fill: "context-stroke"');
    expect(consoleStyles).toMatch(
      /\.graph-viewport \{[^}]*overflow: auto;[^}]*\}/,
    );
    expect(consoleStyles).toMatch(
      /\.graph-canvas \{[^}]*position: relative;[^}]*\}/,
    );
  });

  it("binds bounded node height to row spacing and edge anchors", () => {
    const geometryHeight = /const graphNodeHeight = ([0-9]+);/.exec(
      consoleClient,
    )?.[1];
    const renderedHeight =
      /\.graph-node \{[^}]*height: ([0-9]+)px;[^}]*\}/.exec(consoleStyles)?.[1];

    expect(geometryHeight).toBe("126");
    expect(renderedHeight).toBe(geometryHeight);
    expect(consoleStyles).toMatch(
      /\.graph-node \{[^}]*box-sizing: border-box;[^}]*overflow: hidden;[^}]*\}/,
    );
    expect(consoleStyles).toMatch(
      /\.graph-node-title \{[^}]*-webkit-line-clamp: 3;[^}]*overflow: hidden;[^}]*\}/,
    );
    expect(consoleClient).toContain(
      "node.row * (graphNodeHeight + graphRowGap)",
    );
    expect(consoleClient).toContain(
      "const startY = from.y + graphNodeHeight / 2",
    );
    expect(consoleClient).toContain("const endY = to.y + graphNodeHeight / 2");
    expect(consoleClient).toContain('link.setAttribute("title", node.title)');
  });
});

describe("console page accessibility", () => {
  it("uses nameable roles for the labelled attention and board nodes", () => {
    expect(consolePage).toContain(
      '<span class="attention-count" id="attention-count" role="status" aria-label="Attention items">0</span>',
    );
    expect(consolePage).toContain(
      '<div id="board" class="board" role="region" aria-label="Kanban board" tabindex="0"></div>',
    );
    expect(consolePage).toContain(
      '<div id="graph-viewport" class="graph-viewport" role="region" aria-label="Task dependency graph" tabindex="0">',
    );
    expect(consolePage).toContain(
      '<section id="lifecycle-view" class="lifecycle-view" aria-labelledby="lifecycle-view-title" hidden>',
    );
    expect(consoleStyles).toMatch(
      /\.board:focus-visible \{[^}]*outline: 2px solid var\(--signal-focus\);[^}]*\}/,
    );
    expect(consoleStyles).toMatch(
      /\.graph-viewport:focus-visible \{[^}]*outline: 2px solid var\(--signal-focus\);[^}]*\}/,
    );
  });

  it("keeps every small signal and muted text pairing at WCAG AA contrast", () => {
    const paper = colorToken("paper");
    const paperRaised = colorToken("paper-raised");
    const ink = colorToken("ink");
    const signal = colorToken("signal");
    const signalOnDark = colorToken("signal-on-dark");
    const signalFocus = colorToken("signal-focus");
    const deferred = colorToken("deferred");
    const muted = colorToken("muted");

    expect(contrastRatio(signal, paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(signalOnDark, ink)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(muted, paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(muted, paperRaised)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(paperRaised, signal)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(paperRaised, deferred)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(signalFocus, ink)).toBeGreaterThanOrEqual(3);
  });

  it("binds accessible tokens to the rendered small-text and focus rules", () => {
    expect(consoleStyles).toMatch(
      /\.attention-count \{[^}]*color: var\(--paper-raised\);[^}]*background: var\(--signal\);[^}]*\}/,
    );
    expect(consoleStyles).toMatch(
      /\.eyebrow, \.scope-control span \{[^}]*color: var\(--signal\);[^}]*\}/,
    );
    expect(consoleStyles).toMatch(
      /\.attention-header \.eyebrow \{[^}]*color: var\(--signal-on-dark\);[^}]*\}/,
    );
    expect(consoleStyles).toMatch(
      /\.console-status \{[^}]*color: var\(--muted\);[^}]*\}/,
    );
    expect(consoleStyles).toMatch(
      /\.card-meta \{[^}]*color: var\(--muted\);[^}]*\}/,
    );
    expect(consoleStyles).toMatch(
      /\.deferral-readout \{[^}]*color: var\(--paper-raised\);[^}]*background: var\(--deferred\);[^}]*\}/,
    );
    expect(consoleStyles).toMatch(
      /\.epic-lever:hover, \.epic-lever:focus-visible \{[^}]*outline: 2px solid var\(--signal-focus\);[^}]*\}/,
    );
  });
});
