// ---
// relationships:
//   verifies: command-line-interface
// ---
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
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

it.each(["127.0.0.1", "0.0.0.0"])(
  "binds the explicitly configured %s interface for an idle service and releases the port",
  async (host) => {
    const root = mkdtempSync(join(tmpdir(), "service-listener-"));
    roots.push(root);
    const reservation = createServer();
    await new Promise<void>((resolve) => {
      reservation.listen(0, host, resolve);
    });
    const address = reservation.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture address");
    const port = address.port;
    const secretFile = join(root, "secret");
    writeFileSync(secretFile, "sample-secret");
    const configured = {
      ...config(root),
      webhook: { secretFile, listen: { host, port } },
    };
    try {
      await expect(startService(configured, io)).rejects.toThrow("EADDRINUSE");
    } finally {
      await new Promise<void>((resolve) => {
        reservation.close(() => {
          resolve();
        });
      });
    }
    const messages: string[] = [];
    const running = await startService(configured, {
      ...io,
      output: (message) => {
        messages.push(message);
      },
    });
    try {
      expect(messages.join("\n")).toContain(
        `webhook=http://${host}:${String(port)}/webhook/github`,
      );
      if (host === "0.0.0.0") {
        const external = Object.values(networkInterfaces())
          .flat()
          .find((entry) => entry?.family === "IPv4" && !entry.internal);
        expect(
          external,
          "wildcard fixture requires a local non-loopback interface",
        ).toBeDefined();
        const response = await fetch(
          `http://${String(external?.address)}:${String(port)}/hook/stop`,
          { method: "POST" },
        );
        expect(response.status).toBe(404);
      }
      const response = await fetch(
        `http://127.0.0.1:${String(port)}/hook/stop`,
        { method: "POST" },
      );
      expect(response.status).toBe(404);
    } finally {
      await running.close();
    }
    const restarted = await startService(configured, io);
    await restarted.close();
  },
);
