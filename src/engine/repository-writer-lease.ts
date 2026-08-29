// ---
// relationships:
//   implements: heddle
// ---

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { clearInterval, setInterval, setTimeout } from "node:timers";
import { promisify } from "node:util";

import { BlueprintValidationError } from "./errors.js";

const executeFile = promisify(execFile);
const heartbeatMilliseconds = 250;
const staleMilliseconds = 5_000;
const waitMilliseconds = 10_000;

export interface RepositoryWriterLease {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;

const recoverStaleLease = async (leasePath: string): Promise<boolean> => {
  let modifiedAt: number;
  try {
    modifiedAt = (await stat(leasePath)).mtimeMs;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    throw error;
  }
  if (Date.now() - modifiedAt < staleMilliseconds) return false;
  const stalePath = `${leasePath}.stale-${randomUUID()}`;
  try {
    await rename(leasePath, stalePath);
    await rm(stalePath, { force: true, recursive: true });
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    throw error;
  }
};

const claimLease = async (
  leasePath: string,
  token: string,
): Promise<string> => {
  const ownerPath = join(leasePath, "owner");
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(leasePath);
      await writeFile(ownerPath, token, { encoding: "utf8", flag: "wx" });
      return ownerPath;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (await recoverStaleLease(leasePath)) continue;
      if (Date.now() - startedAt >= waitMilliseconds) {
        throw new BlueprintValidationError(
          "Timed out waiting for the repository blueprint writer lease",
        );
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
};

export const acquireRepositoryWriterLease = async (
  repositoryRoot: string,
): Promise<RepositoryWriterLease> => {
  const { stdout } = await executeFile(
    "git",
    [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "heddle/blueprint-writer.lock",
    ],
    { cwd: repositoryRoot },
  );
  const leasePath = stdout.trim();
  await mkdir(dirname(leasePath), { recursive: true });
  const token = randomUUID();
  const ownerPath = await claimLease(leasePath, token);
  let compromised = false;
  let releasing = false;
  const heartbeat = setInterval(() => {
    void utimes(leasePath, new Date(), new Date()).catch(() => {
      if (!releasing) compromised = true;
    });
  }, heartbeatMilliseconds);
  heartbeat.unref();
  const assertOwned = async (): Promise<void> => {
    if (compromised || (await readFile(ownerPath, "utf8")) !== token) {
      throw new BlueprintValidationError(
        "Repository blueprint writer lease was lost",
      );
    }
  };
  return {
    assertOwned,
    release: async () => {
      releasing = true;
      clearInterval(heartbeat);
      try {
        await assertOwned();
      } catch {
        return;
      }
      const releasePath = `${leasePath}.release-${token}`;
      try {
        await rename(leasePath, releasePath);
        await rm(releasePath, { force: true, recursive: true });
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
    },
  };
};
