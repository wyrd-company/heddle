// ---
// relationships:
//   verifies: heddle
//   references: t3-headless
// ---

import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/** The operator's live control plane. */
export const LIVE_T3_PORT = 3773;

/** The operator's live board. Heddle is its single writer of child status. */
export const LIVE_BOARD_DIRECTORY = "/workspaces/kanban";

export class QualificationIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualificationIsolationError";
  }
}

/** Refuse any qualification surface that could reach operator state. */
export const assertQualificationIsolation = (surface: {
  readonly boardDirectory: string;
  readonly port: number;
  readonly stateDirectory: string;
  readonly t3BaseDirectory: string;
}): void => {
  if (surface.port === LIVE_T3_PORT) {
    throw new QualificationIsolationError(
      "Refusing the operator's live T3 port " + LIVE_T3_PORT,
    );
  }
  const board = resolve(surface.boardDirectory);
  if (
    board === LIVE_BOARD_DIRECTORY ||
    board.startsWith(LIVE_BOARD_DIRECTORY + sep)
  ) {
    throw new QualificationIsolationError(
      "Refusing the operator's live board at " + LIVE_BOARD_DIRECTORY,
    );
  }
  const scratch = resolve(tmpdir());
  for (const [label, directory] of [
    ["T3 base directory", surface.t3BaseDirectory],
    ["state directory", surface.stateDirectory],
  ] as const) {
    const resolved = resolve(directory);
    if (resolved !== scratch && !resolved.startsWith(scratch + sep)) {
      throw new QualificationIsolationError(
        "Refusing a " + label + " outside the scratch root: " + resolved,
      );
    }
  }
};

const errorCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;

const filesystemIdentity = async (directory: string): Promise<string> => {
  const missingSegments: string[] = [];
  let candidate = resolve(directory);
  for (;;) {
    try {
      return join(await realpath(candidate), ...missingSegments);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new QualificationIsolationError(
          "Unable to resolve qualification path identity: " + candidate,
        );
      }
    }

    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new QualificationIsolationError(
          "Unable to inspect qualification path identity: " + candidate,
        );
      }
    }
    if (metadata?.isSymbolicLink()) {
      throw new QualificationIsolationError(
        "Refusing a qualification path through a dangling link: " + candidate,
      );
    }

    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new QualificationIsolationError(
        "Unable to resolve qualification path identity: " + directory,
      );
    }
    missingSegments.unshift(basename(candidate));
    candidate = parent;
  }
};

const isWithin = (candidate: string, root: string): boolean =>
  candidate === root || candidate.startsWith(root + sep);

export const assertQualificationFilesystemIsolation = async (
  scratch: string,
  derivedPaths: readonly string[],
): Promise<void> => {
  const [physicalScratchRoot, physicalLiveBoard, physicalScratch] =
    await Promise.all([
      filesystemIdentity(tmpdir()),
      filesystemIdentity(LIVE_BOARD_DIRECTORY),
      filesystemIdentity(scratch),
    ]);
  if (
    !isWithin(physicalScratch, physicalScratchRoot) ||
    isWithin(physicalScratch, physicalLiveBoard)
  ) {
    throw new QualificationIsolationError(
      "Refusing a scratch directory outside the physical scratch root: " +
        physicalScratch,
    );
  }
  for (const directory of derivedPaths) {
    const identity = await filesystemIdentity(directory);
    if (
      !isWithin(identity, physicalScratch) ||
      isWithin(identity, physicalLiveBoard)
    ) {
      throw new QualificationIsolationError(
        "Refusing a derived qualification path outside its scratch identity: " +
          identity,
      );
    }
  }
};
