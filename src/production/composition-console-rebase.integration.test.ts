// ---
// relationships:
//   verifies: heddle
// ---

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startHeddleServer } from "../deployment/server.js";
import { readLifecycleContext } from "../engine/index.js";
import { createProductionComposition } from "./composition.js";
import {
  execute,
  prepareProductionFixture,
  SyntheticT3,
  type ProductionFixture,
} from "./composition.test-support.js";

describe("production console lifecycle rebase", () => {
  let fixture: ProductionFixture | undefined;
  let server: Awaited<ReturnType<typeof startHeddleServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    await fixture?.cleanup();
  });

  it("rebases one pinned instance through the console while fetch leaves another pinned", async () => {
    const prepared = await prepareProductionFixture();
    fixture = prepared;
    const composition = createProductionComposition({
      blueprintsRepositoryRoot: prepared.blueprintsRepositoryRoot,
      configuration: prepared.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    server = await startHeddleServer(
      { host: "127.0.0.1", port: 0 },
      { production: composition },
    );
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const initialResponse = await globalThis.fetch(
      `${baseUrl}/api/lifecycle?task=${prepared.taskId}&after=0`,
    );
    const initial = (await initialResponse.json()) as {
      blueprint: { blobHash: string };
      instanceId: string;
      rebase: {
        state: "available" | "current";
        targetBlueprintBlobHash: string;
      };
    };
    expect(initialResponse.status).toBe(200);
    expect(initial.rebase).toMatchObject({
      state: "current",
      targetBlueprintBlobHash: initial.blueprint.blobHash,
    });
    const control = await composition.lifecycle.start({
      blueprintPath: "blueprints/sample.json",
      instanceId: "control-instance",
    });
    expect(control.blueprintBlobHash).toBe(initial.blueprint.blobHash);

    const localHeadBefore = (
      await execute("git", ["rev-parse", "HEAD"], {
        cwd: prepared.blueprintsRepositoryRoot,
      })
    ).stdout.trim();
    const workingPath = join(
      prepared.blueprintsRepositoryRoot,
      "blueprints/sample.json",
    );
    const workingBytesBefore = await readFile(workingPath, "utf8");
    const remote = (
      await execute("git", ["remote", "get-url", "origin"], {
        cwd: prepared.blueprintsRepositoryRoot,
      })
    ).stdout.trim();
    const publisher = join(prepared.root, "blueprint-publisher");
    await execute(
      "git",
      ["clone", "--quiet", "--branch", "main", remote, publisher],
      {
        cwd: prepared.root,
      },
    );
    await execute("git", ["config", "user.name", "Fixture User"], {
      cwd: publisher,
    });
    await execute("git", ["config", "user.email", "fixture@example.invalid"], {
      cwd: publisher,
    });
    const publisherPath = join(publisher, "blueprints/sample.json");
    const revised = JSON.parse(await readFile(publisherPath, "utf8")) as {
      edges: Array<Record<string, unknown>>;
      nodes: Array<Record<string, unknown>>;
    };
    const review = revised.nodes.find(({ id }) => id === "review");
    const opening = revised.edges.find(
      ({ source, target }) => source === "implement" && target === "review",
    );
    if (review === undefined || opening === undefined) {
      throw new Error("sample blueprint fixture is incomplete");
    }
    opening.target = "verify";
    revised.nodes.push({ ...review, id: "verify" });
    revised.edges.push({
      condition: "result.output.dispositions.complete",
      description: "Complete verification",
      disposition: "complete",
      source: "verify",
      target: "review",
    });
    await writeFile(publisherPath, `${JSON.stringify(revised, null, 2)}\n`);
    await execute("git", ["add", "blueprints/sample.json"], {
      cwd: publisher,
    });
    await execute(
      "git",
      ["commit", "--quiet", "-m", "Revise sample lifecycle"],
      {
        cwd: publisher,
      },
    );
    await execute("git", ["push", "--quiet"], { cwd: publisher });

    const beforeFetch = await globalThis.fetch(
      `${baseUrl}/api/lifecycle?task=${prepared.taskId}&after=0`,
    );
    await expect(beforeFetch.json()).resolves.toMatchObject({
      blueprint: { blobHash: initial.blueprint.blobHash },
      rebase: { state: "current" },
    });

    await composition.scheduler.trigger();

    const availableResponse = await globalThis.fetch(
      `${baseUrl}/api/lifecycle?task=${prepared.taskId}&after=0`,
    );
    const available = (await availableResponse.json()) as {
      blueprint: { blobHash: string };
      instanceId: string;
      rebase: {
        state: "available";
        targetBlueprintBlobHash: string;
        targetStateIds: string[];
      };
    };
    expect(available).toMatchObject({
      blueprint: { blobHash: initial.blueprint.blobHash },
      instanceId: initial.instanceId,
      rebase: {
        state: "available",
        targetStateIds: expect.arrayContaining(["verify"]),
      },
    });
    expect(available.rebase.targetBlueprintBlobHash).not.toBe(
      initial.blueprint.blobHash,
    );
    expect(
      readLifecycleContext(
        composition.persistence.getInstance(initial.instanceId)!,
      ).blueprintBlobHash,
    ).toBe(initial.blueprint.blobHash);
    expect(
      readLifecycleContext(
        composition.persistence.getInstance("control-instance")!,
      ).blueprintBlobHash,
    ).toBe(initial.blueprint.blobHash);
    expect(
      (
        await execute("git", ["rev-parse", "HEAD"], {
          cwd: prepared.blueprintsRepositoryRoot,
        })
      ).stdout.trim(),
    ).toBe(localHeadBefore);
    expect(await readFile(workingPath, "utf8")).toBe(workingBytesBefore);

    const rebaseResponse = await globalThis.fetch(
      `${baseUrl}/api/lifecycle/${prepared.taskId}/rebase`,
      {
        body: JSON.stringify({
          expectedInstanceId: available.instanceId,
          expectedPinnedBlobHash: available.blueprint.blobHash,
          expectedTargetBlobHash: available.rebase.targetBlueprintBlobHash,
          targetState: "verify",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    const rebased = (await rebaseResponse.json()) as {
      blueprint: { blobHash: string };
      currentStageIds: string[];
      rebase: { state: string };
    };
    expect(rebaseResponse.status).toBe(200);
    expect(rebased).toMatchObject({
      blueprint: {
        blobHash: available.rebase.targetBlueprintBlobHash,
      },
      currentStageIds: ["verify"],
      rebase: { state: "current" },
    });
    expect(
      readLifecycleContext(
        composition.persistence.getInstance(initial.instanceId)!,
      ).blueprintBlobHash,
    ).toBe(available.rebase.targetBlueprintBlobHash);
    expect(
      readLifecycleContext(
        composition.persistence.getInstance("control-instance")!,
      ).blueprintBlobHash,
    ).toBe(initial.blueprint.blobHash);

    await expect(
      composition.lifecycle.resume({
        disposition: "complete",
        instanceId: initial.instanceId,
        operationId: "rebased-verification-complete",
      }),
    ).resolves.toMatchObject({
      awaitingNodeIds: ["review"],
      blueprintBlobHash: available.rebase.targetBlueprintBlobHash,
    });
    await expect(
      composition.lifecycle.resume({
        disposition: "complete",
        instanceId: "control-instance",
        operationId: "pinned-implementation-complete",
      }),
    ).resolves.toMatchObject({
      awaitingNodeIds: ["review"],
      blueprintBlobHash: initial.blueprint.blobHash,
    });
    expect(
      (
        await execute("git", ["rev-parse", "HEAD"], {
          cwd: prepared.blueprintsRepositoryRoot,
        })
      ).stdout.trim(),
    ).toBe(localHeadBefore);
    expect(await readFile(workingPath, "utf8")).toBe(workingBytesBefore);
  }, 20_000);

  it("keeps the pinned lifecycle view available when upstream removes its blueprint", async () => {
    const prepared = await prepareProductionFixture();
    fixture = prepared;
    const composition = createProductionComposition({
      blueprintsRepositoryRoot: prepared.blueprintsRepositoryRoot,
      configuration: prepared.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    server = await startHeddleServer(
      { host: "127.0.0.1", port: 0 },
      { production: composition },
    );
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const initialResponse = await globalThis.fetch(
      `${baseUrl}/api/lifecycle?task=${prepared.taskId}&after=0`,
    );
    const initial = (await initialResponse.json()) as {
      blueprint: { blobHash: string };
      currentStageIds: string[];
      events: unknown[];
      instanceId: string;
      nextSequence: number;
      status: string;
      taskId: number;
    };
    expect(initialResponse.status).toBe(200);
    const localHeadBefore = (
      await execute("git", ["rev-parse", "HEAD"], {
        cwd: prepared.blueprintsRepositoryRoot,
      })
    ).stdout.trim();
    const workingPath = join(
      prepared.blueprintsRepositoryRoot,
      "blueprints/sample.json",
    );
    const workingBytesBefore = await readFile(workingPath, "utf8");

    const remote = (
      await execute("git", ["remote", "get-url", "origin"], {
        cwd: prepared.blueprintsRepositoryRoot,
      })
    ).stdout.trim();
    const publisher = join(prepared.root, "blueprint-removal-publisher");
    await execute(
      "git",
      ["clone", "--quiet", "--branch", "main", remote, publisher],
      { cwd: prepared.root },
    );
    await execute("git", ["config", "user.name", "Fixture User"], {
      cwd: publisher,
    });
    await execute("git", ["config", "user.email", "fixture@example.invalid"], {
      cwd: publisher,
    });
    await execute("git", ["rm", "--quiet", "blueprints/sample.json"], {
      cwd: publisher,
    });
    await execute(
      "git",
      ["commit", "--quiet", "-m", "Remove sample lifecycle"],
      { cwd: publisher },
    );
    await execute("git", ["push", "--quiet"], { cwd: publisher });
    await composition.scheduler.trigger();

    const lifecycleResponse = await globalThis.fetch(
      `${baseUrl}/api/lifecycle?task=${prepared.taskId}&after=0`,
    );
    const lifecycle = (await lifecycleResponse.json()) as {
      rebase: { state: string };
    } & typeof initial;
    expect(lifecycleResponse.status).toBe(200);
    expect(lifecycle).toMatchObject({
      blueprint: initial.blueprint,
      currentStageIds: initial.currentStageIds,
      events: initial.events,
      instanceId: initial.instanceId,
      nextSequence: initial.nextSequence,
      rebase: {
        state: "upstream-target-unavailable",
      },
      status: initial.status,
      taskId: initial.taskId,
    });
    expect(lifecycle.rebase).not.toHaveProperty("targetBlueprintBlobHash");
    expect(lifecycle.rebase).not.toHaveProperty("targetStateIds");

    const rejectedResponse = await globalThis.fetch(
      `${baseUrl}/api/lifecycle/${prepared.taskId}/rebase`,
      {
        body: JSON.stringify({
          expectedInstanceId: initial.instanceId,
          expectedPinnedBlobHash: initial.blueprint.blobHash,
          expectedTargetBlobHash: initial.blueprint.blobHash,
          targetState: initial.currentStageIds[0],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    expect(rejectedResponse.status).toBe(409);
    expect(
      readLifecycleContext(
        composition.persistence.getInstance(initial.instanceId)!,
      ).blueprintBlobHash,
    ).toBe(initial.blueprint.blobHash);
    expect(
      (
        await execute("git", ["rev-parse", "HEAD"], {
          cwd: prepared.blueprintsRepositoryRoot,
        })
      ).stdout.trim(),
    ).toBe(localHeadBefore);
    expect(await readFile(workingPath, "utf8")).toBe(workingBytesBefore);
  }, 20_000);

  it("keeps the pinned lifecycle view available when its upstream source is unresolvable", async () => {
    const prepared = await prepareProductionFixture();
    fixture = prepared;
    const composition = createProductionComposition({
      blueprintsRepositoryRoot: prepared.blueprintsRepositoryRoot,
      configuration: prepared.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    server = await startHeddleServer(
      { host: "127.0.0.1", port: 0 },
      { production: composition },
    );
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const initialResponse = await globalThis.fetch(
      `${baseUrl}/api/lifecycle?task=${prepared.taskId}&after=0`,
    );
    const initial = (await initialResponse.json()) as {
      blueprint: { blobHash: string };
      currentStageIds: string[];
      events: unknown[];
      instanceId: string;
      nextSequence: number;
      status: string;
      taskId: number;
    };
    expect(initialResponse.status).toBe(200);
    const localHeadBefore = (
      await execute("git", ["rev-parse", "HEAD"], {
        cwd: prepared.blueprintsRepositoryRoot,
      })
    ).stdout.trim();
    const workingPath = join(
      prepared.blueprintsRepositoryRoot,
      "blueprints/sample.json",
    );
    const workingBytesBefore = await readFile(workingPath, "utf8");

    await execute("git", ["branch", "--unset-upstream"], {
      cwd: prepared.blueprintsRepositoryRoot,
    });

    const lifecycleResponse = await globalThis.fetch(
      `${baseUrl}/api/lifecycle?task=${prepared.taskId}&after=0`,
    );
    const lifecycle = (await lifecycleResponse.json()) as {
      rebase: { state: string };
    } & typeof initial;
    expect(lifecycleResponse.status).toBe(200);
    expect(lifecycle).toMatchObject({
      blueprint: initial.blueprint,
      currentStageIds: initial.currentStageIds,
      events: initial.events,
      instanceId: initial.instanceId,
      nextSequence: initial.nextSequence,
      rebase: { state: "upstream-target-unavailable" },
      status: initial.status,
      taskId: initial.taskId,
    });
    expect(lifecycle.rebase).not.toHaveProperty("targetBlueprintBlobHash");
    expect(lifecycle.rebase).not.toHaveProperty("targetStateIds");

    const rejectedResponse = await globalThis.fetch(
      `${baseUrl}/api/lifecycle/${prepared.taskId}/rebase`,
      {
        body: JSON.stringify({
          expectedInstanceId: initial.instanceId,
          expectedPinnedBlobHash: initial.blueprint.blobHash,
          expectedTargetBlobHash: initial.blueprint.blobHash,
          targetState: initial.currentStageIds[0],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    expect(rejectedResponse.status).toBe(409);
    expect(
      readLifecycleContext(
        composition.persistence.getInstance(initial.instanceId)!,
      ).blueprintBlobHash,
    ).toBe(initial.blueprint.blobHash);
    expect(
      (
        await execute("git", ["rev-parse", "HEAD"], {
          cwd: prepared.blueprintsRepositoryRoot,
        })
      ).stdout.trim(),
    ).toBe(localHeadBefore);
    expect(await readFile(workingPath, "utf8")).toBe(workingBytesBefore);
  }, 20_000);
});
