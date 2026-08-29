// ---
// relationships:
//   validates: heddle
// ---

import { describe, expect, it } from "vitest";

import { consoleStyles } from "./page.js";

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

describe("console page accessibility", () => {
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
});
