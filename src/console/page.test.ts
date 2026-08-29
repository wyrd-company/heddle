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
      /const renderLoadFailure = \(error\) => \{\s*scopeElement\.selectedIndex = -1;\s*boardElement\.replaceChildren\(\);\s*statusElement\.dataset\.error = "true";\s*statusElement\.textContent = error instanceof Error \? error\.message : "Console load failed";\s*\};/,
    );
    expect(consoleClient).toMatch(
      /catch \(error\) \{\s*renderLoadFailure\(error\);\s*\}/,
    );
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
    expect(consoleStyles).toMatch(
      /\.board:focus-visible \{[^}]*outline: 2px solid var\(--signal-focus\);[^}]*\}/,
    );
  });

  it("keeps every small signal and muted text pairing at WCAG AA contrast", () => {
    const paper = colorToken("paper");
    const paperRaised = colorToken("paper-raised");
    const ink = colorToken("ink");
    const signal = colorToken("signal");
    const signalFocus = colorToken("signal-focus");
    const muted = colorToken("muted");

    expect(contrastRatio(signal, paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(muted, paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(muted, paperRaised)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(paperRaised, signal)).toBeGreaterThanOrEqual(4.5);
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
      /\.console-status \{[^}]*color: var\(--muted\);[^}]*\}/,
    );
    expect(consoleStyles).toMatch(
      /\.card-meta \{[^}]*color: var\(--muted\);[^}]*\}/,
    );
    expect(consoleStyles).toMatch(
      /\.epic-lever:hover, \.epic-lever:focus-visible \{[^}]*outline: 2px solid var\(--signal-focus\);[^}]*\}/,
    );
  });
});
