// ---
// relationships:
//   implements: engine-and-run-model
// ---
import { realpathSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { schema } from "./schema.js";
import type { Run } from "./types.js";

interface Writer {
  db: DatabaseSync;
  users: number;
  active: Map<string, Promise<Run>>;
}
const writers = new Map<string, Writer>();

/** All handles in the Heddle service share one synchronous SQLite writer. */
export function acquireWriter(path: string): Writer & { release: () => void } {
  const absolute = resolve(path);
  const key =
    path === ":memory:"
      ? undefined
      : (() => {
          try {
            return realpathSync(absolute);
          } catch {
            return join(realpathSync(dirname(absolute)), basename(absolute));
          }
        })();
  let writer = key === undefined ? undefined : writers.get(key);
  if (!writer) {
    const db = new DatabaseSync(path);
    db.exec(schema);
    if (
      !db
        .prepare("PRAGMA table_info(runs)")
        .all()
        .some((column) => column["name"] === "requested_revision")
    )
      db.exec("ALTER TABLE runs ADD COLUMN requested_revision TEXT");
    writer = { db, users: 0, active: new Map() };
    if (key !== undefined) writers.set(key, writer);
  }
  const owned = writer;
  owned.users++;
  let released = false;
  return {
    ...owned,
    release: () => {
      if (released) return;
      released = true;
      if (--owned.users === 0) {
        owned.db.close();
        if (key !== undefined) writers.delete(key);
      }
    },
  };
}
