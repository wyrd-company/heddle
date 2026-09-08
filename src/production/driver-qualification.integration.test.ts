// ---
// relationships:
//   verifies: heddle
//   references: t3-headless
// ---

import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { WorkflowMcpSessionResolver } from "../mcp-server/index.js";
import type { JsonValue } from "../persistence/index.js";

import {
  ProviderSelectionResolver,
  T3ControlPlaneClient,
} from "../control-plane/index.js";
import { resolveT3AwarenessPhase } from "../control-plane/t3-agent-awareness.js";
import { prepareProductionFixture } from "./composition.test-support.js";
import { createProductionComposition } from "./composition.js";
import { resolveProductionConfiguration } from "./configuration.js";
import {
  CONTROLLED_QUALIFICATION_EXECUTION as EXECUTION,
  CONTROLLED_QUALIFICATION_REVIEW as REVIEW,
  CONTROLLED_QUALIFICATION_SECOND_DRIVER as SECOND_DRIVER,
  makeQualificationScratch,
  startIsolatedT3,
} from "./driver-qualification.test-support.js";

const t3Binary = process.env["HEDDLE_T3_INTEGRATION_BINARY"];
/**
 * T3 discovers installed harnesses after it begins serving, so a single early
 * read reports every provider undiscovered. Poll until the configured
 * instances are ready rather than assuming the first answer is the truth.
 */
const readyModels = async (
  client: T3ControlPlaneClient,
): Promise<Map<string, string>> => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const catalog = await client.readProviderCatalog();
    const ready = [EXECUTION, REVIEW, SECOND_DRIVER].every((instance) =>
      catalog.some(
        (row) =>
          row.instanceId === instance.instanceId &&
          row.state === "ready" &&
          row.models.length > 0,
      ),
    );
    if (ready) {
      return new Map(
        catalog.map((row) => [row.instanceId, row.models[0]?.slug ?? ""]),
      );
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  throw new Error("Isolated T3 never finished provider discovery");
};

const aliasesFor = (models: Map<string, string>) => ({
  execution: {
    model: models.get(EXECUTION.instanceId) ?? "",
    providerDisplayName: EXECUTION.displayName,
  },
  review: {
    model: models.get(REVIEW.instanceId) ?? "",
    providerDisplayName: REVIEW.displayName,
  },
  secondary: {
    model: models.get(SECOND_DRIVER.instanceId) ?? "",
    providerDisplayName: SECOND_DRIVER.displayName,
  },
});

const storedCorrelationToken = (handoffs: JsonValue[]): string => {
  const stored = handoffs.find(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      value["kind"] === "stage-handoff" &&
      typeof value["correlationToken"] === "string",
  );
  if (
    typeof stored !== "object" ||
    stored === null ||
    Array.isArray(stored) ||
    typeof stored["correlationToken"] !== "string"
  ) {
    throw new Error("Activated stage has no correlation token");
  }
  return stored["correlationToken"];
};

const callMcpTool = async (
  composition: ReturnType<typeof createProductionComposition>,
  token: string,
  name: string,
  arguments_: Record<string, unknown>,
) => {
  const response = await composition.mcp.fetch(
    new globalThis.Request("http://production.invalid/mcp", {
      body: JSON.stringify({
        id: globalThis.crypto.randomUUID(),
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: arguments_, name },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    result?: {
      content?: Array<{ text?: string }>;
      isError?: boolean;
      structuredContent?: unknown;
    };
  };
};

const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  // Unconditional, so an assertion failure under mutation cannot leak a real
  // T3 process, a composition holding its workspace, or a scratch directory.
  const pending = teardown.splice(0, teardown.length).reverse();
  for (const release of pending) await release();
});

describe.skipIf(!t3Binary)(
  "driver qualification against production Heddle",
  () => {
    it("lists aliases through the composition's own resolver and real T3 client", async () => {
      const scratch = await makeQualificationScratch();
      teardown.push(scratch.cleanup);
      const fixture = await prepareProductionFixture();
      teardown.push(fixture.cleanup);

      const isolated = await startIsolatedT3({
        binary: t3Binary as string,
        providerInstances: [EXECUTION, REVIEW, SECOND_DRIVER],
        scratch: scratch.root,
      });
      teardown.push(isolated.stop);

      const catalogClient = new T3ControlPlaneClient({
        accessToken: isolated.accessToken,
        baseUrl: isolated.baseUrl,
      });
      const models = await readyModels(catalogClient);
      const providerAliases = aliasesFor(models);
      const t3Configuration = {
        accessToken: isolated.accessToken,
        baseUrl: isolated.baseUrl,
      };
      const configuration = await resolveProductionConfiguration(
        {
          ...fixture.configuration,
          providerAliases,
          session: {
            ...fixture.configuration.session,
            defaultProviderAlias: "execution",
          },
          t3: t3Configuration,
        },
        new ProviderSelectionResolver(providerAliases, catalogClient),
      );

      // Neither `t3` nor `providerResolver` is supplied, so the composition
      // constructs the real control-plane client and the real resolver itself.
      const composition = createProductionComposition({
        blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
        configuration,
        providerUsage: { readProviderUsage: async () => [] },
        workflowMcpEndpoint: `${isolated.baseUrl}/mcp`,
      });
      teardown.push(() => composition.close());

      const listing = await composition.subagents.listProviders();
      const byAlias = new Map(
        listing.aliases.map((entry) => [entry.alias, entry]),
      );

      expect([...byAlias.keys()].sort()).toEqual([
        "execution",
        "review",
        "secondary",
      ]);

      // Two differently named T3 instances of one driver stay distinct, and
      // every alias is selectable through the real catalog.
      expect(byAlias.get("execution")?.providerDisplayName).toBe(
        EXECUTION.displayName,
      );
      expect(byAlias.get("review")?.providerDisplayName).toBe(
        REVIEW.displayName,
      );
      expect(byAlias.get("execution")?.driverKind).toBe(EXECUTION.driver);
      expect(byAlias.get("review")?.driverKind).toBe(REVIEW.driver);
      expect(byAlias.get("secondary")?.driverKind).toBe(SECOND_DRIVER.driver);
      for (const alias of ["execution", "review", "secondary"]) {
        expect(byAlias.get(alias)?.selectable).toBe(true);
        expect(byAlias.get(alias)?.reason).toBeNull();
        expect(byAlias.get(alias)?.model.slug).toBe(
          providerAliases[alias as keyof typeof providerAliases].model,
        );
      }

      // `list_providers` exposes the operator-visible display name, not T3's
      // routing identity. The binding carries the instance and the observed CLI
      // version, which is where qualification provenance is recorded.
      const bindings = new Map(
        configuration.session.resolvedSelections.map((selection) => [
          selection.alias,
          selection,
        ]),
      );
      expect(bindings.get("execution")?.providerInstanceId).toBe(
        EXECUTION.instanceId,
      );
      expect(bindings.get("review")?.providerInstanceId).toBe(
        REVIEW.instanceId,
      );
      expect(bindings.get("secondary")?.providerInstanceId).toBe(
        SECOND_DRIVER.instanceId,
      );
      for (const alias of ["execution", "review", "secondary"]) {
        expect(bindings.get(alias)?.observedCliVersion).toMatch(
          /^\d+\.\d+\.\d+/,
        );
      }
    }, 180_000);

    it("activates a stage session and spawns a delegated child on the real control plane", async () => {
      const scratch = await makeQualificationScratch();
      teardown.push(scratch.cleanup);
      const fixture = await prepareProductionFixture();
      teardown.push(fixture.cleanup);

      const isolated = await startIsolatedT3({
        binary: t3Binary as string,
        providerInstances: [EXECUTION, REVIEW, SECOND_DRIVER],
        scratch: scratch.root,
      });
      teardown.push(isolated.stop);

      const catalogClient = new T3ControlPlaneClient({
        accessToken: isolated.accessToken,
        baseUrl: isolated.baseUrl,
      });
      const models = await readyModels(catalogClient);
      const providerAliases = aliasesFor(models);

      const configuration = await resolveProductionConfiguration(
        {
          ...fixture.configuration,
          adHocProject: {
            ...fixture.configuration.adHocProject,
            workspaceRoot: fixture.repositoryRoot,
          },
          pacing: {
            ...fixture.configuration.pacing,
            providerBudgets: {
              execution: { usageLimit: 100 },
              secondary: { usageLimit: 100 },
            },
          },
          providerAliases,
          session: {
            ...fixture.configuration.session,
            defaultProviderAlias: "execution",
          },
          t3: { accessToken: isolated.accessToken, baseUrl: isolated.baseUrl },
        },
        new ProviderSelectionResolver(providerAliases, catalogClient),
      );

      const composition = createProductionComposition({
        blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
        configuration,
        providerUsage: {
          readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
        },
        workflowMcpEndpoint: `${isolated.baseUrl}/mcp`,
      });
      teardown.push(() => composition.close());

      await composition.start();

      const sharedProject = (await catalogClient.getShell()).projects.find(
        ({ id }) => id === configuration.adHocProject.projectId,
      );
      expect(sharedProject).toMatchObject({
        id: configuration.adHocProject.projectId,
        title: configuration.adHocProject.name,
        workspaceRoot: configuration.adHocProject.workspaceRoot,
      });
      expect(composition.persistence.getSharedProject()).toMatchObject({
        projectId: configuration.adHocProject.projectId,
        state: "active",
      });

      const instanceId = `task-${fixture.taskId}`;
      const activated = composition.persistence.getInstance(instanceId);
      expect(activated).toBeDefined();

      const resolver = new WorkflowMcpSessionResolver(composition.persistence);
      const parent = await resolver.resolve(
        storedCorrelationToken(activated!.state.handoffs),
      );

      const parentRuntime = composition.persistence
        .listSessionRuntime()
        .find(({ sessionKey }) => sessionKey === parent.sessionKey);
      expect(parentRuntime).toBeDefined();

      // In production an agent calls `spawn` from inside its own running
      // session, so the parent is live in T3's shell by then. Wait for that
      // rather than spawning from a session T3 has not started.
      const parentPhase = await (async () => {
        let lastObservation: unknown = "thread absent";
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const shell = await catalogClient.getShell();
          const thread = shell.threads.find(
            ({ id }) => id === parentRuntime?.threadId,
          );
          const phase =
            thread === undefined ? undefined : resolveT3AwarenessPhase(thread);
          lastObservation =
            thread === undefined
              ? "thread absent"
              : {
                  latestTurn: thread.latestTurn,
                  phase,
                  session: thread.session,
                };

          if (
            phase === "running" ||
            phase === "waiting_for_input" ||
            phase === "waiting_for_approval"
          ) {
            return phase;
          }
          if (phase === "failed" || phase === "ended") {
            throw new Error(
              `Parent session reached '${phase}' before it could spawn`,
            );
          }
          await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
        }
        throw new Error(
          `Parent session never became active in T3: ${JSON.stringify(lastObservation)}`,
        );
      })();
      expect(parentPhase).toBeDefined();

      // The agent's own tool surface, over the real MCP boundary.
      const listed = await callMcpTool(
        composition,
        parent.token,
        "list_providers",
        {},
      );
      expect(listed.result?.isError).not.toBe(true);
      expect(JSON.stringify(listed)).not.toContain("providerInstanceId");

      // A delegated child through the real spawn tool, selecting a different
      // provider instance than the parent's.
      // `spawn` assigns a todo subtree rather than a prose brief: the child is
      // delegated the stage's own todo item.
      const spawned = await callMcpTool(composition, parent.token, "spawn", {
        operationId: "qualification-child",
        providerAlias: "secondary",
        rootItemId: "deliver",
      });
      expect(spawned.result?.isError).not.toBe(true);
      const child = spawned.result?.structuredContent as {
        assignment?: {
          binding?: Record<string, unknown>;
          depth?: number;
          parentSessionKey?: string;
          rootItemId?: string;
          status?: string;
        };
        kind?: string;
      };
      expect(child.kind).toBe("spawned");

      // Cross-provider delivery: the child is bound to a different driver and a
      // different T3 instance than its parent, both resolved from the live
      // catalog.
      expect(child.assignment?.binding).toMatchObject({
        alias: "secondary",
        driverKind: SECOND_DRIVER.driver,
        providerDisplayName: SECOND_DRIVER.displayName,
        providerInstanceId: SECOND_DRIVER.instanceId,
      });
      expect(child.assignment?.binding?.["modelSlug"]).toBe(
        providerAliases.secondary.model,
      );
      expect(child.assignment?.binding?.["observedCliVersion"]).toMatch(
        /^\d+\.\d+\.\d+/,
      );
      expect(child.assignment?.parentSessionKey).toBe(parent.sessionKey);
      expect(child.assignment?.depth).toBe(1);
      expect(child.assignment?.rootItemId).toBe("deliver");
      expect(child.assignment?.status).toBe("active");

      // The parent stayed on its own binding rather than inheriting the child's.
      expect(parentRuntime?.binding.providerInstanceId).toBe(
        EXECUTION.instanceId,
      );
      expect(parentRuntime?.binding.driverKind).toBe(EXECUTION.driver);

      // Each thread carries its own binding at the control plane. A later turn
      // or a parent notification targets an existing bound thread and does not
      // select again, so the recipient's provider and runtime are whatever its
      // thread was bound with -- never the other party's.
      const shell = await catalogClient.getShell();
      const parentThread = shell.threads.find(
        ({ id }) => id === parentRuntime?.threadId,
      ) as
        | { modelSelection?: { instanceId?: string; model?: string } }
        | undefined;
      const childThread = shell.threads.find(
        ({ id }) => id === child.assignment?.binding?.["threadId"],
      ) as
        | { modelSelection?: { instanceId?: string; model?: string } }
        | undefined;

      expect(parentThread).toBeDefined();
      expect(childThread).toBeDefined();
      expect(parentThread?.modelSelection?.instanceId).toBe(
        EXECUTION.instanceId,
      );
      expect(childThread?.modelSelection?.instanceId).toBe(
        SECOND_DRIVER.instanceId,
      );
      expect(parentThread?.modelSelection?.model).toBe(
        providerAliases.execution.model,
      );
      expect(childThread?.modelSelection?.model).toBe(
        providerAliases.secondary.model,
      );
      expect(parentThread?.modelSelection?.instanceId).not.toBe(
        childThread?.modelSelection?.instanceId,
      );
    }, 300_000);
  },
);
