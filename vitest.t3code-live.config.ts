import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/t3code/test/live/**/*.test.ts"],
    environment: "node",
    testTimeout: 240_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
