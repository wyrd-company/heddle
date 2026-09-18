// ---
// relationships:
//   implements: command-line-interface
// ---
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function serviceDatabasePath(databasePath: string): string {
  try {
    return realpathSync(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(realpathSync(dirname(databasePath)), basename(databasePath));
  }
}

export function serviceHookSocket(
  stateDirectory: string,
  databasePath: string,
): string {
  const identity = createHash("sha256")
    .update(resolve(databasePath))
    .digest("hex")
    .slice(0, 24);
  return join(stateDirectory, `hooks-${identity}.sock`);
}
