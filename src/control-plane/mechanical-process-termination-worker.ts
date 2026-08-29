// ---
// relationships:
//   verifies: heddle
// ---

import { readFile } from "node:fs/promises";
import process from "node:process";
import { setInterval } from "node:timers";

import { LifecycleEngine, type ResumeLifecycleInput } from "../engine/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import { createMechanicalNodeEffects } from "./mechanical-node-effects.js";
import {
  defaultMechanicalCommand,
  type CommandRunner,
  type MechanicalChangeContext,
} from "./review-snapshot.js";

export type MechanicalTerminationBoundary =
  | "approval-recorded"
  | "approval-worktree-provisioned"
  | "approval-worktree-removed"
  | "cleanup-ref-deleted"
  | "exact-base-integrated"
  | "exact-base-leased"
  | "source-worktree-removed";

interface WorkerConfiguration {
  boundary?: MechanicalTerminationBoundary;
  change: MechanicalChangeContext;
  repositoryRoot: string;
  resume: ResumeLifecycleInput;
  stateDirectory: string;
}

interface BoundaryInstruction {
  arguments: string[];
  executable: string;
  input?: string;
  phase: "after" | "before";
}

const instructionMatches = (
  boundary: MechanicalTerminationBoundary,
  change: MechanicalChangeContext,
  instruction: BoundaryInstruction,
): boolean => {
  const { arguments: arguments_, executable, input, phase } = instruction;
  const approvalPath = `${change.worktreeName}.merge-base`;
  switch (boundary) {
    case "exact-base-integrated":
      return (
        phase === "after" &&
        executable === "git" &&
        arguments_[0] === "update-ref" &&
        arguments_[1] === "--stdin" &&
        input?.includes(`update refs/heads/${change.baseBranch} `) === true
      );
    case "approval-worktree-provisioned":
      return (
        phase === "after" &&
        executable === "git" &&
        arguments_[0] === "worktree" &&
        arguments_[1] === "add" &&
        arguments_.some((argument) => argument.includes(approvalPath))
      );
    case "exact-base-leased":
      return (
        phase === "before" &&
        executable === "gitpr" &&
        arguments_[0] === "merge"
      );
    case "approval-recorded":
      return (
        phase === "after" && executable === "gitpr" && arguments_[0] === "merge"
      );
    case "approval-worktree-removed":
      return (
        phase === "after" &&
        executable === "git" &&
        arguments_[0] === "worktree" &&
        arguments_[1] === "remove" &&
        arguments_.some((argument) => argument.includes(approvalPath))
      );
    case "source-worktree-removed":
      return (
        phase === "after" &&
        executable === "git" &&
        arguments_[0] === "worktree" &&
        arguments_[1] === "remove" &&
        arguments_.at(-1)?.endsWith(`/${change.worktreeName}`) === true
      );
    case "cleanup-ref-deleted":
      return (
        phase === "after" &&
        executable === "git" &&
        arguments_[0] === "update-ref" &&
        arguments_[1] === "--stdin" &&
        input?.includes(`delete refs/heads/${change.branch} `) === true
      );
  }
};

const writeRecord = async (record: Record<string, unknown>): Promise<void> =>
  new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(record)}\n`, (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });

const stopAtBoundary = async (
  boundary: MechanicalTerminationBoundary,
  instruction: BoundaryInstruction,
): Promise<never> => {
  await writeRecord({
    arguments: instruction.arguments,
    boundary,
    executable: instruction.executable,
    input: instruction.input,
    kind: "boundary",
    phase: instruction.phase,
    pid: process.pid,
  });
  return new Promise<never>(() => {
    setInterval(() => undefined, 60_000);
  });
};

const main = async (): Promise<void> => {
  const configurationPath = process.argv[2];
  if (configurationPath === undefined) {
    throw new TypeError("Worker configuration path is required");
  }
  const configuration = JSON.parse(
    await readFile(configurationPath, "utf8"),
  ) as WorkerConfiguration;
  let markerEmitted = false;
  const command: CommandRunner = async (cwd, executable, arguments_, input) => {
    const before = {
      arguments: arguments_,
      executable,
      input,
      phase: "before",
    } as const;
    if (
      !markerEmitted &&
      configuration.boundary !== undefined &&
      instructionMatches(configuration.boundary, configuration.change, before)
    ) {
      markerEmitted = true;
      return stopAtBoundary(configuration.boundary, before);
    }
    const output = await defaultMechanicalCommand(
      cwd,
      executable,
      arguments_,
      input,
    );
    const after = {
      arguments: arguments_,
      executable,
      input,
      phase: "after",
    } as const;
    if (
      !markerEmitted &&
      configuration.boundary !== undefined &&
      instructionMatches(configuration.boundary, configuration.change, after)
    ) {
      markerEmitted = true;
      return stopAtBoundary(configuration.boundary, after);
    }
    return output;
  };

  const persistence = new SqlitePersistence({
    stateDirectory: configuration.stateDirectory,
  });
  try {
    const engine = new LifecycleEngine({
      effects: createMechanicalNodeEffects({ command }),
      persistence,
      repositoryRoot: configuration.repositoryRoot,
    });
    const result = await engine.resume(configuration.resume);
    if (configuration.boundary !== undefined && !markerEmitted) {
      throw new Error(`Boundary ${configuration.boundary} was not reached`);
    }
    await writeRecord({ kind: "result", result });
  } finally {
    persistence.close();
  }
};

main().catch(async (error: unknown) => {
  await writeRecord({
    kind: "error",
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "UnknownError",
  });
  process.exitCode = 1;
});
