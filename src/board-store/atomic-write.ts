// ---
// relationships:
//   implements: heddle
// ---

import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Writes `contents` so that a concurrent reader observes either the previous
 * file or the complete new one, never a partial write.
 *
 * The temporary file is created in the target's own directory so the rename is
 * a same-filesystem operation, and the data is flushed before the rename so a
 * crash cannot publish an empty file under the target name.
 */
export const writeFileAtomic = async (
  path: string,
  contents: string,
): Promise<void> => {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${randomBytes(8).toString("hex")}.tmp`,
  );
  let published = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    published = true;
  } finally {
    if (!published) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
};
