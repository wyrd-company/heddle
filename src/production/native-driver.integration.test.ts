// ---
// relationships:
//   verifies: heddle
//   references: t3-headless
// ---

import type { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { T3ControlPlaneClient } from "../control-plane/index.js";
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
  readyModelsFor,
  startIsolatedT3,
  type IsolatedT3,
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

/**
 * A handoff that asks the agent for exactly one Heddle tool call. The stage's
 * own tool contract is what makes the call possible; the prose only names it.
 */
const advanceHandoffTemplate = `---
$schema: https://wyrd.company/heddle/handoff-template.schema.json
relationships:
  implements: heddle
format: heddle.handoff-template
version: 1
kind: standard
---
# {{ task.title }}

Stage: {{ handoff.stage.name }}

Do not edit any files and do not run any commands.

Call the \`advance\` tool exactly once with disposition \`complete\` and an
empty output object. Then stop.
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
    it.each(DRIVER_ROWS)(
      "runs a real $alias session that calls a Heddle MCP tool",
      async ({ instance }) => {
        const scratch = await makeQualificationScratch();
        teardown.push(scratch.cleanup);
        const fixture = await prepareProductionFixture();
        teardown.push(fixture.cleanup);

        // Replace the fixture handoff with one that names the tool to call.
        await writeFile(
          join(
            fixture.blueprintsRepositoryRoot,
            "handoff-templates",
            "standard.md",
          ),
          advanceHandoffTemplate,
        );

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
        const models = await readyModelsFor(client, [instance]);
        const providerAliases = {
          execution: {
            model: models.get(instance.instanceId) ?? "",
            providerDisplayName: instance.displayName,
          },
        };

        await client.dispatch({
          commandId: globalThis.crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          projectId: fixture.configuration.adHocProject.projectId,
          title: fixture.configuration.adHocProject.name,
          type: "project.create",
          workspaceRoot: fixture.repositoryRoot,
        });

        const configurationDirectory = join(scratch.root, "configuration");
        await mkdir(configurationDirectory, { recursive: true });
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
          // An empty budget catalog forbids `providerUsage`; this row advances a
          // stage rather than spawning a child, so it needs neither.
          pacing: { ...configuredPacing, providerBudgets: {} },
          providerAliases,
          server: { host: "127.0.0.1", port: servicePort },
          session: {
            ...configuredSession,
            defaultProviderAlias: "execution",
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
            await delay(1_000);
          }
          // What the session actually did is the evidence that matters. The
          // server log shows only startup unless something failed inside T3.
          const stalled = (await client.getShell()).threads.find(
            (candidate) =>
              typeof candidate["title"] === "string" &&
              (candidate["title"] as string).includes("task-"),
          );
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
          throw new Error(
            `Native session never advanced the stage. Thread: ${snapshot} ||| SERVICE: ${serviceOutput
              .replace(/\s+/g, " ")
              .slice(-1500)}`,
          );
        })();
        expect(advanced).toBe("review");

        // The advance was the agent's own MCP call: this test never calls the
        // MCP boundary, so the only caller was the native session.
        const thread = (await client.getShell()).threads.find(
          ({ title }) => typeof title === "string" && title.includes("task-"),
        ) as
          | {
              modelSelection?: { instanceId?: string; model?: string };
              runtimeMode?: string;
            }
          | undefined;
        expect(thread).toBeDefined();
        expect(thread?.modelSelection?.instanceId).toBe(instance.instanceId);
        expect(thread?.modelSelection?.model).toBe(
          providerAliases.execution.model,
        );
        // Full access was forwarded unchanged, so the session ran without an
        // approval prompt.
        expect(thread?.runtimeMode).toBe("full-access");
      },
      1_500_000,
    );
  },
);
