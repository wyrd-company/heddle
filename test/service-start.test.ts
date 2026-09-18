// ---
// relationships:
//   verifies: command-line-interface
// ---
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ResolvedServiceConfig } from "../src/service/config.js";
import { startService } from "../src/service/service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function config(root: string): ResolvedServiceConfig {
  return {
    configPath: join(root, "config.yml"),
    stateDirectory: join(root, "state"),
    databasePath: join(root, "state", "heddle.sqlite"),
    polling: { intervalMs: 30000 },
    projects: [],
    github: { credentialFile: "/unused/app.yml" },
    blueprints: { repository: "/unused/blueprints" },
    t3Code: { endpoint: "http://127.0.0.1:3000" },
    state: {},
  };
}
const io = { output() {}, error() {} };

it("keeps one service alive, rejects a second writer, and releases the store on close", async () => {
  const root = mkdtempSync(join(tmpdir(), "service-start-"));
  roots.push(root);
  const first = await startService(config(root), io);
  await expect(startService(config(root), io)).rejects.toThrow("already owned");
  await first.close();
  const second = await startService(config(root), io);
  await second.close();
});
