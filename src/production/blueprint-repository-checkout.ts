// ---
// relationships:
//   implements: heddle
// ---

import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";

import { BlueprintValidationError } from "../engine/index.js";

const execute = promisify(execFile);
const originRemoteRefPrefix = "refs/remotes/origin/";

type RepositoryBinding = {
  branch: string;
  fetchUrl: string;
  pushUrl: string;
  upstreamCommit: string;
  upstreamRef: string;
};

const repositoryError = (description: string): BlueprintValidationError =>
  new BlueprintValidationError(`The organization blueprint ${description}`);

const canonicalizePotentialPath = async (path: string): Promise<string> => {
  let existingAncestor = resolve(path);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(existingAncestor), ...missingSegments);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      missingSegments.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
};

const containsPath = (parent: string, candidate: string): boolean => {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (!isAbsolute(pathFromParent) &&
      pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`))
  );
};

const assertDisjointRoots = async (
  sourceRoot: string,
  checkoutRoot: string,
): Promise<void> => {
  const [source, checkout] = await Promise.all([
    realpath(sourceRoot),
    canonicalizePotentialPath(checkoutRoot),
  ]);
  if (containsPath(source, checkout) || containsPath(checkout, source)) {
    throw repositoryError(
      "shared source and worker synchronization checkout must resolve to disjoint directories",
    );
  }
};

const normalizeRemoteUrl = (repositoryRoot: string, url: string): string => {
  if (isAbsolute(url) || url.includes("://") || /^[^/]+:[^/]/u.test(url)) {
    return url;
  }
  return resolve(repositoryRoot, url);
};

const inspectRepository = async (
  repositoryRoot: string,
  ownership: "shared source" | "worker synchronization checkout",
): Promise<RepositoryBinding> => {
  const root = resolve(repositoryRoot);
  try {
    const metadata = await stat(root);
    if (!metadata.isDirectory()) throw new Error("not a directory");
    const [topLevel, branch, upstream, upstreamCommit, fetchUrl, pushUrl] =
      await Promise.all([
        execute("git", ["rev-parse", "--show-toplevel"], { cwd: root }),
        execute("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
          cwd: root,
        }),
        execute("git", ["rev-parse", "--symbolic-full-name", "@{upstream}"], {
          cwd: root,
        }),
        execute(
          "git",
          ["rev-parse", "--verify", "--end-of-options", "@{upstream}^{commit}"],
          { cwd: root },
        ),
        execute("git", ["remote", "get-url", "origin"], { cwd: root }),
        execute("git", ["remote", "get-url", "--push", "origin"], {
          cwd: root,
        }),
      ]);
    if ((await realpath(topLevel.stdout.trim())) !== (await realpath(root))) {
      throw new Error("not the clone root");
    }
    const upstreamRef = upstream.stdout.trim();
    if (
      !upstreamRef.startsWith(originRemoteRefPrefix) ||
      upstreamRef.length === originRemoteRefPrefix.length
    ) {
      throw new Error("not tracking origin");
    }
    return {
      branch: branch.stdout.trim(),
      fetchUrl: normalizeRemoteUrl(root, fetchUrl.stdout.trim()),
      pushUrl: normalizeRemoteUrl(root, pushUrl.stdout.trim()),
      upstreamCommit: upstreamCommit.stdout.trim(),
      upstreamRef,
    };
  } catch (error) {
    if (error instanceof BlueprintValidationError) throw error;
    throw repositoryError(
      `${ownership} '${root}' must be a Git clone root whose current branch tracks origin`,
    );
  }
};

const assertSameBinding = (
  source: RepositoryBinding,
  checkout: RepositoryBinding,
): void => {
  if (
    source.fetchUrl !== checkout.fetchUrl ||
    source.pushUrl !== checkout.pushUrl ||
    source.upstreamRef !== checkout.upstreamRef
  ) {
    throw repositoryError(
      "worker synchronization checkout does not match the shared source's origin and upstream branch",
    );
  }
};

const setOptionalIdentity = async (
  sourceRoot: string,
  checkoutRoot: string,
  key: "user.email" | "user.name",
): Promise<void> => {
  const value = await execute("git", ["config", "--get", key], {
    cwd: sourceRoot,
  }).then(
    ({ stdout }) => stdout.trim(),
    (error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 1
      ) {
        return undefined;
      }
      throw error;
    },
  );
  if (value !== undefined && value !== "") {
    await execute("git", ["config", "--local", key, value], {
      cwd: checkoutRoot,
    });
  }
};

const seedCheckout = async (
  sourceRoot: string,
  checkoutRoot: string,
  source: RepositoryBinding,
): Promise<void> => {
  const parent = dirname(checkoutRoot);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, ".blueprints-checkout-"));
  let installed = false;
  try {
    await execute(
      "git",
      [
        "clone",
        "--quiet",
        "--no-hardlinks",
        "--no-tags",
        "--branch",
        source.branch,
        "--",
        sourceRoot,
        temporary,
      ],
      { cwd: parent },
    );
    await execute("git", ["remote", "set-url", "origin", source.fetchUrl], {
      cwd: temporary,
    });
    if (source.pushUrl !== source.fetchUrl) {
      await execute(
        "git",
        ["remote", "set-url", "--push", "origin", source.pushUrl],
        { cwd: temporary },
      );
    }
    await execute(
      "git",
      ["update-ref", source.upstreamRef, source.upstreamCommit],
      { cwd: temporary },
    );
    await execute(
      "git",
      [
        "branch",
        `--set-upstream-to=${source.upstreamRef.slice("refs/remotes/".length)}`,
        source.branch,
      ],
      { cwd: temporary },
    );
    await setOptionalIdentity(sourceRoot, temporary, "user.name");
    await setOptionalIdentity(sourceRoot, temporary, "user.email");
    await rename(temporary, checkoutRoot);
    installed = true;
  } catch (error) {
    if (error instanceof BlueprintValidationError) throw error;
    throw repositoryError(
      `worker synchronization checkout '${checkoutRoot}' could not be initialized from shared source '${sourceRoot}'`,
    );
  } finally {
    if (!installed) {
      await rm(temporary, { force: true, recursive: true });
    }
  }
};

export const prepareBlueprintRepositoryCheckout = async (input: {
  repositoryRoot: string;
  sourceRoot?: string;
}): Promise<void> => {
  const checkoutRoot = resolve(input.repositoryRoot);
  if (input.sourceRoot === undefined) return;
  const sourceRoot = resolve(input.sourceRoot);

  const source = await inspectRepository(sourceRoot, "shared source");
  await assertDisjointRoots(sourceRoot, checkoutRoot);
  const checkoutExists = await lstat(checkoutRoot).then(
    () => true,
    (error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    },
  );
  if (!checkoutExists) {
    await seedCheckout(sourceRoot, checkoutRoot, source);
  }
  const checkout = await inspectRepository(
    checkoutRoot,
    "worker synchronization checkout",
  );
  assertSameBinding(source, checkout);
};
