// ---
// relationships:
//   implements: heddle
// ---

import { BlueprintValidationError } from "./errors.js";
import type { ExpectedLanding, ExpectedLandings } from "./types.js";

const expectedLandingLimit = 255;
const emptyLanding: ExpectedLanding = {
  awaitingNodeIds: [],
  terminalNodeIds: [],
};

const keyFor = (landing: ExpectedLanding): string => JSON.stringify(landing);

const merge = (
  left: ExpectedLanding,
  right: ExpectedLanding,
): ExpectedLanding => ({
  awaitingNodeIds: [
    ...new Set([...left.awaitingNodeIds, ...right.awaitingNodeIds]),
  ].sort(),
  terminalNodeIds: [
    ...new Set([...left.terminalNodeIds, ...right.terminalNodeIds]),
  ].sort(),
});

const assertWithinLimit = (count: number, includesEmpty: boolean): void => {
  if (count - Number(includesEmpty) > expectedLandingLimit) {
    throw new BlueprintValidationError(
      `Blueprint produces more than ${expectedLandingLimit} expected landing alternatives`,
    );
  }
};

export const combineLandings = (
  groups: ExpectedLandings[],
): ExpectedLandings => {
  let combinations: ExpectedLandings = [emptyLanding];
  for (const alternatives of groups) {
    const next = new Map<string, ExpectedLanding>();
    for (const combination of combinations) {
      for (const alternative of alternatives) {
        const merged = merge(combination, alternative);
        next.set(keyFor(merged), merged);
        assertWithinLimit(next.size, false);
      }
    }
    combinations = [...next.values()];
  }
  return combinations;
};

export const combineMatchedLandings = (
  groups: ExpectedLandings[],
): ExpectedLandings => {
  const combinations = new Map<string, ExpectedLanding>([
    [keyFor(emptyLanding), emptyLanding],
  ]);
  for (const alternatives of groups) {
    const previous = [...combinations.values()];
    for (const combination of previous) {
      for (const alternative of alternatives) {
        const merged = merge(combination, alternative);
        combinations.set(keyFor(merged), merged);
        assertWithinLimit(combinations.size, true);
      }
    }
  }
  combinations.delete(keyFor(emptyLanding));
  return [...combinations.values()];
};

export const combineExclusiveLandings = (
  groups: ExpectedLandings[],
): ExpectedLandings => {
  const alternatives = new Map<string, ExpectedLanding>();
  for (const group of groups) {
    for (const landing of group) {
      alternatives.set(keyFor(landing), landing);
      assertWithinLimit(alternatives.size, false);
    }
  }
  return [...alternatives.values()];
};
