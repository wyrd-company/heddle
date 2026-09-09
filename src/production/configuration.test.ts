// ---
// relationships:
//   verifies: heddle
// ---

import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  validateProductionConfiguration,
  type ProductionConfiguration,
} from "./configuration.js";

const fixture = (): ProductionConfiguration => ({
  adHocProject: {
    name: "Shared tasks",
    projectId: "shared-project",
    workspaceRoot: "/tmp/sample-workspace",
  },
  boardDirectory: "/tmp/sample-board",
  cadenceMilliseconds: 1_000,
  incident: {
    approvalSeverityThreshold: "high",
    failureThreshold: 3,
    githubIssueRepository: "sample-owner/sample-repository",
    immediateEscalationCodes: [],
    retryDelayMilliseconds: 60_000,
    workspaceRoot: "/tmp/sample-workspace",
  },
  observationThresholds: {
    endedMilliseconds: 1_000,
    failedMilliseconds: 1_000,
    stalledMilliseconds: 1_000,
  },
  pacing: {
    maxConcurrentSessions: 1,
    providerBudgets: { primary: { usageLimit: 1 } },
    subagents: { maxDepth: 1, maxFanOut: 1 },
    usageWindowHours: 5,
  },
  providerAliases: {
    primary: {
      model: "sample-model",
      providerDisplayName: "Workbench Alpha",
    },
  },
  products: [
    {
      epicProject: { epicId: 101, projectId: "epic-project" },
      name: "Sample product",
      repos: [
        {
          name: "sample-repository",
          repositoryRoot: "/tmp/sample-repository",
        },
      ],
    },
  ],
  pushover: {
    apiUrl: "https://notify.invalid/messages",
    applicationToken: "application-token",
    consoleBaseUrl: "https://console.invalid/",
    recipientLabel: "Primary operator",
    userKey: "operator-key",
  },
  session: {
    baseRef: "main",
    defaultProviderAlias: "primary",
    defaultRuntimeMode: "auto",
    interactionMode: "default",
    skillPointer: "skill://sample",
  },
  stageThresholds: { implement: 10_000 },
  stateDirectory: "/tmp/sample-state",
  stopTimeoutMilliseconds: 1_000,
  t3: { accessToken: "access-token", baseUrl: "http://127.0.0.1:3999" },
});

describe("production configuration", () => {
  it("accepts both the legacy single-object alias and an ordered candidate list", async () => {
    const schema = JSON.parse(
      await readFile("schemas/production-configuration.json", "utf8"),
    );
    const validate = new Ajv2020({
      allErrors: true,
      formats: { uri: true },
      strict: false,
    }).compile(schema);
    const legacy: ProductionConfiguration = {
      ...fixture(),
      pacing: { ...fixture().pacing, providerBudgets: {} },
    };
    const ordered: ProductionConfiguration = {
      ...legacy,
      providerAliases: {
        primary: [
          fixture().providerAliases["primary"] as {
            model: string;
            providerDisplayName: string;
          },
          { model: "sample-model-two", providerDisplayName: "Workbench Beta" },
        ],
      },
    };

    expect(validate(legacy), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(ordered), JSON.stringify(validate.errors)).toBe(true);
    expect(validateProductionConfiguration(legacy)).toBe(legacy);
    expect(validateProductionConfiguration(ordered)).toBe(ordered);
  });

  it("rejects an empty candidate list through both configuration boundaries", async () => {
    const schema = JSON.parse(
      await readFile("schemas/production-configuration.json", "utf8"),
    );
    const validate = new Ajv2020({
      allErrors: true,
      formats: { uri: true },
      strict: false,
    }).compile(schema);
    const invalid = {
      ...fixture(),
      providerAliases: { primary: [] },
    } as ProductionConfiguration;

    expect(validate(invalid)).toBe(false);
    expect(() => validateProductionConfiguration(invalid)).toThrow(
      "providerAliases.primary must not be empty",
    );
  });

  it("keeps the runtime validator and JSON schema required surface aligned", async () => {
    const schema = JSON.parse(
      await readFile("schemas/production-configuration.json", "utf8"),
    ) as { properties: Record<string, unknown>; required: string[] };
    const configuration = fixture();
    expect(Object.keys(schema.properties).sort()).toEqual(
      [...Object.keys(configuration), "providerUsage", "server"].sort(),
    );
    expect([...schema.required].sort()).toEqual(
      Object.keys(configuration).sort(),
    );
    const validate = new Ajv2020({
      allErrors: true,
      formats: { uri: true },
      strict: false,
    }).compile(schema);
    const deploymentDocument = {
      ...configuration,
      providerUsage: {
        arguments: [],
        executable: "/tmp/sample-provider-usage",
        timeoutMilliseconds: 1_000,
      },
    };
    expect(validate(deploymentDocument), JSON.stringify(validate.errors)).toBe(
      true,
    );
    expect(validateProductionConfiguration(configuration)).toBe(configuration);
  });

  it("validates operator-owned incident authority and policy", async () => {
    const schema = JSON.parse(
      await readFile("schemas/production-configuration.json", "utf8"),
    );
    const incident = {
      approvalSeverityThreshold: "high" as const,
      failureThreshold: 3,
      githubIssueRepository: "sample-owner/sample-repository",
      immediateEscalationCodes: ["known-fatal-shape"],
      retryDelayMilliseconds: 1_000,
      workspaceRoot: "/tmp/sample-workspace",
    };
    const configured = {
      ...fixture(),
      incident,
      providerUsage: {
        arguments: [],
        executable: "/tmp/sample-provider-usage",
        timeoutMilliseconds: 1_000,
      },
    };
    const validate = new Ajv2020({
      allErrors: true,
      formats: { uri: true },
      strict: false,
    }).compile(schema);

    expect(validate(configured), JSON.stringify(validate.errors)).toBe(true);
    expect(validateProductionConfiguration(configured)).toBe(configured);
    expect(() =>
      validateProductionConfiguration({
        ...configured,
        incident: { ...incident, githubIssueRepository: "missing-owner" },
      }),
    ).toThrow("must be an owner/name repository");
  });

  it("rejects an invalid cadence through both configuration boundaries", async () => {
    const schema = JSON.parse(
      await readFile("schemas/production-configuration.json", "utf8"),
    );
    const invalid = { ...fixture(), cadenceMilliseconds: 0 };
    const validate = new Ajv2020({
      allErrors: true,
      formats: { uri: true },
      strict: false,
    }).compile(schema);
    expect(validate(invalid)).toBe(false);
    expect(() => validateProductionConfiguration(invalid)).toThrow(
      "cadenceMilliseconds must be a positive safe integer",
    );
  });

  it("rejects a default alias outside the configured allowlist", () => {
    const invalid = {
      ...fixture(),
      session: { ...fixture().session, defaultProviderAlias: "missing" },
    };

    expect(() => validateProductionConfiguration(invalid)).toThrow(
      "session.defaultProviderAlias 'missing' is not configured in providerAliases",
    );
  });

  it("rejects an inherited prototype key as the default alias", () => {
    const invalidDefault = {
      ...fixture(),
      session: { ...fixture().session, defaultProviderAlias: "constructor" },
    };
    expect(() => validateProductionConfiguration(invalidDefault)).toThrow(
      "session.defaultProviderAlias 'constructor' is not configured in providerAliases",
    );
  });

  it("rejects an inherited prototype key as a budget alias", () => {
    const invalidBudget = {
      ...fixture(),
      pacing: {
        ...fixture().pacing,
        providerBudgets: { constructor: { usageLimit: 1 } },
      },
    };
    expect(() => validateProductionConfiguration(invalidBudget)).toThrow(
      "pacing.providerBudgets alias 'constructor' is not configured in providerAliases",
    );
  });

  it("rejects malformed alias keys and pacing aliases outside the allowlist", () => {
    expect(() =>
      validateProductionConfiguration({
        ...fixture(),
        providerAliases: {
          "Not Valid": fixture().providerAliases["primary"]!,
        },
        session: { ...fixture().session, defaultProviderAlias: "Not Valid" },
      }),
    ).toThrow("must be a lower-kebab alias");

    expect(() =>
      validateProductionConfiguration({
        ...fixture(),
        pacing: {
          ...fixture().pacing,
          providerBudgets: { missing: { usageLimit: 1 } },
        },
      }),
    ).toThrow(
      "pacing.providerBudgets alias 'missing' is not configured in providerAliases",
    );
  });

  it("rejects a recipient label that contains a Pushover credential", () => {
    const invalid = {
      ...fixture(),
      pushover: {
        ...fixture().pushover,
        recipientLabel: "Primary operator-key recipient",
      },
    };

    expect(() => validateProductionConfiguration(invalid)).toThrow(
      "pushover.recipientLabel must not contain a Pushover credential",
    );
  });

  it("rejects a whitespace-only recipient label through both configuration boundaries", async () => {
    const schema = JSON.parse(
      await readFile("schemas/production-configuration.json", "utf8"),
    );
    const invalid = {
      ...fixture(),
      providerUsage: {
        arguments: [],
        executable: "/tmp/sample-provider-usage",
        timeoutMilliseconds: 1_000,
      },
      pushover: { ...fixture().pushover, recipientLabel: "   " },
    };
    const validate = new Ajv2020({
      allErrors: true,
      formats: { uri: true },
      strict: false,
    }).compile(schema);

    expect(validate(invalid)).toBe(false);
    expect(() => validateProductionConfiguration(invalid)).toThrow(
      "pushover.recipientLabel must not be empty",
    );
  });

  it("rejects a repository referenced by more than one product", () => {
    const invalid: ProductionConfiguration = {
      ...fixture(),
      products: [
        ...fixture().products,
        {
          name: "Second product",
          repos: [
            {
              name: "sample-repository",
              repositoryRoot: "/tmp/second-repository",
            },
          ],
        },
      ],
    };

    expect(() => validateProductionConfiguration(invalid)).toThrow(
      "must belong to exactly one product",
    );
  });

  it.each([
    {
      name: "t3.baseUrl",
      mutate: (configuration: ProductionConfiguration) => ({
        ...configuration,
        t3: { ...configuration.t3, baseUrl: "local-t3" },
      }),
    },
    {
      name: "pushover.apiUrl",
      mutate: (configuration: ProductionConfiguration) => ({
        ...configuration,
        pushover: { ...configuration.pushover, apiUrl: "local-notifier" },
      }),
    },
    {
      name: "pushover.consoleBaseUrl",
      mutate: (configuration: ProductionConfiguration) => ({
        ...configuration,
        pushover: {
          ...configuration.pushover,
          consoleBaseUrl: "local-console",
        },
      }),
    },
  ])(
    "rejects non-HTTP $name through both configuration boundaries",
    async ({ mutate, name }) => {
      const schema = JSON.parse(
        await readFile("schemas/production-configuration.json", "utf8"),
      );
      const invalid = mutate(fixture());
      const validate = new Ajv2020({
        allErrors: true,
        formats: { uri: true },
        strict: false,
      }).compile(schema);

      expect(validate(invalid)).toBe(false);
      expect(() => validateProductionConfiguration(invalid)).toThrow(
        `${name} must be an HTTP URL`,
      );
    },
  );
});
