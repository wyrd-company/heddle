// ---
// relationships:
//   verifies: command-line-interface
// ---
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  defaultConfigPath,
  defaultStateDirectory,
  resolveServiceConfig,
} from "../src/service/config.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(extra = ""): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "service-config-"));
  roots.push(root);
  const path = join(root, "config.yml");
  writeFileSync(
    path,
    `projects: []\ngithub:\n  credentialFile: /secrets/app.yml\nblueprints:\n  repository: /workspace/blueprints\nt3Code:\n  endpoint: http://127.0.0.1:3000\n${extra}`,
  );
  return { root, path };
}

it("resolves the user-profile configuration, state, database, and polling defaults", () => {
  expect(defaultConfigPath({ XDG_CONFIG_HOME: "/profile/config" })).toBe(
    "/profile/config/heddle/config.yml",
  );
  expect(defaultStateDirectory({ XDG_STATE_HOME: "/profile/state" })).toBe(
    "/profile/state/heddle",
  );
  const f = fixture();
  const config = resolveServiceConfig({
    configPath: f.path,
    stateDirectory: join(f.root, "state"),
  });
  expect(config.databasePath).toBe(join(f.root, "state", "heddle.sqlite"));
  expect(config.polling.intervalMs).toBe(30_000);
});

it("resolves configured and command-line database and polling overrides", () => {
  const f = fixture(
    "state:\n  databasePath: /configured/state.sqlite\npolling:\n  intervalMs: 41000\n",
  );
  const stateDirectory = join(f.root, "service-state");
  expect(
    resolveServiceConfig({ configPath: f.path, stateDirectory }),
  ).toMatchObject({
    databasePath: "/configured/state.sqlite",
    stateDirectory,
    polling: { intervalMs: 41000 },
  });
  expect(
    resolveServiceConfig({
      configPath: f.path,
      stateDirectory,
      databasePath: "/overridden/state.sqlite",
      pollingIntervalMs: 52000,
    }),
  ).toMatchObject({
    databasePath: "/overridden/state.sqlite",
    stateDirectory,
    polling: { intervalMs: 52000 },
  });
});

it("names the resolved configuration path in load errors", () => {
  const path = "/missing/profile/config.yml";
  expect(() => resolveServiceConfig({ configPath: path })).toThrow(path);
});
