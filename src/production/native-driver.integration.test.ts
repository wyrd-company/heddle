// ---
// relationships:
//   verifies: heddle
//   references: t3-headless
// ---

import type { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { T3ControlPlaneClient } from "../control-plane/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import { isTodoState } from "../todo/index.js";
import { resolveT3AwarenessPhase } from "../control-plane/t3-agent-awareness.js";
import { prepareProductionFixture } from "./composition.test-support.js";
import {
  makeQualificationScratch,
  QUALIFICATION_ALL_DRIVERS,
  QUALIFICATION_CURSOR,
  QUALIFICATION_EXECUTION,
  QUALIFICATION_GROK,
  QUALIFICATION_OPENCODE,
  QUALIFICATION_SECOND_DRIVER,
  nativeDriverEvidenceLine,
  observedCliVersions,
  preferredModelsFor,
  startIsolatedT3,
  type IsolatedT3,
  type NativeDriverEvidence,
} from "./driver-qualification.test-support.js";

/** One row per supported driver. Every row is required; a skipped harness
 * leaves the matrix incomplete rather than passing. */
const DRIVER_ROWS = [
  { alias: "claude-code", instance: QUALIFICATION_EXECUTION },
  { alias: "codex", instance: QUALIFICATION_SECOND_DRIVER },
  { alias: "cursor", instance: QUALIFICATION_CURSOR },
  { alias: "grok", instance: QUALIFICATION_GROK },
  { alias: "opencode", instance: QUALIFICATION_OPENCODE },
] as const;

const t3Binary = process.env["HEDDLE_T3_INTEGRATION_BINARY"];
const nativeDrivers = process.env["HEDDLE_NATIVE_DRIVER_QUALIFICATION"] === "1";
const selectedDriver = process.env["HEDDLE_NATIVE_DRIVER_ALIAS"];
const operatorHome = process.env["HOME"] ?? "";

const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  const pending = teardown.splice(0, teardown.length).reverse();
  for (const release of pending) await release();
});

const allocatePort = async (): Promise<number> => {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => resolve());
  });
  const address = socket.address();
  if (address === null || typeof address === "string") {
    throw new Error("Unable to allocate a service port");
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
};

const qualificationSystemPrompt = (
  proofPath: string,
): string => `# Native driver qualification

Perform these steps in order. Do not do other work.

1. Run this benign command without requesting approval: printf 'native-driver-qualified\\n' > '${proofPath}'
2. Call the Heddle list_providers tool with an empty input.
3. From that result, use the only selectable alias to call the Heddle spawn tool with operationId native-driver-child and rootItemId deliver. The alias is intentionally absent from these instructions.
4. If spawn succeeds, call the Heddle advance tool exactly once with disposition complete and an empty output object, then stop.
5. If spawn reports that deliver is already assigned, you are the delegated child. Stop without calling advance.
`;

const stopService = async (service: ChildProcess): Promise<void> => {
  if (service.pid === undefined || service.exitCode !== null) return;
  service.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => service.once("exit", () => resolve())),
    delay(5_000),
  ]);
  if (service.exitCode === null) service.kill("SIGKILL");
};

describe.skipIf(!t3Binary || !nativeDrivers)(
  "native driver through the packaged production service",
  () => {
    const selectedRows = DRIVER_ROWS.filter(
      ({ alias }) => selectedDriver === undefined || alias === selectedDriver,
    );
    if (selectedDriver !== undefined && selectedRows.length === 0) {
      throw new Error(`Unknown native driver alias: ${selectedDriver}`);
    }
    it.each(selectedRows)(
      "runs a real $alias session that calls a Heddle MCP tool",
      async ({ alias, instance }) => {
        const scratch = await makeQualificationScratch();
        teardown.push(scratch.cleanup);
        const fixture = await prepareProductionFixture();
        teardown.push(fixture.cleanup);
        const emittedEvidence: string[] = [];
        const emitEvidence = (evidence: NativeDriverEvidence): void => {
          const line = nativeDriverEvidenceLine(evidence);
          process.stdout.write(`${line}\n`);
          emittedEvidence.push(line);
        };

        const isolated: IsolatedT3 = await startIsolatedT3({
          binary: t3Binary as string,
          home: operatorHome,
          providerInstances: [...QUALIFICATION_ALL_DRIVERS],
          scratch: scratch.root,
        });
        teardown.push(isolated.stop);

        const client = new T3ControlPlaneClient({
          accessToken: isolated.accessToken,
          baseUrl: isolated.baseUrl,
        });
        const models = await preferredModelsFor(client, [instance]);
        const model = models.get(instance.instanceId);
        if (model === undefined) {
          throw new Error(
            `Qualification model was not resolved for '${instance.instanceId}'`,
          );
        }
        const cliVersion = (await observedCliVersions(client)).get(
          instance.instanceId,
        );
        if (cliVersion === undefined || cliVersion === null) {
          throw new Error(
            `T3 did not report a CLI version for '${instance.instanceId}'`,
          );
        }
        const providerAlias = `native-row-${globalThis.crypto
          .randomUUID()
          .replaceAll("-", "")
          .slice(0, 12)}`;
        const providerAliases = {
          [providerAlias]: {
            model,
            providerDisplayName: instance.displayName,
          },
        };

        // Heddle reconciles the shared project itself at startup, so the
        // qualification no longer provisions it.
        const configurationDirectory = join(scratch.root, "configuration");
        await mkdir(configurationDirectory, { recursive: true });
        const proofPath = join(scratch.root, `${alias}-full-access.txt`);
        await writeFile(
          join(configurationDirectory, "heddle.md"),
          qualificationSystemPrompt(proofPath),
        );
        // The service resolves blueprints from `<config>/blueprints`, not from
        // a configuration key.
        const { symlink } = await import("node:fs/promises");
        await symlink(
          fixture.blueprintsRepositoryRoot,
          join(configurationDirectory, "blueprints"),
          "dir",
        );
        const servicePort = await allocatePort();
        const { defaultProvider: _defaultProvider, ...configuredPacing } =
          fixture.configuration.pacing;
        const {
          defaultSelection: _defaultSelection,
          resolvedSelections: _resolvedSelections,
          ...configuredSession
        } = fixture.configuration.session;
        void _defaultProvider;
        void _defaultSelection;
        void _resolvedSelections;

        const configured = {
          ...fixture.configuration,
          adHocProject: {
            ...fixture.configuration.adHocProject,
            workspaceRoot: fixture.repositoryRoot,
          },
          pacing: {
            ...configuredPacing,
            maxConcurrentSessions: 3,
            providerBudgets: { [providerAlias]: { usageLimit: 100 } },
            subagents: { maxDepth: 1, maxFanOut: 1 },
          },
          providerUsage: {
            arguments: [
              "-e",
              'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ version: 1, used: 0, windowStartedAt: 0 }) + "\\n"));',
            ],
            executable: process.execPath,
            timeoutMilliseconds: 10_000,
          },
          providerAliases,
          server: { host: "127.0.0.1", port: servicePort },
          session: {
            ...configuredSession,
            defaultProviderAlias: providerAlias,
            defaultRuntimeMode: "full-access",
          },
          t3: {
            accessToken: isolated.accessToken,
            baseUrl: isolated.baseUrl,
          },
        };
        await writeFile(
          join(configurationDirectory, "config.yml"),
          stringify(configured),
        );

        const service = spawn(
          process.execPath,
          ["bin/heddle-server.mjs", "--config", configurationDirectory],
          {
            cwd: process.cwd(),
            env: { ...process.env, HOME: operatorHome },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        teardown.push(() => stopService(service));
        let serviceOutput = "";
        service.stdout?.on("data", (chunk: Buffer) => {
          serviceOutput += chunk.toString();
        });
        service.stderr?.on("data", (chunk: Buffer) => {
          serviceOutput += chunk.toString();
        });

        const origin = `http://127.0.0.1:${servicePort}`;
        const instanceStage = async (): Promise<string | undefined> => {
          try {
            const response = await globalThis.fetch(`${origin}/api/instances`, {
              signal: globalThis.AbortSignal.timeout(1_000),
            });
            if (!response.ok) return undefined;
            const instances = (await response.json()) as Array<{
              instanceId: string;
              stageId: string;
            }>;
            return instances.find(
              ({ instanceId }) => instanceId === `task-${fixture.taskId}`,
            )?.stageId;
          } catch {
            return undefined;
          }
        };

        // The service activates the stage and dispatches a real Claude Code
        // session through T3.
        const activated = await (async () => {
          for (let attempt = 0; attempt < 120; attempt += 1) {
            const stage = await instanceStage();
            if (stage !== undefined) return stage;
            await delay(500);
          }
          throw new Error(
            `Service never activated the instance. Output: ${serviceOutput.slice(-2000)}`,
          );
        })();
        expect(activated).toBe("implement");

        // The native agent calls `advance`, which is a real Heddle MCP
        // invocation, and the lifecycle moves off the wait stage.
        const advanced = await (async () => {
          // Generous by design: a real agent's first turn varies by driver and
          // by load, and the rows run sequentially, each with its own control
          // plane and agent process. A window sized to the fastest driver
          // reports a slow one as unsupported, which is the failure this whole
          // qualification exists to stop mistaking for a rejection.
          for (let attempt = 0; attempt < 900; attempt += 1) {
            const stage = await instanceStage();
            if (stage !== undefined && stage !== "implement") return stage;
            // A thread the control plane has already failed will never
            // advance. Waiting out the window on it wastes the run and hides
            // the reason behind a timeout.
            if (attempt % 5 === 4) {
              const current = (await client.getShell()).threads.find(
                (candidate) =>
                  typeof candidate["title"] === "string" &&
                  (candidate["title"] as string).includes("task-"),
              );
              if (
                current !== undefined &&
                resolveT3AwarenessPhase(current) === "failed"
              ) {
                break;
              }
            }
            await delay(1_000);
          }
          // What the session actually did is the evidence that matters. The
          // server log shows only startup unless something failed inside T3.
          const stalled = (await client.getShell()).threads.find(
            (candidate) =>
              typeof candidate["title"] === "string" &&
              (candidate["title"] as string).includes("task-"),
          ) as
            | {
                activities?: Array<{ kind?: string }>;
                modelSelection?: { instanceId?: string; model?: string };
                runtimeMode?: string;
              }
            | undefined;
          const snapshot =
            stalled === undefined
              ? "no thread reached the control plane"
              : JSON.stringify({
                  activities: (
                    (stalled["activities"] as
                      Array<{ kind?: string }> | undefined) ?? []
                  )
                    .slice(-12)
                    .map(({ kind }) => kind),
                  phase: resolveT3AwarenessPhase(stalled),
                  runtimeMode: stalled["runtimeMode"],
                });
          if (stalled !== undefined) {
            expect(stalled.modelSelection?.instanceId).toBe(
              instance.instanceId,
            );
            expect(stalled.modelSelection?.model).toBe(model);
            expect(stalled.runtimeMode).toBe("full-access");
            emitEvidence({
              advanceResult: null,
              benignFileAction: null,
              driver: alias,
              listProvidersResult: null,
              model,
              providerAlias,
              providerCliVersion: cliVersion,
              providerInstanceId: instance.instanceId,
              result: "provider-turn-failed",
              runtimeMode: "full-access",
              spawnResult: null,
              version: 1,
            });
          }
          throw new Error(
            `Native session never advanced the stage. Thread: ${snapshot} ||| SERVICE: ${serviceOutput
              .replace(/\s+/g, " ")
              .slice(-1500)}`,
          );
        })();
        expect(advanced).toBe("review");
        expect(await readFile(proofPath, "utf8")).toBe(
          "native-driver-qualified\n",
        );

        await stopService(service);
        const persistence = new SqlitePersistence({
          stateDirectory: configured.stateDirectory,
        });
        try {
          const record = persistence.getInstance(`task-${fixture.taskId}`);
          expect(record).toBeDefined();
          expect(isTodoState(record?.state.todoState)).toBe(true);
          if (!isTodoState(record?.state.todoState)) {
            throw new Error("Native driver row has no todo state");
          }
          const assignments = record.state.todoState.lists.flatMap(
            ({ assignments = [] }) => assignments,
          );
          expect(assignments).toHaveLength(1);
          expect(assignments[0]).toMatchObject({
            binding: {
              alias: providerAlias,
              modelSlug: providerAliases[providerAlias].model,
              providerInstanceId: instance.instanceId,
              runtimeMode: "full-access",
            },
            operationId: "native-driver-child",
            parentSessionKey: expect.any(String),
            rootItemId: "deliver",
          });
          // The child can obey the handoff and stop before the parent advances.
          // Either durable state proves that spawn created the assignment; the
          // exact binding and the control-plane thread prove where it ran.
          expect(["active", "stopped"]).toContain(assignments[0]?.status);
        } finally {
          persistence.close();
        }

        // The advance was the agent's own MCP call: this test never calls the
        // MCP boundary, so the only caller was the native session.
        const threads = (await client.getShell()).threads.filter(
          ({ title }) => typeof title === "string" && title.includes("task-"),
        ) as Array<{
          modelSelection?: { instanceId?: string; model?: string };
          runtimeMode?: string;
        }>;
        expect(threads.length).toBeGreaterThanOrEqual(2);
        for (const thread of threads) {
          expect(thread.modelSelection?.instanceId).toBe(instance.instanceId);
          expect(thread.modelSelection?.model).toBe(
            providerAliases[providerAlias].model,
          );
          expect(thread.runtimeMode).toBe("full-access");
        }
        emitEvidence({
          advanceResult: "review",
          benignFileAction: "native-driver-qualified",
          driver: alias,
          listProvidersResult: "selected-generated-alias",
          model,
          providerAlias,
          providerCliVersion: cliVersion,
          providerInstanceId: instance.instanceId,
          result: "passed",
          runtimeMode: "full-access",
          spawnResult: "persisted-child-assignment",
          version: 1,
        });
        expect(emittedEvidence).toHaveLength(1);
      },
      1_500_000,
    );
  },
);
