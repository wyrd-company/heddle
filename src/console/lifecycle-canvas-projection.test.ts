// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import { lifecycleNodeContentHeight } from "./lifecycle-canvas-projection.js";

describe("lifecycle canvas projection", () => {
  it.each([
    [undefined, 80],
    [{ inputs: {} }, 142],
    [{ outputs: {} }, 142],
    [{ inputs: {}, outputs: {} }, 204],
    [{ inputs: null, outputs: null }, 80],
  ])(
    "sizes readonly card content without a local editor mutation",
    (data, height) => {
      expect(lifecycleNodeContentHeight(data)).toBe(height);
    },
  );
});
