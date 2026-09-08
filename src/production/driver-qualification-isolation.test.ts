// ---
// relationships:
//   verifies: heddle
// ---

import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertQualificationIsolation,
  LIVE_BOARD_DIRECTORY,
  LIVE_T3_PORT,
  prepareNativeProviderHome,
  QualificationIsolationError,
} from "./driver-qualification.test-support.js";

const scratch = tmpdir();

const safeSurface = {
  boardDirectory: join(scratch, "qualification", "board"),
  port: 41_234,
  stateDirectory: join(scratch, "qualification", "state"),
  t3BaseDirectory: join(scratch, "qualification", "t3-base"),
};

describe("qualification isolation", () => {
  it("accepts a fully scratch-backed surface on an ephemeral port", () => {
    expect(() => assertQualificationIsolation(safeSurface)).not.toThrow();
  });

  it("refuses the operator's live T3 port", () => {
    expect(() =>
      assertQualificationIsolation({ ...safeSurface, port: LIVE_T3_PORT }),
    ).toThrow(QualificationIsolationError);
  });

  it("refuses the operator's live board directory", () => {
    expect(() =>
      assertQualificationIsolation({
        ...safeSurface,
        boardDirectory: LIVE_BOARD_DIRECTORY,
      }),
    ).toThrow(QualificationIsolationError);
  });

  it("refuses a task nested inside the operator's live board", () => {
    expect(() =>
      assertQualificationIsolation({
        ...safeSurface,
        boardDirectory: `${LIVE_BOARD_DIRECTORY}/tasks`,
      }),
    ).toThrow(QualificationIsolationError);
  });

  it("refuses a live board reached by a path that only normalizes to it", () => {
    // Shares no prefix with the live board until it is resolved, so only
    // normalization can catch it.
    expect(() =>
      assertQualificationIsolation({
        ...safeSurface,
        boardDirectory: "/workspaces/tools/../kanban",
      }),
    ).toThrow(QualificationIsolationError);
  });

  it("refuses a T3 base directory outside the scratch root", () => {
    expect(() =>
      assertQualificationIsolation({
        ...safeSurface,
        t3BaseDirectory: "/home/operator/.t3",
      }),
    ).toThrow(QualificationIsolationError);
  });

  it("refuses a state directory outside the scratch root", () => {
    expect(() =>
      assertQualificationIsolation({
        ...safeSurface,
        stateDirectory: "/var/lib/heddle",
      }),
    ).toThrow(QualificationIsolationError);
  });

  it("gives each native row only its selected provider credential store", async () => {
    const directory = resolve(".devcontainer/driver-qualification");
    const expected = {
      "claude-code": [
        "${localEnv:HOME}/.claude",
        "${localEnv:HOME}/.claude.json",
      ],
      codex: ["${localEnv:HOME}/.codex"],
      cursor: ["${localEnv:HOME}/.cursor", "${localEnv:HOME}/.config/cursor"],
      grok: ["${localEnv:HOME}/.grok"],
      opencode: [
        "${localEnv:HOME}/.config/opencode",
        "${localEnv:HOME}/.local/share/opencode",
      ],
    } as const;

    for (const [driver, sources] of Object.entries(expected)) {
      const configuration = JSON.parse(
        await readFile(join(directory, driver, "devcontainer.json"), "utf8"),
      ) as { mounts?: string[] };
      const credentialMounts = (configuration.mounts ?? []).filter((mount) =>
        mount.startsWith("source=${localEnv:HOME}"),
      );
      expect(
        credentialMounts.map((mount) => mount.match(/^source=([^,]+)/)?.[1]),
        driver,
      ).toEqual(sources);
      expect(
        credentialMounts.every((mount) => mount.endsWith(",readonly")),
        driver,
      ).toBe(true);
    }

    const common = await readFile(join(directory, "devcontainer.json"), "utf8");
    expect(common).not.toContain("heddle-credentials");
    expect(common).not.toContain("localEnv:HOME");

    const root = await mkdtemp(join(tmpdir(), "heddle-identity-map-test-"));
    try {
      const sourceHome = join(root, "source-home");
      const relativePaths = Object.fromEntries(
        Object.entries(expected).map(([driver, sources]) => [
          driver,
          sources.map((source) => source.replace("${localEnv:HOME}/", "")),
        ]),
      ) as Record<string, string[]>;
      for (const relative of Object.values(relativePaths).flat()) {
        const source = join(sourceHome, relative);
        if (relative === ".claude.json") {
          await mkdir(sourceHome, { recursive: true });
          await writeFile(source, "selected-file\n");
        } else {
          await mkdir(source, { recursive: true });
          await writeFile(join(source, "identity"), "selected-directory\n");
        }
      }

      for (const [driver, selected] of Object.entries(relativePaths)) {
        const rowScratch = join(root, driver);
        await prepareNativeProviderHome({
          driver,
          scratch: rowScratch,
          sourceHome,
        });
        for (const relative of Object.values(relativePaths).flat()) {
          const target = join(rowScratch, "provider-home", relative);
          if (selected.includes(relative)) {
            await expect(stat(target)).resolves.toBeDefined();
          } else {
            await expect(stat(target)).rejects.toMatchObject({
              code: "ENOENT",
            });
          }
        }
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("copies only the selected native identity into disposable provider HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-isolation-test-"));
    try {
      const sourceHome = join(root, "source-home");
      const scratch = join(root, "scratch");
      await mkdir(join(sourceHome, ".codex"), { recursive: true });
      await mkdir(join(sourceHome, ".claude"), { recursive: true });
      const selectedIdentity = join(sourceHome, ".codex", "identity.json");
      await writeFile(selectedIdentity, "selected\n");
      await writeFile(join(sourceHome, ".claude", "identity.json"), "other\n");

      await prepareNativeProviderHome({ driver: "codex", scratch, sourceHome });

      expect(
        await readFile(
          join(scratch, "provider-home", ".codex", "identity.json"),
          "utf8",
        ),
      ).toBe("selected\n");
      await expect(
        readFile(
          join(scratch, "provider-home", ".claude", "identity.json"),
          "utf8",
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });

      await writeFile(
        join(scratch, "provider-home", ".codex", "identity.json"),
        "disposable-change\n",
      );
      expect(await readFile(selectedIdentity, "utf8")).toBe("selected\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("preserves dangling links in a disposable native identity store", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-link-copy-test-"));
    try {
      const sourceHome = join(root, "source-home");
      const scratch = join(root, "scratch");
      const danglingTarget = join(sourceHome, ".codex", "temporary", "missing");
      const sourceLink = join(sourceHome, ".codex", "current");
      await mkdir(join(sourceHome, ".codex"), { recursive: true });
      await symlink(danglingTarget, sourceLink);

      await prepareNativeProviderHome({ driver: "codex", scratch, sourceHome });

      const copiedLink = join(scratch, "provider-home", ".codex", "current");
      expect((await lstat(copiedLink)).isSymbolicLink()).toBe(true);
      expect(await readlink(copiedLink)).toBe(danglingTarget);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("excludes volatile sockets from a disposable native identity store", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-socket-copy-test-"));
    const server = createServer();
    try {
      const sourceHome = join(root, "source-home");
      const scratch = join(root, "scratch");
      const socket = join(sourceHome, ".codex", "ipc.sock");
      await mkdir(join(sourceHome, ".codex"), { recursive: true });
      await writeFile(
        join(sourceHome, ".codex", "identity.json"),
        "selected\n",
      );
      await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(socket, () => resolveListen());
      });

      await prepareNativeProviderHome({ driver: "codex", scratch, sourceHome });

      await expect(
        readFile(
          join(scratch, "provider-home", ".codex", "identity.json"),
          "utf8",
        ),
      ).resolves.toBe("selected\n");
      await expect(
        lstat(join(scratch, "provider-home", ".codex", "ipc.sock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
      await rm(root, { force: true, recursive: true });
    }
  });
});
