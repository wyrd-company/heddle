// ---
// relationships:
//   implements: command-line-interface
// ---
import { closeSync, fstatSync, openSync, statSync } from "node:fs";
import { tryLock } from "fs-native-extensions";

export interface StoreLease {
  path: string;
  release(): void;
}

/** The anchor stays on disk; ownership belongs to the open descriptor. */
export function acquireStoreLease(databasePath: string): StoreLease {
  const path = `${databasePath}.writer`;
  for (;;) {
    const fd = openSync(path, "a+", 0o600);
    let retained = false;
    try {
      const granted = tryLock(fd);
      const opened = fstatSync(fd);
      let current;
      try {
        current = statSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      // A removed or replaced anchor is not the current ownership identity.
      if (opened.dev !== current.dev || opened.ino !== current.ino) continue;
      if (!granted)
        throw new Error(
          `Heddle store is already owned by another service: ${databasePath}`,
        );
      retained = true;
      let released = false;
      return {
        path,
        release() {
          if (released) return;
          released = true;
          closeSync(fd);
        },
      };
    } finally {
      if (!retained) closeSync(fd);
    }
  }
}
