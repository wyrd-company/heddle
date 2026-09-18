// ---
// relationships:
//   implements: command-line-interface
// ---
import { createHash } from "node:crypto";
import { readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function serviceDatabasePath(databasePath: string): string {
  try {
    return realpathSync(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // SQLite can create a dangling link's target. Resolve that target before
    // creation so the lease and hook identities cannot change after opening it.
    let target: string | undefined;
    try {
      target = readlinkSync(databasePath);
    } catch (linkError) {
      const code = (linkError as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EINVAL") throw linkError;
    }
    if (target !== undefined)
      return serviceDatabasePath(resolve(dirname(databasePath), target));
    return join(realpathSync(dirname(databasePath)), basename(databasePath));
  }
}

export function serviceHookSocket(
  stateDirectory: string,
  databasePath: string,
): string {
  const identity = createHash("sha256")
    .update(resolve(databasePath))
    .digest("base64url")
    .slice(0, 16);
  return join(stateDirectory, identity);
}
