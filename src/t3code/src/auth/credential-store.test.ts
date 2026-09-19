import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { fileCredentialStore, memoryCredentialStore } from "./credential-store.js";

const credentials = {
  accessToken: "credential-1",
  scopes: ["orchestration:read" as const],
  expiresAt: "2030-01-02T03:04:05.000Z",
  sessionMethod: "bearer-access-token" as const,
};

describe("credential stores", () => {
  it("keeps memory values isolated from caller mutation", async () => {
    const store = memoryCredentialStore(credentials);
    const loaded = await store.load();
    loaded.scopes?.push("access:read");
    expect(await store.load()).toEqual(credentials);
    await store.clear();
    expect(await store.load()).toEqual({});
  });

  it("round trips a mode-0600 file and treats a missing file as empty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "credential-store-"));
    const path = join(directory, "credentials.json");
    try {
      const store = fileCredentialStore(path);
      expect(await store.load()).toEqual({});
      await store.save(credentials);
      expect(await store.load()).toEqual(credentials);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(credentials);
      await store.clear();
      expect(await store.load()).toEqual({});
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
