// ---
// relationships:
//   implements: heddle
// ---

import { randomBytes } from "node:crypto";
import { link, open, rename, unlink } from "node:fs/promises";
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

/**
 * Creates `path` with `contents`, refusing to disturb an existing file.
 *
 * `rename` would replace whatever is already there, which on a shared board
 * destroys a task another writer created and reported as created. `link`
 * publishes the finished bytes under the target name in one step and fails
 * with `EEXIST` instead, so a losing writer loses only its own attempt.
 *
 * Returns false when the target already exists.
 */
export const createFileAtomic = async (
  path: string,
  contents: string,
): Promise<boolean> => {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") return false;
      throw error;
    }
    return true;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};
