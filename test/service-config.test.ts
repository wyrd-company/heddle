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

it("keeps webhook listening disabled without explicit host and port", () => {
  const f = fixture("webhook:\n  secretFile: /secrets/webhook\n");
  expect(
    resolveServiceConfig({ configPath: f.path }).webhook?.listen,
  ).toBeUndefined();
});

it.each(["127.0.0.1", "0.0.0.0", "::1"])(
  "preserves explicit webhook routing on %s with a secret override",
  (host) => {
    const f = fixture(
      `webhook:\n  secretFile: /secrets/webhook\n  listen:\n    host: '${host}'\n    port: 8421\n`,
    );
    expect(
      resolveServiceConfig({
        configPath: f.path,
        webhookSecretFile: "/secrets/replacement",
      }).webhook,
    ).toEqual({
      secretFile: "/secrets/replacement",
      listen: { host, port: 8421 },
    });
  },
);

it.each([
  "listen: {}",
  "listen: { host: 127.0.0.1 }",
  "listen: { port: 8421 }",
  "listen: { host: '', port: 8421 }",
  "listen: { host: 127.0.0.1, port: 0 }",
  "listen: { host: 127.0.0.1, port: 65536 }",
  "listen: { host: 127.0.0.1, port: 1.5 }",
])("rejects incomplete or non-stable webhook configuration: %s", (listen) => {
  const f = fixture(`webhook:\n  secretFile: /secrets/webhook\n  ${listen}\n`);
  expect(() => resolveServiceConfig({ configPath: f.path })).toThrow(
    "webhook.listen",
  );
});

const PASS_DEFAULTS =
  "pass:\n  defaultModel:\n    instanceId: sample-provider\n    model: sample-model\n  defaultWorktree: /workspace\n";

function boundFixture(extra = ""): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "service-config-"));
  roots.push(root);
  const path = join(root, "config.yml");
  writeFileSync(
    path,
    `projects:\n  - owner: sample-owner\n    number: 12\ngithub:\n  credentialFile: /secrets/app.yml\nblueprints:\n  repository: /workspace/blueprints\nt3Code:\n  endpoint: http://127.0.0.1:3000\n${extra}`,
  );
  return { root, path };
}

it("starts an idle service without an agent-tools listen address", () => {
  const f = fixture();
  expect(
    resolveServiceConfig({ configPath: f.path }).agentTools,
  ).toBeUndefined();
});

it("refuses bound projects without an agent-tools port", () => {
  expect(() =>
    resolveServiceConfig({ configPath: boundFixture().path }),
  ).toThrow("agentTools.listen.port");
});

it("refuses a pass-capable service without an agent-tools port", () => {
  expect(() =>
    resolveServiceConfig({ configPath: fixture(PASS_DEFAULTS).path }),
  ).toThrow("agentTools.listen.port");
});

it("defaults the agent-tools bind host to loopback and preserves an explicit host", () => {
  expect(
    resolveServiceConfig({
      configPath: boundFixture("agentTools:\n  listen:\n    port: 8422\n").path,
    }).agentTools,
  ).toEqual({ listen: { host: "127.0.0.1", port: 8422 } });
  expect(
    resolveServiceConfig({
      configPath: boundFixture(
        "agentTools:\n  listen:\n    host: '::1'\n    port: 8423\n",
      ).path,
    }).agentTools,
  ).toEqual({ listen: { host: "::1", port: 8423 } });
});

it.each([
  "listen: {}",
  "listen: { host: 127.0.0.1 }",
  "listen: { host: '', port: 8421 }",
  "listen: { host: 127.0.0.1, port: 0 }",
  "listen: { host: 127.0.0.1, port: 65536 }",
  "listen: { host: 127.0.0.1, port: 1.5 }",
])(
  "rejects incomplete or non-stable agent-tools configuration: %s",
  (listen) => {
    const f = boundFixture(`agentTools:\n  ${listen}\n`);
    expect(() => resolveServiceConfig({ configPath: f.path })).toThrow(
      "agentTools.listen",
    );
  },
);
