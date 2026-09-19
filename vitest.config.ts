import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "src/**/*.live.test.ts",
      "src/**/test/live/**/*.test.ts",
      "node_modules/**",
      "dist/**",
    ],
  },
});
