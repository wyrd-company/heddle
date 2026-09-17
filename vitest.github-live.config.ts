import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/github/src/**/*.live.test.ts", "src/binding/*.live.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
