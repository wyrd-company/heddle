// ---
// relationships:
//   verifies: command-line-interface
// ---
import {
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  fstatSync,
  closeSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireStoreLease, type StoreLease } from "../src/service/lease.js";

const interleave = vi.hoisted(() => ({
  beforeLock: undefined as ((fd: number) => boolean | undefined) | undefined,
}));
vi.mock("fs-native-extensions", async (original) => {
  const native = await original<typeof import("fs-native-extensions")>();
  return {
    tryLock: (fd: number) => {
      const run = interleave.beforeLock;
      interleave.beforeLock = undefined;
      return run?.(fd) ?? native.tryLock(fd);
    },
  };
});
const roots: string[] = [];
const leases: StoreLease[] = [];
afterEach(() => {
  interleave.beforeLock = undefined;
  for (const lease of leases.splice(0)) lease.release();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function database(): string {
  const root = mkdtempSync(join(tmpdir(), "service-lease-"));
  roots.push(root);
  const path = join(root, "sample.sqlite");
  writeFileSync(`${path}.writer`, "0\n");
  return path;
}
it("a concurrent owner wins atomically even when both starters saw a stale anchor", () => {
  const path = database();
  interleave.beforeLock = () => {
    leases.push(acquireStoreLease(path));
    return undefined;
  };
  expect(() => leases.push(acquireStoreLease(path))).toThrow("already owned");
  expect(leases).toHaveLength(1);
});
it("retries when the anchor disappears between acquisition failure and inspection", () => {
  const path = database();
  interleave.beforeLock = () => {
    unlinkSync(`${path}.writer`);
    return false;
  };
  leases.push(acquireStoreLease(path));
  expect(() => leases.push(acquireStoreLease(path))).toThrow("already owned");
});
it("retries an obsolete descriptor and respects the replacement anchor owner", () => {
  const path = database();
  interleave.beforeLock = () => {
    unlinkSync(`${path}.writer`);
    leases.push(acquireStoreLease(path));
    return true;
  };
  expect(() => leases.push(acquireStoreLease(path))).toThrow("already owned");
  expect(leases).toHaveLength(1);
});
it("release is idempotent and cannot release a successor owner", () => {
  const path = database();
  const first = acquireStoreLease(path);
  leases.push(first);
  const anchor = statSync(`${path}.writer`);
  first.release();
  expect(statSync(`${path}.writer`).ino).toBe(anchor.ino);
  leases.push(acquireStoreLease(path));
  first.release();
  expect(() => leases.push(acquireStoreLease(path))).toThrow("already owned");
});

it("closes a rejected acquisition descriptor while preserving its owner", () => {
  const path = database();
  leases.push(acquireStoreLease(path));
  let rejected = -1;
  interleave.beforeLock = (fd) => {
    rejected = fd;
    return undefined;
  };
  try {
    expect(() => leases.push(acquireStoreLease(path))).toThrow("already owned");
    expect(() => fstatSync(rejected)).toThrow("EBADF");
    expect(() => leases.push(acquireStoreLease(path))).toThrow("already owned");
  } finally {
    // A failed cleanup-guard mutation must not leave its descriptor open.
    try {
      closeSync(rejected);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
    }
  }
});
