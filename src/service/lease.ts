// ---
// relationships:
//   implements: command-line-interface
// ---
import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

export interface StoreLease {
  path: string;
  release(): void;
}

function live(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireStoreLease(databasePath: string): StoreLease {
  const path = `${databasePath}.writer`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, `${String(process.pid)}\n`, "utf8");
      closeSync(fd);
      let released = false;
      return {
        path,
        release() {
          if (released) return;
          released = true;
          try {
            unlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(readFileSync(path, "utf8").trim());
      if (Number.isSafeInteger(owner) && owner > 0 && live(owner))
        throw new Error(
          `Heddle store is already owned by service process ${String(owner)}: ${databasePath}`,
        );
      unlinkSync(path);
    }
  }
  throw new Error(`Cannot acquire Heddle store writer: ${databasePath}`);
}
