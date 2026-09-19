// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** True when a resolved path stays at or below a directory. */
export function beside(directory: string, path: string): boolean {
  const displacement = relative(directory, path);
  return (
    displacement !== ".." &&
    !displacement.startsWith(`..${sep}`) &&
    !isAbsolute(displacement)
  );
}

/**
 * The single resolution rule for every path a blueprint writes. Paths are
 * relative to the blueprint root, never to the directory of the file that
 * wrote them, and never reach above the root.
 */
export function resolveBlueprintPath(
  root: string,
  path: string,
): string | undefined {
  if (isAbsolute(path)) return undefined;
  const target = resolve(root, path);
  return beside(root, target) ? target : undefined;
}

/**
 * A configured root wins. Otherwise a directory argument is its own blueprint
 * root and a single file argument is rooted at its own directory, which keeps
 * file-local validation whole.
 */
export function blueprintRootFor(
  configured: string | undefined,
  path: string,
  isDirectory: boolean,
): string {
  const resolved = resolve(configured ?? path);
  return configured !== undefined || isDirectory ? resolved : dirname(resolved);
}
