// ---
// relationships:
//   verifies: heddle
// ---

import { createServer, type Server as HttpServer } from "node:http";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  execute,
  prepareProductionFixture,
  SyntheticT3,
} from "../production/composition.test-support.js";
import { T3ControlPlaneClient } from "../control-plane/index.js";
import { readLifecycleContext } from "../engine/index.js";
import { advanceOperationId } from "../mcp-server/operations.js";
import type { ProductionComposition } from "../production/index.js";
import type {
  ProductionConfiguration,
  ResolvedProductionConfiguration,
} from "../production/index.js";
import type { LoadedDeploymentConfiguration } from "./configuration.js";
import {
  createConfiguredProductionComposition,
  startConfiguredProductionService,
} from "./production-service.js";

const listen = async (server: HttpServer): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test HTTP server did not bind a TCP port");
  }
  return address.port;
};

const directorySnapshot = async (directory: string): Promise<string> => {
  const files: Array<[string, string]> = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else {
        files.push([
          relative(directory, path),
          (await readFile(path)).toString("base64"),
        ]);
      }
    }
  };
  await visit(directory);
  return JSON.stringify(files);
};

const configuredConfiguration = (
  resolved: ResolvedProductionConfiguration,
): ProductionConfiguration => {
  const { defaultProvider: _defaultProvider, ...pacing } = resolved.pacing;
  const {
    defaultSelection: _defaultSelection,
    resolvedSelections: _resolvedSelections,
    ...session
  } = resolved.session;
  void _defaultProvider;
  void _defaultSelection;
  void _resolvedSelections;
  return { ...resolved, pacing, session };
};

describe("configured production composition", () => {
  let fixture: Awaited<ReturnType<typeof prepareProductionFixture>> | undefined;
  let commandDirectory = "";
  let occupiedPort: HttpServer | undefined;
  let production: ProductionComposition | undefined;

  afterEach(async () => {
    await production?.close();
    if (occupiedPort?.listening) {
      await new Promise<void>((resolve, reject) => {
        occupiedPort!.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
    await fixture?.cleanup();
    if (commandDirectory !== "") {
      await rm(commandDirectory, { force: true, recursive: true });
    }
    vi.restoreAllMocks();
  });

  it("resolves every loaded alias from one catalog snapshot before composition", async () => {
    fixture = await prepareProductionFixture();
    const configuration = configuredConfiguration(fixture.configuration);
    configuration.providerAliases = {
      primary: {
        model: "model-alpha",
        providerDisplayName: "Workbench Alpha",
      },
      reviewer: {
        model: "model-beta",
        providerDisplayName: "Workbench Beta",
      },
      specialist: {
        model: "custom-model",
        providerDisplayName: "Workbench Alpha",
      },
    };
    const readProviderCatalog = vi.fn(async () => [
      {
        availability: "available" as const,
        displayName: "Workbench Alpha",
        driverKind: "codex",
        enabled: true,
        installed: true,
        instanceId: "instance-alpha",
        models: [
          { isCustom: false, name: "Model Alpha", slug: "model-alpha" },
          { isCustom: true, name: "Custom Model", slug: "custom-model" },
        ],
        observedCliVersion: "0.91.0",
        state: "ready",
      },
      {
        availability: "available" as const,
        displayName: "Workbench Beta",
        driverKind: "codex",
        enabled: true,
        installed: true,
        instanceId: "instance-beta",
        models: [{ isCustom: false, name: "Model Beta", slug: "model-beta" }],
        observedCliVersion: "0.91.0",
        state: "ready",
      },
    ]);
    const t3 = new SyntheticT3();
    production = await createConfiguredProductionComposition(
      {
        blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
        configuration,
        configurationDirectory: fixture.root,
        configurationPath: join(fixture.root, "config.yml"),
        server: { host: "127.0.0.1", port: 3774 },
      },
      { providerCatalog: { readProviderCatalog }, t3 },
    );

    expect(readProviderCatalog).toHaveBeenCalledTimes(1);
    expect(t3.commands).toEqual([]);
  });

  it("selects task, pinned stage, and configured default aliases for new stage occurrences", async () => {
    fixture = await prepareProductionFixture();
    const configuration = configuredConfiguration(fixture.configuration);
    configuration.providerAliases = {
      primary: {
        model: "model-primary",
        providerDisplayName: "Workbench Alpha",
      },
      reviewer: {
        model: "model-review",
        providerDisplayName: "Workbench Beta",
      },
      specialist: {
        model: "model-specialist",
        providerDisplayName: "Workbench Alpha",
      },
    };
    const blueprintPath = join(
      fixture.blueprintsRepositoryRoot,
      "blueprints/sample.json",
    );
    const blueprint = JSON.parse(await readFile(blueprintPath, "utf8")) as {
      nodes: Array<Record<string, unknown>>;
    };
    const review = blueprint.nodes.find(({ id }) => id === "review")!;
    review["provider-alias"] = "reviewer";
    review["runtime-mode"] = "full-access";
    await writeFile(blueprintPath, `${JSON.stringify(blueprint, null, 2)}\n`);
    await execute("git", ["add", "blueprints/sample.json"], {
      cwd: fixture.blueprintsRepositoryRoot,
    });
    await execute(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@invalid",
        "commit",
        "--quiet",
        "-m",
        "Select sample stage provider",
      ],
      { cwd: fixture.blueprintsRepositoryRoot },
    );
    await execute("git", ["push", "--quiet"], {
      cwd: fixture.blueprintsRepositoryRoot,
    });
    const [taskFilename] = await readdir(
      join(configuration.boardDirectory, "tasks"),
    );
    const taskPath = join(configuration.boardDirectory, "tasks", taskFilename!);
    const authoredTask = await readFile(taskPath, "utf8");
    await writeFile(
      taskPath,
      authoredTask.replace(
        "class: standard\n---",
        "class: standard\nprovider-alias:\n  remediate: specialist\n---",
      ),
    );
    const readProviderCatalog = vi.fn(async () => [
      {
        availability: "available" as const,
        displayName: "Workbench Alpha",
        driverKind: "codex",
        enabled: true,
        installed: true,
        instanceId: "instance-alpha",
        models: [
          {
            isCustom: false,
            name: "Primary Model",
            slug: "model-primary",
          },
          {
            isCustom: false,
            name: "Specialist Model",
            slug: "model-specialist",
          },
        ],
        observedCliVersion: "sample-version",
        state: "ready",
      },
      {
        availability: "available" as const,
        displayName: "Workbench Beta",
        driverKind: "codex",
        enabled: true,
        installed: true,
        instanceId: "instance-beta",
        models: [
          {
            isCustom: false,
            name: "Review Model",
            slug: "model-review",
          },
        ],
        observedCliVersion: "sample-version",
        state: "ready",
      },
    ]);
    const t3 = new SyntheticT3();
    production = await createConfiguredProductionComposition(
      {
        blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
        configuration,
        configurationDirectory: fixture.root,
        configurationPath: join(fixture.root, "config.yml"),
        server: { host: "127.0.0.1", port: 3774 },
      },
      { providerCatalog: { readProviderCatalog }, t3 },
    );

    await production.start();
    const instanceId = `task-${fixture.taskId}`;
    const initialContext = JSON.parse(
      readLifecycleContext(production.persistence.getInstance(instanceId)!)
        .serializedContext!,
    ) as Record<string, unknown>;
    expect(initialContext).toMatchObject({
      taskContract: { providerAlias: { remediate: "specialist" } },
    });
    const implementKey = `${instanceId}:implement:1`;
    await production.lifecycle.resume({
      disposition: "complete",
      instanceId,
      operationId: advanceOperationId(implementKey),
    });
    await production.scheduler.trigger();
    await production.lifecycle.resume({
      disposition: "reject",
      instanceId,
      operationId: advanceOperationId(`${instanceId}:review:1`),
      output: { findings: [] },
    });
    await production.scheduler.trigger();

    expect(production.persistence.listSessionRuntime()).toMatchObject([
      {
        binding: {
          alias: "primary",
          modelSlug: "model-primary",
          providerInstanceId: "instance-alpha",
          runtimeMode: "auto-accept-edits",
        },
        stageId: "implement",
      },
      {
        binding: {
          alias: "specialist",
          modelSlug: "model-specialist",
          providerInstanceId: "instance-alpha",
          runtimeMode: "auto-accept-edits",
        },
        stageId: "remediate",
      },
      {
        binding: {
          alias: "reviewer",
          modelSlug: "model-review",
          providerInstanceId: "instance-beta",
          runtimeMode: "full-access",
        },
        stageId: "review",
      },
    ]);
    expect(readProviderCatalog).toHaveBeenCalledTimes(4);
    expect(
      t3.commands
        .filter(({ type }) => type === "thread.create")
        .map(({ modelSelection, runtimeMode }) => ({
          modelSelection,
          runtimeMode,
        })),
    ).toEqual([
      {
        modelSelection: {
          instanceId: "instance-alpha",
          model: "model-primary",
        },
        runtimeMode: "auto-accept-edits",
      },
      {
        modelSelection: {
          instanceId: "instance-beta",
          model: "model-review",
        },
        runtimeMode: "full-access",
      },
      {
        modelSelection: {
          instanceId: "instance-alpha",
          model: "model-specialist",
        },
        runtimeMode: "auto-accept-edits",
      },
    ]);
  });

  it.each(["task override", "stage alias"] as const)(
    "raises task-and-stage attention without dispatch for an unknown %s",
    async (selectionSource) => {
      fixture = await prepareProductionFixture();
      const configuration = configuredConfiguration(fixture.configuration);
      if (selectionSource === "task override") {
        const [taskFilename] = await readdir(
          join(configuration.boardDirectory, "tasks"),
        );
        const taskPath = join(
          configuration.boardDirectory,
          "tasks",
          taskFilename!,
        );
        await writeFile(
          taskPath,
          (await readFile(taskPath, "utf8")).replace(
            "class: standard\n---",
            "class: standard\nprovider-alias:\n  implement: unknown\n---",
          ),
        );
      } else {
        const blueprintPath = join(
          fixture.blueprintsRepositoryRoot,
          "blueprints/sample.json",
        );
        const blueprint = JSON.parse(await readFile(blueprintPath, "utf8")) as {
          nodes: Array<Record<string, unknown>>;
        };
        blueprint.nodes.find(({ id }) => id === "implement")![
          "provider-alias"
        ] = "unknown";
        await writeFile(
          blueprintPath,
          `${JSON.stringify(blueprint, null, 2)}\n`,
        );
        await execute("git", ["add", "blueprints/sample.json"], {
          cwd: fixture.blueprintsRepositoryRoot,
        });
        await execute(
          "git",
          [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@invalid",
            "commit",
            "--quiet",
            "-m",
            "Select unavailable sample provider",
          ],
          { cwd: fixture.blueprintsRepositoryRoot },
        );
        await execute("git", ["push", "--quiet"], {
          cwd: fixture.blueprintsRepositoryRoot,
        });
      }
      const t3 = new SyntheticT3();
      production = await createConfiguredProductionComposition(
        {
          blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
          configuration,
          configurationDirectory: fixture.root,
          configurationPath: join(fixture.root, "config.yml"),
          server: { host: "127.0.0.1", port: 3774 },
        },
        {
          providerCatalog: {
            readProviderCatalog: async () => [
              {
                availability: "available",
                displayName: "Workbench Alpha",
                driverKind: "codex",
                enabled: true,
                installed: true,
                instanceId: "instance-alpha",
                models: [
                  {
                    isCustom: false,
                    name: "Model Alpha",
                    slug: "sample-model",
                  },
                ],
                observedCliVersion: "sample-version",
                state: "ready",
              },
            ],
          },
          t3,
        },
      );

      await production.start();

      expect(
        t3.commands.filter(({ type }) => type !== "project.create"),
      ).toEqual([]);
      expect(production.attention.list()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "production-error",
            message: expect.stringContaining(
              `Task ${fixture.taskId} stage 'implement' cannot select a session`,
            ),
          }),
        ]),
      );
    },
  );

  it.each([
    {
      declaration: "provider-alias: specialist",
      diagnostic: "must be a stage-to-alias mapping; received string",
      label: "scalar shape",
      rejectsStartup: true,
    },
    {
      declaration: "provider-alias:\n  absent-stage: primary",
      diagnostic: 'key "absent-stage" names no node in the resolved blueprint',
      label: "unknown stage key",
      rejectsStartup: false,
    },
    {
      declaration: "provider-alias:\n  finalize: primary",
      diagnostic:
        'key "finalize" names a mechanical node; only wait nodes can select providers',
      label: "mechanical stage key",
      rejectsStartup: false,
    },
  ])(
    "rejects a task provider-alias $label before any session effect",
    async ({ declaration, diagnostic, rejectsStartup }) => {
      fixture = await prepareProductionFixture();
      const configuration = configuredConfiguration(fixture.configuration);
      const [taskFilename] = await readdir(
        join(configuration.boardDirectory, "tasks"),
      );
      const taskPath = join(
        configuration.boardDirectory,
        "tasks",
        taskFilename!,
      );
      await writeFile(
        taskPath,
        (await readFile(taskPath, "utf8")).replace(
          "class: standard\n---",
          `class: standard\n${declaration}\n---`,
        ),
      );
      const t3 = new SyntheticT3();
      production = await createConfiguredProductionComposition(
        {
          blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
          configuration,
          configurationDirectory: fixture.root,
          configurationPath: join(fixture.root, "config.yml"),
          server: { host: "127.0.0.1", port: 3774 },
        },
        { t3 },
      );

      const startError = await production
        .start()
        .catch((error: unknown) => error);

      if (rejectsStartup) {
        expect(startError).toMatchObject({
          message: expect.stringContaining(
            `provider-alias-not-allowed: task ${fixture.taskId} provider-alias ${diagnostic}`,
          ),
          reason: "provider-alias-not-allowed",
        });
      } else {
        expect(startError).toBeUndefined();
        expect(production.attention.list()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "production-error",
              message: expect.stringContaining(
                `provider-alias-not-allowed: task ${fixture.taskId} provider-alias ${diagnostic}`,
              ),
            }),
          ]),
        );
      }

      expect(production.persistence.listSessionRuntime()).toEqual([]);
      expect(
        t3.commands.filter(({ type }) => type !== "project.create"),
      ).toEqual([]);
    },
  );

  it.each(["claudeAgent", "codex", "cursor", "grok", "opencode"] as const)(
    "dispatches a resolved full-access %s selection through the production T3 client",
    async (driverKind) => {
      fixture = await prepareProductionFixture();
      const configuration = configuredConfiguration(fixture.configuration);
      configuration.session.defaultRuntimeMode = "full-access";
      const projects = new Map<
        string,
        { id: string; title: string; workspaceRoot: string }
      >();
      const threads = new Set<string>();
      const commands: Array<Record<string, unknown>> = [];
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/mcp/provider-session")) {
          return new globalThis.Response(null, { status: 204 });
        }
        if (url.endsWith("/api/orchestration/shell")) {
          return new globalThis.Response(
            JSON.stringify({
              projects: [...projects.values()],
              threads: [...threads].map((id) => ({
                id,
                latestTurn: { state: "running" },
                session: { status: "running" },
              })),
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/orchestration/dispatch")) {
          const command = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          commands.push(command);
          if (command["type"] === "project.create") {
            projects.set(String(command["projectId"]), {
              id: String(command["projectId"]),
              title: String(command["title"]),
              workspaceRoot: String(command["workspaceRoot"]),
            });
          }
          if (command["type"] === "thread.create") {
            threads.add(String(command["threadId"]));
          }
          return new globalThis.Response(
            JSON.stringify({ sequence: commands.length }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected T3 request: ${url}`);
      });
      const t3 = new T3ControlPlaneClient({
        accessToken: "sample-access",
        baseUrl: "http://t3.test",
        fetch,
      });
      const onSchedulerError = vi.fn();
      production = await createConfiguredProductionComposition(
        {
          blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
          configuration,
          configurationDirectory: fixture.root,
          configurationPath: join(fixture.root, "config.yml"),
          server: { host: "127.0.0.1", port: 3774 },
        },
        {
          onSchedulerError,
          providerCatalog: {
            readProviderCatalog: async () => [
              {
                availability: "available",
                displayName: "Workbench Alpha",
                driverKind,
                enabled: true,
                installed: true,
                instanceId: "provider-alpha",
                models: [
                  {
                    isCustom: false,
                    name: "Sample Model",
                    slug: "sample-model",
                  },
                ],
                observedCliVersion: `catalog-version-${driverKind}`,
                state: "ready",
              },
            ],
          },
          t3,
        },
      );

      await production.start();

      expect(onSchedulerError).not.toHaveBeenCalled();
      expect(commands.map((command) => command["type"])).toEqual([
        "project.create",
        "thread.create",
        "thread.turn.start",
      ]);
      const expectedSelection = {
        modelSelection: {
          instanceId: "provider-alpha",
          model: "sample-model",
        },
        runtimeMode: "full-access",
      };
      expect(commands[1]).toMatchObject({
        ...expectedSelection,
        type: "thread.create",
      });
      expect(commands[2]).toMatchObject({
        ...expectedSelection,
        type: "thread.turn.start",
      });
    },
  );

  it("surfaces an actual T3 dispatch rejection through durable attention", async () => {
    fixture = await prepareProductionFixture();
    const configuration = configuredConfiguration(fixture.configuration);
    const projects = new Map<
      string,
      { id: string; title: string; workspaceRoot: string }
    >();
    const threads = new Set<string>();
    const commands: Array<Record<string, unknown>> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/mcp/provider-session")) {
        return new globalThis.Response(null, { status: 204 });
      }
      if (url.endsWith("/api/orchestration/shell")) {
        return new globalThis.Response(
          JSON.stringify({
            projects: [...projects.values()],
            threads: [...threads].map((id) => ({
              id,
              latestTurn: { state: "running" },
              session: { status: "running" },
            })),
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/orchestration/dispatch")) {
        const command = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        commands.push(command);
        if (command["type"] === "project.create") {
          projects.set(String(command["projectId"]), {
            id: String(command["projectId"]),
            title: String(command["title"]),
            workspaceRoot: String(command["workspaceRoot"]),
          });
          return new globalThis.Response(JSON.stringify({ sequence: 1 }), {
            status: 200,
          });
        }
        if (command["type"] === "thread.create") {
          threads.add(String(command["threadId"]));
          return new globalThis.Response(JSON.stringify({ sequence: 1 }), {
            status: 200,
          });
        }
        return new globalThis.Response(
          JSON.stringify({
            _tag: "EnvironmentInternalError",
            code: "internal_error",
            reason: "orchestration_dispatch_failed",
            traceId: "00000000000000000000000000000001",
          }),
          { status: 500 },
        );
      }
      throw new Error(`Unexpected T3 request: ${url}`);
    });
    production = await createConfiguredProductionComposition(
      {
        blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
        configuration,
        configurationDirectory: fixture.root,
        configurationPath: join(fixture.root, "config.yml"),
        server: { host: "127.0.0.1", port: 3774 },
      },
      {
        providerCatalog: {
          readProviderCatalog: async () => [
            {
              availability: "available",
              displayName: "Workbench Alpha",
              driverKind: "codex",
              enabled: true,
              installed: true,
              instanceId: "provider-alpha",
              models: [
                {
                  isCustom: false,
                  name: "Sample Model",
                  slug: "sample-model",
                },
              ],
              observedCliVersion: "catalog-version-alpha",
              state: "ready",
            },
          ],
        },
        t3: new T3ControlPlaneClient({
          accessToken: "sample-access",
          baseUrl: "http://t3.test",
          fetch,
        }),
      },
    );

    await expect(production.start()).resolves.toBeUndefined();

    expect(commands.map((command) => command["type"])).toEqual([
      "project.create",
      "thread.create",
      "thread.turn.start",
    ]);
    expect(
      production.attention
        .list()
        .filter(
          ({ attentionId }) =>
            !attentionId.includes(":incident-execution-failed:"),
        ),
    ).toEqual([
      expect.objectContaining({
        kind: "production-error",
        message: expect.stringContaining(
          'reason orchestration_dispatch_failed; trace ID "00000000000000000000000000000001"',
        ),
      }),
    ]);
  });

  it("fails catalog startup without creating service state or disclosing transport detail", async () => {
    fixture = await prepareProductionFixture();
    const error = await createConfiguredProductionComposition(
      {
        blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
        configuration: configuredConfiguration(fixture.configuration),
        configurationDirectory: fixture.root,
        configurationPath: join(fixture.root, "config.yml"),
        server: { host: "127.0.0.1", port: 3774 },
      },
      {
        providerCatalog: {
          readProviderCatalog: async () => {
            throw new Error("transport included sensitive detail");
          },
        },
        // A catalog that never becomes reachable must still fail closed, so
        // bound the boot readiness wait rather than waiting it out.
        startupReadiness: { timeoutMilliseconds: 0 },
        t3: new SyntheticT3(),
      },
    ).catch((candidate: unknown) => candidate);

    expect(error).toMatchObject({
      message: "T3 provider catalog is unavailable",
      reason: "provider-catalog-unavailable",
    });
    expect(String(error)).not.toContain("sensitive detail");
    await expect(
      access(fixture.configuration.stateDirectory),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates a configured provider-usage error before any T3 dispatch", async () => {
    fixture = await prepareProductionFixture();
    commandDirectory = await mkdtemp(
      join(tmpdir(), "heddle-provider-failure-"),
    );
    const command = join(commandDirectory, "provider-usage.mjs");
    await writeFile(
      command,
      'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("invalid\\n"));\n',
    );
    const configured = configuredConfiguration(fixture.configuration);
    const configuration = {
      ...configured,
      pacing: {
        ...configured.pacing,
        providerBudgets: { primary: { usageLimit: 80 } },
      },
    };
    const loaded: LoadedDeploymentConfiguration = {
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration,
      configurationDirectory: commandDirectory,
      configurationPath: join(commandDirectory, "config.yml"),
      providerUsage: {
        arguments: [command],
        executable: process.execPath,
        timeoutMilliseconds: 1_000,
      },
      server: { host: "127.0.0.1", port: 0 },
    };
    const t3 = new SyntheticT3();
    const onSchedulerError = vi.fn(async () => undefined);
    production = await createConfiguredProductionComposition(loaded, {
      onSchedulerError,
      t3,
    });

    await expect(production.start()).resolves.toBeUndefined();
    expect(t3.commands.filter(({ type }) => type !== "project.create")).toEqual(
      [],
    );
    expect(onSchedulerError).not.toHaveBeenCalled();
    expect(
      production.attention
        .list()
        .filter(
          ({ attentionId }) =>
            !attentionId.includes(":incident-execution-failed:"),
        ),
    ).toEqual([
      expect.objectContaining({
        kind: "production-error",
        message: expect.stringContaining(
          "Provider usage command returned malformed or extra output",
        ),
        scope: `task:${fixture.taskId}`,
      }),
    ]);
  });

  it("resolves catalog authority before bind without board, dispatch, Pushover, or persistence effects", async () => {
    fixture = await prepareProductionFixture();
    occupiedPort = createServer();
    const port = await listen(occupiedPort);
    const t3 = new SyntheticT3();
    const readProviderCatalog = vi.spyOn(t3, "readProviderCatalog");
    const notifications: unknown[] = [];
    const beforeBoard = await directorySnapshot(
      fixture.configuration.boardDirectory,
    );
    await expect(
      access(fixture.configuration.stateDirectory),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const loaded: LoadedDeploymentConfiguration = {
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: configuredConfiguration(fixture.configuration),
      configurationDirectory: fixture.root,
      configurationPath: join(fixture.root, "config.yml"),
      server: { host: "127.0.0.1", port },
    };

    await expect(
      startConfiguredProductionService(loaded, {
        pushoverTransport: {
          send: async (message) => {
            notifications.push(message);
          },
        },
        t3,
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });

    expect(await directorySnapshot(fixture.configuration.boardDirectory)).toBe(
      beforeBoard,
    );
    await expect(
      access(fixture.configuration.stateDirectory),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(t3.commands.filter(({ type }) => type !== "project.create")).toEqual(
      [],
    );
    expect(readProviderCatalog).toHaveBeenCalledTimes(1);
    expect(notifications).toEqual([]);
  });

  it("writes a scheduler-owned production failure to stderr", async () => {
    fixture = await prepareProductionFixture();
    const loaded: LoadedDeploymentConfiguration = {
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: configuredConfiguration(fixture.configuration),
      configurationDirectory: fixture.root,
      configurationPath: join(fixture.root, "config.yml"),
      server: { host: "127.0.0.1", port: 0 },
    };
    await rm(fixture.configuration.boardDirectory, {
      force: true,
      recursive: true,
    });
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);

    await expect(
      startConfiguredProductionService(loaded, { t3: new SyntheticT3() }),
    ).rejects.toThrow();

    expect(write).toHaveBeenCalledWith(
      expect.stringContaining("Heddle reconciliation pass failed:"),
    );
  });

  it("dispatches the wholesale override without prompt-source path or provenance", async () => {
    fixture = await prepareProductionFixture();
    const override =
      "# Operator session guidance\n\nUse the configured workflow.";
    await writeFile(join(fixture.root, "heddle.md"), override);
    const t3 = new SyntheticT3();
    const loaded: LoadedDeploymentConfiguration = {
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: configuredConfiguration(fixture.configuration),
      configurationDirectory: fixture.root,
      configurationPath: join(fixture.root, "config.yml"),
      server: { host: "127.0.0.1", port: 3774 },
    };
    production = await createConfiguredProductionComposition(loaded, { t3 });

    await production.start();

    const turn = t3.commands.find(({ type }) => type === "thread.turn.start");
    const rendered = (turn?.["message"] as { text: string }).text;
    expect(rendered.startsWith(`${override}\n\n`)).toBe(true);
    expect(rendered).not.toContain("# Heddle stage session");
    expect(rendered).not.toContain(fixture.root);
    expect(t3.mcpRegistrations).toEqual([
      {
        authorizationHeader: expect.stringMatching(/^Bearer \S+$/),
        endpoint: "http://127.0.0.1:3774/mcp",
        threadId: expect.any(String),
      },
    ]);
    expect(rendered).not.toContain(
      t3.mcpRegistrations[0]!.authorizationHeader.slice("Bearer ".length),
    );
  });

  it("raises durable attention without dispatch when heddle.md is unreadable", async () => {
    fixture = await prepareProductionFixture();
    await mkdir(join(fixture.root, "heddle.md"));
    const t3 = new SyntheticT3();
    const loaded: LoadedDeploymentConfiguration = {
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: configuredConfiguration(fixture.configuration),
      configurationDirectory: fixture.root,
      configurationPath: join(fixture.root, "config.yml"),
      server: { host: "127.0.0.1", port: 3774 },
    };
    production = await createConfiguredProductionComposition(loaded, { t3 });

    await expect(production.start()).resolves.toBeUndefined();

    expect(t3.commands.filter(({ type }) => type !== "project.create")).toEqual(
      [],
    );
    expect(production.attention.list()).toEqual([
      expect.objectContaining({
        kind: "lifecycle-resolution",
        message: expect.stringContaining("System prompt override"),
      }),
    ]);
  });
});
