// ---
// relationships:
//   verifies: repository-conventions
// ---
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { provider: "v8" },
  },
});
