// ---
// relationships:
//   implements: heddle
// ---

import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import koffi from "koffi";

/**
 * The lock file kanban-md takes across its own allocation, named from the
 * board directory exactly as the CLI names it.
 */
const LOCK_FILE_NAME = ".lock";

/** kanban-md creates the lock file with these bits; match them. */
const LOCK_FILE_MODE = 0o600;

/** `flock(2)` operations, from `sys/file.h`. */
const LOCK_EX = 2;
const LOCK_UN = 8;

interface FlockBinding {
  (fd: number, operation: number): number;
  async: (
    fd: number,
    operation: number,
    callback: (error: unknown, result: number) => void,
  ) => void;
}

let binding: FlockBinding | undefined;

/**
 * Resolves libc's `flock` once. kanban-md locks with `syscall.Flock`, which is
 * `flock(2)`; POSIX record locks (`fcntl`) are a separate lock space on Linux
 * and would not exclude it, so the call has to be this one.
 */
const flock = (): FlockBinding => {
  binding ??= koffi
    .load("libc.so.6")
    .func("int flock(int fd, int operation)") as FlockBinding;
  return binding;
};

const callFlock = async (fd: number, operation: number): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    flock().async(fd, operation, (error, result) => {
      if (error !== null && error !== undefined) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (result !== 0) {
        reject(new Error(`flock returned ${result}`));
        return;
      }
      resolve();
    });
  });
};

/**
 * Runs `work` while holding kanban-md's board lock.
 *
 * Acquisition is asynchronous, so waiting for the CLI to finish its own
 * allocation never blocks the event loop, and it is unbounded: a bound would
 * refuse valid work rather than wait out contention.
 *
 * The lock is released and the descriptor closed on every path. Closing alone
 * would release it, because the kernel drops a `flock` when the last
 * descriptor for its open file description closes — including when the process
 * exits, normally or not.
 */
export const withBoardLock = async <T>(
  boardDirectory: string,
  work: () => Promise<T>,
): Promise<T> => {
  const handle: FileHandle = await open(
    join(boardDirectory, LOCK_FILE_NAME),
    "a+",
    LOCK_FILE_MODE,
  );
  try {
    await callFlock(handle.fd, LOCK_EX);
    try {
      return await work();
    } finally {
      await callFlock(handle.fd, LOCK_UN).catch(() => undefined);
    }
  } finally {
    await handle.close();
  }
};
