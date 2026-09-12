// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireRepositoryWriterLease } from "./repository-writer-lease.js";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

const fixture = async (): Promise<string> => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "writer-lease-"));
  temporaryDirectories.push(repositoryRoot);
  await executeFile("git", ["init", "--quiet"], { cwd: repositoryRoot });
  return repositoryRoot;
};

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("repository blueprint writer lease", () => {
  it("keeps an active owner beyond the stale interval through heartbeat renewal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const repositoryRoot = await fixture();
    const owner = await acquireRepositoryWriterLease(repositoryRoot);

    await vi.advanceTimersByTimeAsync(6_000);
    const contender = await acquireRepositoryWriterLease(repositoryRoot, {
      waitMilliseconds: 0,
    }).catch((error: unknown) => error);

    expect(contender).toMatchObject({
      message: "Timed out waiting for the repository blueprint writer lease",
    });
    await expect(owner.assertOwned()).resolves.toBeUndefined();
    await owner.release();
  });

  it("cannot release a successor installed after the prior owner expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const repositoryRoot = await fixture();
    const priorOwner = await acquireRepositoryWriterLease(repositoryRoot, {
      heartbeatMilliseconds: 60_000,
    });
    await vi.advanceTimersByTimeAsync(5_001);
    const successor = await acquireRepositoryWriterLease(repositoryRoot, {
      waitMilliseconds: 0,
    });

    await priorOwner.release();

    await expect(successor.assertOwned()).resolves.toBeUndefined();
    const contender = await acquireRepositoryWriterLease(repositoryRoot, {
      waitMilliseconds: 0,
    }).catch((error: unknown) => error);
    expect(contender).toMatchObject({
      message: "Timed out waiting for the repository blueprint writer lease",
    });
    await successor.release();
  });
});
