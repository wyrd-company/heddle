// ---
// relationships:
//   implements: heddle
// ---

import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

import {
  BlueprintValidationError,
  type BlueprintRepositoryTransaction,
  type WorkingBlueprintArtifact,
} from "../engine/index.js";
import { acquireRepositoryWriterLease } from "../engine/repository-writer-lease.js";
import type { RepositoryWriterLease } from "../engine/repository-writer-lease.js";
import type { SqlitePersistence } from "../persistence/index.js";
import type { DurableAttentionQueue } from "./durable-adapters.js";

const execute = promisify(execFile);
const sourceRef = "@{upstream}";
const originRemoteRefPrefix = "refs/remotes/origin/";
const originFetchRefspec = "+refs/heads/*:refs/remotes/origin/*";
const stateAttentionPrefix = "blueprint-repository:state:";
const pushAttentionPrefix = "blueprint-repository:push:";

type RepositoryState = {
  code:
    | "blueprint-repository-behind"
    | "blueprint-repository-diverged"
    | "blueprint-repository-dirty"
    | "blueprint-repository-unpushed";
  localCommit: string;
  message: string;
  upstreamCommit: string;
};

export type BlueprintRepositoryAttention = {
  attentionId: string;
  category: "push" | "state";
  code: string;
  commit?: string;
  kind: "blueprint-repository";
  message: string;
  repositoryRoot: string;
};

export class BlueprintPushError extends Error {
  public constructor(public readonly commit: string) {
    super(`Blueprint commit '${commit}' could not be pushed`);
    this.name = "BlueprintPushError";
  }
}

const parseCounts = (value: string): { ahead: number; behind: number } => {
  const match = /^([0-9]+)\s+([0-9]+)\s*$/.exec(value);
  if (match === null) {
    throw new BlueprintValidationError(
      "Blueprint repository divergence could not be determined",
    );
  }
  return { ahead: Number(match[1]), behind: Number(match[2]) };
};

export class OrganizationBlueprintRepository {
  public readonly repositoryRoot: string;
  public readonly sourceRef = sourceRef;

  public constructor(
    repositoryRoot: string,
    private readonly persistence: SqlitePersistence,
    private readonly attention: DurableAttentionQueue,
  ) {
    this.repositoryRoot = resolve(repositoryRoot);
  }

  transaction(): BlueprintRepositoryTransaction {
    return {
      beforeReplace: async (lease) => this.assertEditable(lease),
      afterReplace: async (artifact, lease) =>
        this.commitAndPush(artifact, lease),
    };
  }

  async synchronize(): Promise<void> {
    const lease = await acquireRepositoryWriterLease(this.repositoryRoot);
    try {
      await lease.assertOwned();
      try {
        await execute(
          "git",
          [
            "fetch",
            "--no-tags",
            "--prune",
            "--refmap=",
            "origin",
            originFetchRefspec,
          ],
          { cwd: this.repositoryRoot },
        );
      } catch {
        await this.replaceStateAttention({
          attentionId: `${stateAttentionPrefix}fetch-failed`,
          category: "state",
          code: "blueprint-repository-fetch-failed",
          kind: "blueprint-repository",
          message:
            "The organization blueprint repository could not fetch origin",
          repositoryRoot: this.repositoryRoot,
        });
        throw new BlueprintValidationError(
          "The organization blueprint repository could not fetch origin",
        );
      }
      await lease.assertOwned();
      const state = await this.state();
      if (state === undefined) {
        await this.replaceStateAttention(undefined);
        await this.resolveIfActive(
          `${pushAttentionPrefix}${await this.head()}`,
        );
        return;
      }
      await this.replaceStateAttention(this.stateAttention(state));
    } finally {
      await lease.release();
    }
  }

  private async assertEditable(lease: RepositoryWriterLease): Promise<void> {
    await lease.assertOwned();
    const state = await this.state();
    if (state === undefined) return;
    await this.replaceStateAttention(this.stateAttention(state));
    throw new BlueprintValidationError(
      "The organization blueprint repository is not clean and synchronized with origin",
    );
  }

  private async commitAndPush(
    artifact: WorkingBlueprintArtifact,
    lease: RepositoryWriterLease,
  ): Promise<void> {
    await lease.assertOwned();
    await execute("git", ["add", "--", artifact.path], {
      cwd: this.repositoryRoot,
    });
    const changed = await execute(
      "git",
      ["diff", "--cached", "--quiet", "--", artifact.path],
      { cwd: this.repositoryRoot },
    ).then(
      () => false,
      (error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === 1
        ) {
          return true;
        }
        throw error;
      },
    );
    if (!changed) return;
    await execute(
      "git",
      [
        "commit",
        "--only",
        "--message",
        `Update ${basename(artifact.path, ".json")} lifecycle blueprint`,
        "--",
        artifact.path,
      ],
      { cwd: this.repositoryRoot },
    );
    await lease.assertOwned();
    const commit = await this.head();
    try {
      await execute(
        "git",
        [
          "push",
          "--porcelain",
          "origin",
          `HEAD:${await this.originBranchRef()}`,
        ],
        { cwd: this.repositoryRoot },
      );
    } catch {
      await this.attention.raise({
        attentionId: `${pushAttentionPrefix}${commit}`,
        category: "push",
        code: "blueprint-repository-push-failed",
        commit,
        kind: "blueprint-repository",
        message: `Blueprint commit '${commit}' is retained locally and was not pushed`,
        repositoryRoot: this.repositoryRoot,
      });
      throw new BlueprintPushError(commit);
    }
  }

  private async state(): Promise<RepositoryState | undefined> {
    await this.assertOriginUpstream();
    const [{ stdout: status }, localCommit, { stdout: countOutput }] =
      await Promise.all([
        execute("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
          cwd: this.repositoryRoot,
        }),
        this.head(),
        execute(
          "git",
          ["rev-list", "--left-right", "--count", `HEAD...${sourceRef}`],
          {
            cwd: this.repositoryRoot,
          },
        ),
      ]);
    const { stdout: upstreamOutput } = await execute(
      "git",
      ["rev-parse", "--verify", "--end-of-options", `${sourceRef}^{commit}`],
      { cwd: this.repositoryRoot },
    );
    const upstreamCommit = upstreamOutput.trim();
    if (status !== "") {
      return {
        code: "blueprint-repository-dirty",
        localCommit,
        message:
          "The organization blueprint repository working tree has local changes",
        upstreamCommit,
      };
    }
    const counts = parseCounts(countOutput);
    if (counts.ahead > 0 && counts.behind > 0) {
      return {
        code: "blueprint-repository-diverged",
        localCommit,
        message:
          "The organization blueprint repository has diverged from origin",
        upstreamCommit,
      };
    }
    if (counts.ahead > 0) {
      return {
        code: "blueprint-repository-unpushed",
        localCommit,
        message: "The organization blueprint repository has unpushed commits",
        upstreamCommit,
      };
    }
    if (counts.behind > 0) {
      return {
        code: "blueprint-repository-behind",
        localCommit,
        message:
          "The organization blueprint repository branch is behind origin",
        upstreamCommit,
      };
    }
    return undefined;
  }

  private async assertOriginUpstream(): Promise<void> {
    await this.originBranchRef();
  }

  private async originBranchRef(): Promise<string> {
    const { stdout } = await execute(
      "git",
      ["rev-parse", "--symbolic-full-name", sourceRef],
      { cwd: this.repositoryRoot },
    );
    const upstreamRef = stdout.trim();
    if (
      !upstreamRef.startsWith(originRemoteRefPrefix) ||
      upstreamRef.length === originRemoteRefPrefix.length
    ) {
      throw new BlueprintValidationError(
        "The organization blueprint repository branch must track origin",
      );
    }
    return `refs/heads/${upstreamRef.slice(originRemoteRefPrefix.length)}`;
  }

  private async head(): Promise<string> {
    const { stdout } = await execute(
      "git",
      ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
      { cwd: this.repositoryRoot },
    );
    return stdout.trim();
  }

  private stateAttention(state: RepositoryState): BlueprintRepositoryAttention {
    return {
      attentionId: `${stateAttentionPrefix}${state.code}:${state.localCommit}:${state.upstreamCommit}`,
      category: "state",
      code: state.code,
      kind: "blueprint-repository",
      message: state.message,
      repositoryRoot: this.repositoryRoot,
    };
  }

  private async replaceStateAttention(
    current: BlueprintRepositoryAttention | undefined,
  ): Promise<void> {
    for (const record of this.persistence.listAttention()) {
      const payload = record.payload;
      if (
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload) &&
        payload["kind"] === "blueprint-repository" &&
        payload["category"] === "state" &&
        record.attentionId !== current?.attentionId
      ) {
        this.attention.resolve(record.attentionId);
      }
    }
    if (
      current !== undefined &&
      !(await this.attention.has(current.attentionId))
    ) {
      await this.attention.raise(current);
    }
  }

  private async resolveIfActive(attentionId: string): Promise<void> {
    if (
      this.persistence
        .listAttention()
        .some((record) => record.attentionId === attentionId)
    ) {
      this.attention.resolve(attentionId);
    }
  }
}
