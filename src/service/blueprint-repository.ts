// ---
// relationships:
//   implements: blueprint-authoring
// ---
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import git from "isomorphic-git";

export function beside(directory: string, path: string): boolean {
  const displacement = relative(directory, path);
  return (
    displacement !== ".." &&
    !displacement.startsWith(`..${sep}`) &&
    !isAbsolute(displacement)
  );
}

/** Display identities, never repository URLs, absolute paths, or control bytes. */
export function safeIdentity(value: string): string {
  return /^[\w./-]+$/u.test(value) &&
    !isAbsolute(value) &&
    !value.split("/").includes("..")
    ? value
    : "<invalid identity>";
}

export class BlueprintRepository {
  constructor(readonly root: string) {}

  private async location(): Promise<{
    dir: string;
    gitdir: string;
    scope: string;
  }> {
    const dir = await git.findRoot({ fs, filepath: resolve(this.root) });
    let gitdir = join(dir, ".git");
    if (fs.statSync(gitdir).isFile())
      gitdir = resolve(
        dir,
        fs
          .readFileSync(gitdir, "utf8")
          .trim()
          .replace(/^gitdir: /u, ""),
      );
    return { dir, gitdir, scope: relative(dir, resolve(this.root)) };
  }

  private objectDirectory(gitdir: string): string {
    const common = join(gitdir, "commondir");
    return fs.existsSync(common)
      ? resolve(gitdir, fs.readFileSync(common, "utf8").trim())
      : gitdir;
  }

  async pin(revision: string): Promise<string> {
    try {
      const { gitdir } = await this.location();
      const common = this.objectDirectory(gitdir);
      // HEAD belongs to the linked worktree; its branch refs and objects are shared.
      const ref =
        revision === "HEAD" && common !== gitdir
          ? fs
              .readFileSync(join(gitdir, "HEAD"), "utf8")
              .trim()
              .replace(/^ref: /u, "")
          : revision;
      const oid = await git.resolveRef({ fs, gitdir: common, ref });
      return (await git.readCommit({ fs, gitdir: common, oid })).oid;
    } catch {
      throw new Error(
        `Cannot load blueprint revision ${safeIdentity(revision)}: ensure the commit is present in the local repository`,
      );
    }
  }

  async tree<T>(
    commit: string,
    consume: (root: string, files: readonly string[]) => T,
  ): Promise<T> {
    const temporary = fs.mkdtempSync(join(tmpdir(), "heddle-blueprints-"));
    try {
      const files: string[] = [];
      const links: { path: string; target: string }[] = [];
      try {
        const location = await this.location();
        const gitdir = this.objectDirectory(location.gitdir);
        const write = async (oid: string, directory: string): Promise<void> => {
          const { tree } = await git.readTree({ fs, gitdir, oid });
          for (const entry of tree) {
            const path = join(directory, entry.path);
            if (entry.type === "tree") {
              fs.mkdirSync(path, { recursive: true });
              await write(entry.oid, path);
            } else if (entry.type === "blob") {
              const { blob } = await git.readBlob({
                fs,
                gitdir,
                oid: entry.oid,
              });
              files.push(path);
              if (entry.mode === "120000")
                links.push({
                  path,
                  target: Buffer.from(blob).toString("utf8"),
                });
              else fs.writeFileSync(path, blob);
            }
          }
        };
        const { oid } = await git.readTree({
          fs,
          gitdir,
          oid: commit,
          ...(location.scope
            ? { filepath: location.scope.split(sep).join("/") }
            : {}),
        });
        await write(oid, temporary);
      } catch {
        throw new Error(
          `Cannot read blueprint tree at revision ${safeIdentity(commit)}: ensure its objects and configured directory are present`,
        );
      }
      // Outside links are absent from the snapshot. The existing reference validator
      // reports them as missing; no host content can enter discovery or validation.
      for (const link of links)
        if (
          !isAbsolute(link.target) &&
          beside(temporary, resolve(dirname(link.path), link.target))
        )
          fs.symlinkSync(link.target, link.path);
      return consume(temporary, files);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}
