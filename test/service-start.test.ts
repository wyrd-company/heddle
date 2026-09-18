// ---
// relationships:
//   verifies: command-line-interface
// ---
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ResolvedServiceConfig } from "../src/service/config.js";
import { startService, type RunningService } from "../src/service/service.js";

const roots: string[] = [];
const services: RunningService[] = [];
afterEach(async () => {
  for (const service of services.splice(0).reverse()) await service.close();
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
const io = { output: () => undefined, error: () => undefined };
async function start(root: string): Promise<RunningService> {
  const service = await startService(config(root), io);
  services.push(service);
  return service;
}

it("keeps one service alive, rejects a second writer, and releases the store on close", async () => {
  const root = mkdtempSync(join(tmpdir(), "service-start-"));
  roots.push(root);
  const first = await start(root);
  await expect(start(root)).rejects.toThrow("already owned");
  await first.close();
  const second = await start(root);
  await second.close();
});
