// ---
// relationships:
//   implements: heddle
// ---

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import Database from "better-sqlite3";

import { BlueprintValidationError } from "./errors.js";

const executeFile = promisify(execFile);
const heartbeatMilliseconds = 250;
const staleMilliseconds = 5_000;
const waitMilliseconds = 10_000;

export interface RepositoryWriterLease {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

interface RepositoryWriterLeaseOptions {
  heartbeatMilliseconds?: number;
  staleMilliseconds?: number;
  waitMilliseconds?: number;
}

interface LeaseRow {
  expiresAt: number;
  token: string;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) =>
    globalThis.setTimeout(resolveDelay, milliseconds),
  );

const openLeaseDatabase = (path: string): Database.Database => {
  const database = new Database(path);
  database.pragma("busy_timeout = 1000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS blueprint_writer_lease (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
  return database;
};

export const acquireRepositoryWriterLease = async (
  repositoryRoot: string,
  options: RepositoryWriterLeaseOptions = {},
): Promise<RepositoryWriterLease> => {
  const heartbeatInterval =
    options.heartbeatMilliseconds ?? heartbeatMilliseconds;
  const staleInterval = options.staleMilliseconds ?? staleMilliseconds;
  const maximumWait = options.waitMilliseconds ?? waitMilliseconds;
  const { stdout } = await executeFile(
    "git",
    [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "heddle/blueprint-writer-lease.sqlite",
    ],
    { cwd: repositoryRoot },
  );
  const leasePath = stdout.trim();
  await mkdir(dirname(leasePath), { recursive: true });
  const database = openLeaseDatabase(leasePath);
  const token = randomUUID();
  const startedAt = Date.now();
  const claim = database.prepare<{
    expiresAt: number;
    now: number;
    token: string;
  }>(`
    INSERT INTO blueprint_writer_lease (singleton, token, expires_at)
    VALUES (1, @token, @expiresAt)
    ON CONFLICT (singleton) DO UPDATE SET
      token = excluded.token,
      expires_at = excluded.expires_at
    WHERE blueprint_writer_lease.expires_at <= @now
    RETURNING token
  `);
  while (true) {
    const now = Date.now();
    const acquired = claim.get({
      expiresAt: now + staleInterval,
      now,
      token,
    }) as Pick<LeaseRow, "token"> | undefined;
    if (acquired?.token === token) break;
    if (now - startedAt >= maximumWait) {
      database.close();
      throw new BlueprintValidationError(
        "Timed out waiting for the repository blueprint writer lease",
      );
    }
    await delay(25);
  }

  const renew = database.prepare<{ expiresAt: number; token: string }>(`
    UPDATE blueprint_writer_lease
    SET expires_at = @expiresAt
    WHERE singleton = 1 AND token = @token
  `);
  const owned = database.prepare<[], LeaseRow>(`
    SELECT token, expires_at AS expiresAt
    FROM blueprint_writer_lease
    WHERE singleton = 1
  `);
  const release = database.prepare<{ token: string }>(`
    DELETE FROM blueprint_writer_lease
    WHERE singleton = 1 AND token = @token
  `);
  let compromised = false;
  let releasing = false;
  const heartbeat = globalThis.setInterval(() => {
    try {
      const result = renew.run({
        expiresAt: Date.now() + staleInterval,
        token,
      });
      if (result.changes !== 1 && !releasing) compromised = true;
    } catch {
      if (!releasing) compromised = true;
    }
  }, heartbeatInterval);
  heartbeat.unref();

  const assertOwned = async (): Promise<void> => {
    const current = owned.get();
    if (
      compromised ||
      current?.token !== token ||
      current.expiresAt <= Date.now()
    ) {
      throw new BlueprintValidationError(
        "Repository blueprint writer lease was lost",
      );
    }
  };

  return {
    assertOwned,
    release: async () => {
      releasing = true;
      globalThis.clearInterval(heartbeat);
      try {
        release.run({ token });
      } finally {
        database.close();
      }
    },
  };
};
