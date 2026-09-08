// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type {
  IncidentRuntimeRecord,
  InstanceRecord,
  InstanceState,
  ReconcilerRuntimeRecord,
} from "../persistence/index.js";
import { AgentNameAllocator } from "./allocator.js";
import { GitAgentNameThemeCatalog } from "./theme-catalog.js";

const execute = promisify(execFile);
const roots: string[] = [];
const header = `$schema: https://wyrd.company/heddle/agent-name-theme.schema.json
relationships:
  implements: heddle
`;
const team = (prefix: string) => `${header}kind: team
leader: ${prefix}-lead
companions: [${prefix}-companion-one, ${prefix}-companion-two]
allies: [${prefix}-ally-one, ${prefix}-ally-two]
antagonists: [${prefix}-antagonist-one, ${prefix}-antagonist-two]
neutrals: [${prefix}-neutral-one, ${prefix}-neutral-two]
`;
const soloist = `${header}kind: soloist
heroes: [solo-hero-one, solo-hero-two]
villains: [solo-villain-one, solo-villain-two]
bystanders: [solo-bystander-one, solo-bystander-two]
`;

const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "heddle-agent-name-allocator-"));
  roots.push(root);
  await mkdir(join(root, "themes"));
  await writeFile(join(root, "themes", "alpha.yml"), team("alpha"));
  await writeFile(join(root, "themes", "beta.yml"), team("beta"));
  await writeFile(join(root, "themes", "solo.yml"), soloist);
  await execute("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: root,
  });
  await execute("git", ["add", "themes"], { cwd: root });
  await execute(
    "git",
    [
      "-c",
      "user.name=Fixture User",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Add themes",
    ],
    { cwd: root },
  );
  return root;
};

const state = (): InstanceState => ({
  correlationTokens: {},
  flowcraftContext: null,
  handoffs: [],
  todoState: null,
});

class MemoryStore {
  readonly instances = new Map<string, InstanceRecord>();
  incidentRuntime: IncidentRuntimeRecord[] = [];
  reconcilerRuntime: ReconcilerRuntimeRecord[] = [];

  create(instanceId: string): void {
    this.instances.set(instanceId, { instanceId, state: state(), version: 1 });
  }

  compareAndSwapInstance(
    instanceId: string,
    expectedVersion: number,
    nextState: InstanceState,
  ): InstanceRecord | undefined {
    const current = this.instances.get(instanceId);
    if (current === undefined || current.version !== expectedVersion) {
      return undefined;
    }
    const next = { ...current, state: nextState, version: current.version + 1 };
    this.instances.set(instanceId, next);
    return next;
  }

  getInstance(instanceId: string): InstanceRecord | undefined {
    return this.instances.get(instanceId);
  }

  listIncidentRuntime(): IncidentRuntimeRecord[] {
    return this.incidentRuntime;
  }

  listInstances(): InstanceRecord[] {
    return [...this.instances.values()];
  }

  listReconcilerRuntime(): ReconcilerRuntimeRecord[] {
    return this.reconcilerRuntime;
  }

  running(...instanceIds: string[]): void {
    this.reconcilerRuntime = instanceIds.map((instanceId, index) => ({
      boardStatus: "active",
      instanceId,
      state: "running",
      taskId: index + 1,
    }));
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("agent-name allocator", () => {
  it("rotates team themes and uses the sole soloist theme", async () => {
    const root = await repository();
    const store = new MemoryStore();
    for (const instanceId of ["task-one", "task-two", "task-three", "ad-hoc"]) {
      store.create(instanceId);
    }
    const catalog = new GitAgentNameThemeCatalog(root, "HEAD");
    const allocator = new AgentNameAllocator(catalog, store);

    await expect(
      allocator.prepareTask("task-one", "team"),
    ).resolves.toMatchObject({ themeId: "alpha" });
    await expect(
      allocator.prepareTask("task-two", "team"),
    ).resolves.toMatchObject({ themeId: "beta" });
    await expect(
      allocator.prepareTask("task-three", "team"),
    ).resolves.toMatchObject({ themeId: "alpha" });
    await expect(
      allocator.prepareTask("ad-hoc", "soloist"),
    ).resolves.toMatchObject({ themeId: "solo" });
    const pinnedCommit =
      store.getInstance("task-one")!.state.agentNames!.catalogCommit;
    await expect(
      execute(
        "git",
        [
          "rev-parse",
          "--verify",
          `refs/heddle/agent-name-themes/${pinnedCommit}`,
        ],
        { cwd: root },
      ),
    ).resolves.toMatchObject({ stdout: `${pinnedCommit}\n` });
  });

  it("keeps one task and list stable while assigning different lists uniquely", async () => {
    const root = await repository();
    const store = new MemoryStore();
    store.create("task-one");
    store.running("task-one");
    const allocator = new AgentNameAllocator(
      new GitAgentNameThemeCatalog(root, "HEAD"),
      store,
    );
    await allocator.prepareTask("task-one", "team");

    const first = await allocator.assign("task-one", "allies");

    await expect(allocator.assign("task-one", "allies")).resolves.toBe(first);
    await expect(allocator.assign("task-one", "antagonists")).resolves.not.toBe(
      first,
    );
  });

  it("allocates later lists from the task-pinned catalog after current themes change", async () => {
    const root = await repository();
    const store = new MemoryStore();
    store.create("task-one");
    store.running("task-one");
    const allocator = new AgentNameAllocator(
      new GitAgentNameThemeCatalog(root, "HEAD"),
      store,
    );
    await allocator.prepareTask("task-one", "team");
    await writeFile(
      join(root, "themes", "alpha.yml"),
      team("alpha").replaceAll("alpha-ally", "changed-ally"),
    );
    await execute("git", ["add", "themes/alpha.yml"], { cwd: root });
    await execute(
      "git",
      [
        "-c",
        "user.name=Fixture User",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Change current names",
      ],
      { cwd: root },
    );

    await expect(allocator.assign("task-one", "allies")).resolves.toBe(
      "alpha-ally-one",
    );
  });

  it("locks names across running tasks and releases them only at done", async () => {
    const root = await repository();
    const store = new MemoryStore();
    const instanceIds = [
      "task-one",
      "task-two",
      "task-three",
      "task-four",
      "task-five",
    ];
    for (const instanceId of instanceIds) {
      store.create(instanceId);
    }
    store.running("task-one", "task-three", "task-five");
    const catalog = new GitAgentNameThemeCatalog(root, "HEAD");
    const allocator = new AgentNameAllocator(catalog, store);
    for (const instanceId of instanceIds) {
      await allocator.prepareTask(instanceId, "team");
    }

    const read = catalog.read.bind(catalog);
    let readers = 0;
    let releaseReaders!: () => void;
    const bothReadersReady = new Promise<void>((resolve) => {
      releaseReaders = resolve;
    });
    catalog.read = async (commit) => {
      const themes = await read(commit);
      readers += 1;
      if (readers === 2) releaseReaders();
      await bothReadersReady;
      return themes;
    };

    const [first, second] = await Promise.all([
      allocator.assign("task-one", "allies"),
      allocator.assign("task-three", "allies"),
    ]);
    expect(first).not.toBe(second);
    await expect(allocator.assign("task-five", "allies")).rejects.toThrow(
      "locked by a running task",
    );

    store.reconcilerRuntime = store.reconcilerRuntime.map((runtime) =>
      runtime.instanceId === "task-one"
        ? { ...runtime, state: "done" }
        : runtime,
    );
    await expect(allocator.assign("task-five", "allies")).resolves.toBe(first);
  });

  it("holds incident assignments while an incident remains failed", async () => {
    const root = await repository();
    const store = new MemoryStore();
    store.create("incident-one");
    store.create("ad-hoc");
    store.running("ad-hoc");
    store.incidentRuntime = [
      {
        accepted: false,
        attentionId: "attention-one",
        code: "sample-code",
        createdAt: 1,
        incidentId: "incident-one",
        rejectionOperationIds: [],
        state: "failed",
        taskId: 1,
      },
    ];
    const allocator = new AgentNameAllocator(
      new GitAgentNameThemeCatalog(root, "HEAD"),
      store,
    );
    await allocator.prepareTask("incident-one", "soloist");
    await allocator.prepareTask("ad-hoc", "soloist");

    const incidentName = await allocator.assign("incident-one", "heroes");

    await expect(allocator.assign("ad-hoc", "heroes")).resolves.not.toBe(
      incidentName,
    );
  });

  it("fails before dispatch when a stage list does not match the task theme", async () => {
    const root = await repository();
    const store = new MemoryStore();
    store.create("ad-hoc");
    store.running("ad-hoc");
    const allocator = new AgentNameAllocator(
      new GitAgentNameThemeCatalog(root, "HEAD"),
      store,
    );
    await allocator.prepareTask("ad-hoc", "soloist");

    await expect(allocator.assign("ad-hoc", "allies")).rejects.toThrow(
      'list "allies" does not exist in soloist theme',
    );
  });

  it("revalidates the current catalog before preparing each new task", async () => {
    const root = await repository();
    const store = new MemoryStore();
    store.create("task-one");
    store.create("task-two");
    const allocator = new AgentNameAllocator(
      new GitAgentNameThemeCatalog(root, "HEAD"),
      store,
    );
    await allocator.prepareTask("task-one", "team");
    await writeFile(
      join(root, "themes", "alpha.yml"),
      team("alpha").replace("leader: alpha-lead", "leader: alpha-ally-one"),
    );
    await execute("git", ["add", "themes/alpha.yml"], { cwd: root });
    await execute(
      "git",
      [
        "-c",
        "user.name=Fixture User",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Invalidate current catalog",
      ],
      { cwd: root },
    );

    await expect(allocator.prepareTask("task-two", "team")).rejects.toThrow(
      'Agent name "alpha-ally-one" is repeated',
    );
    expect(store.getInstance("task-two")!.state.agentNames).toBeUndefined();
  });
});
