// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import type { ProductionConfiguration } from "../production/index.js";
import {
  blueprintDeploymentReport,
  validateBlueprintDeployment,
} from "./blueprint-deployment-requirements.js";
import { parseHeddleServerArguments } from "./configuration.js";

const execute = promisify(execFile);
const roots: string[] = [];

const handoffTemplate = "# {{ task.title }}\n";
const todoTemplate = `${JSON.stringify(
  { items: [{ id: "measure", text: "Measure {{task.title}}" }] },
  null,
  2,
)}\n`;
const theme = `$schema: https://wyrd.company/heddle/agent-name-theme.schema.json
relationships:
  implements: heddle
kind: team
leader: sample-lead
companions: [sample-companion]
allies: [sample-ally]
antagonists: [sample-antagonist]
neutrals: [sample-neutral]
`;
const adjudicationPolicy = {
  $schema: "https://wyrd.company/heddle/adjudication-policy.schema.json",
  relationships: { implements: "heddle" },
  "decision-boundary": {
    decide: ["Whether the tasting notes are complete"],
    escalate: ["Anything that changes the published recipe"],
    test: "Decide when the catalog already answers it; escalate otherwise.",
  },
};

/**
 * A recipe-catalog lifecycle whose taste stage names a provider alias and
 * whose approval asks the adjudicator: the two deployment-supplied
 * requirements a blueprint can declare.
 */
const cateringBlueprint = (
  commitSha: string,
  options: { providerAlias?: string; role?: string } = {},
) => ({
  $schema: "https://wyrd.company/heddle/lifecycle-blueprint.schema.json",
  relationships: {
    implements: "heddle",
    uses: ["sample-checklist", "sample-handoff"],
  },
  nodes: [
    { id: "gather", uses: "gather" },
    {
      "handoff-template": {
        commitSha,
        path: "handoff-templates/sample-handoff.md",
      },
      id: "taste",
      ...(options.providerAlias === undefined
        ? {}
        : { "provider-alias": options.providerAlias }),
      tools: ["advance"],
      "todo-template": "sample-checklist",
      uses: "wait",
    },
    {
      id: "approve",
      params: {
        questions: [
          {
            id: "publish",
            options: [{ label: "yes" }, { label: "no" }],
            question: "Publish the tasting notes?",
          },
        ],
        role: options.role ?? "adjudicator",
      },
      uses: "question",
    },
    { id: "publish", uses: "publish" },
    { id: "withdraw", uses: "withdraw" },
  ],
  edges: [
    { source: "gather", target: "taste" },
    {
      condition: "result.output.dispositions.complete",
      description: "Continue after tasting",
      disposition: "complete",
      source: "taste",
      target: "approve",
    },
    {
      condition: "result.output.selected.publish.yes",
      source: "approve",
      target: "publish",
    },
    {
      condition: "result.output.selected.publish.no",
      source: "approve",
      target: "withdraw",
    },
  ],
});

const blueprintRepository = async (options: {
  policyArtifactPath?: string;
  providerAlias?: string;
  role?: string;
}): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "heddle-deployment-catalog-"));
  roots.push(root);
  await mkdir(join(root, "blueprints"));
  await mkdir(join(root, "themes"));
  await writeFile(join(root, "themes", "sample-team.yml"), theme);
  await mkdir(join(root, "handoff-templates"));
  await writeFile(
    join(root, "handoff-templates", "sample-handoff.md"),
    handoffTemplate,
  );
  await mkdir(join(root, "todo-templates"));
  await writeFile(
    join(root, "todo-templates", "sample-checklist.json"),
    todoTemplate,
  );
  if (options.policyArtifactPath !== undefined) {
    await mkdir(join(root, "adjudication"), { recursive: true });
    await writeFile(
      join(root, options.policyArtifactPath),
      `${JSON.stringify(adjudicationPolicy, null, 2)}\n`,
    );
  }
  await execute("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: root,
  });
  await execute("git", ["add", "handoff-templates", "todo-templates"], {
    cwd: root,
  });
  await execute(
    "git",
    [
      "-c",
      "user.name=Sample User",
      "-c",
      "user.email=sample@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "add sample templates",
    ],
    { cwd: root },
  );
  const commitSha = (
    await execute("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  await writeFile(
    join(root, "blueprints", "catering-run.json"),
    `${JSON.stringify(
      cateringBlueprint(commitSha, {
        ...(options.providerAlias === undefined
          ? {}
          : { providerAlias: options.providerAlias }),
        ...(options.role === undefined ? {} : { role: options.role }),
      }),
      null,
      2,
    )}\n`,
  );
  return root;
};

const configuration = (options: {
  adjudicationPolicyPath?: string;
  providerAliases?: string[];
}): Pick<ProductionConfiguration, "adjudication" | "providerAliases"> => ({
  ...(options.adjudicationPolicyPath === undefined
    ? {}
    : {
        adjudication: {
          policyPath: options.adjudicationPolicyPath,
          providerAlias: "primary",
        },
      }),
  providerAliases: Object.fromEntries(
    (options.providerAliases ?? ["primary"]).map((alias) => [
      alias,
      { model: "sample-model", providerDisplayName: "Workbench Alpha" },
    ]),
  ),
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("blueprint requirements the deployment must supply", () => {
  it("reports a clean catalog with every requirement and its satisfying key", async () => {
    const root = await blueprintRepository({
      policyArtifactPath: "adjudication/policy.json",
      providerAlias: "primary",
    });

    const validation = await validateBlueprintDeployment({
      blueprintsRepositoryRoot: root,
      configuration: configuration({
        adjudicationPolicyPath: "adjudication/policy.json",
      }),
    });

    expect(validation.artifacts).toEqual([
      "catering-run",
      "adjudication/policy",
    ]);
    expect(validation.requirements).toEqual([
      {
        blueprint: "catering-run",
        configurationKey: "providerAliases.primary",
        node: "taste",
        requirement: "selects provider alias 'primary'",
      },
      {
        blueprint: "catering-run",
        configurationKey: "adjudication",
        node: "approve",
        requirement: "asks the adjudicator",
      },
    ]);
    const report = blueprintDeploymentReport(validation);
    expect(report).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(report.stdout)).toEqual(validation);
  });

  it("names the adjudication key when the deployment composes no adjudication", async () => {
    const root = await blueprintRepository({ providerAlias: "primary" });

    const report = blueprintDeploymentReport(
      await validateBlueprintDeployment({
        blueprintsRepositoryRoot: root,
        configuration: configuration({}),
      }),
    );

    expect(report.exitCode).toBe(1);
    expect(report.stdout).toBe("");
    expect(report.stderr).toBe(
      "catering-run node 'approve': asks the adjudicator; this deployment composes no adjudication; configure 'adjudication'\n",
    );
  });

  it("names the policy key when the configured policy artifact is absent", async () => {
    const root = await blueprintRepository({
      policyArtifactPath: "adjudication/policy.json",
      providerAlias: "primary",
    });

    const report = blueprintDeploymentReport(
      await validateBlueprintDeployment({
        blueprintsRepositoryRoot: root,
        configuration: configuration({
          adjudicationPolicyPath: "adjudication/house-rules.json",
        }),
      }),
    );

    expect(report.exitCode).toBe(1);
    expect(report.stderr).toBe(
      "catering-run node 'approve': asks the adjudicator; the adjudication policy artifact 'adjudication/house-rules.json' is absent from the blueprint repository; configure 'adjudication.policyPath'\n",
    );
  });

  it("names the alias key when a stage selects an alias the deployment does not define", async () => {
    const root = await blueprintRepository({
      policyArtifactPath: "adjudication/policy.json",
      providerAlias: "second-kitchen",
    });

    const report = blueprintDeploymentReport(
      await validateBlueprintDeployment({
        blueprintsRepositoryRoot: root,
        configuration: configuration({
          adjudicationPolicyPath: "adjudication/policy.json",
        }),
      }),
    );

    expect(report.exitCode).toBe(1);
    expect(report.stderr).toBe(
      "catering-run node 'taste': selects provider alias 'second-kitchen'; the deployment defines no such alias; configure 'providerAliases.second-kitchen'\n",
    );
  });

  it("asks nothing of the deployment for an operator question and an unselected stage", async () => {
    const root = await blueprintRepository({ role: "operator" });

    const validation = await validateBlueprintDeployment({
      blueprintsRepositoryRoot: root,
      configuration: configuration({}),
    });

    expect(validation.requirements).toEqual([]);
    expect(blueprintDeploymentReport(validation).exitCode).toBe(0);
  });

  it("refuses a catalog the repository validation itself rejects", async () => {
    const root = await blueprintRepository({ providerAlias: "primary" });
    await rm(join(root, "todo-templates", "sample-checklist.json"));

    await expect(
      validateBlueprintDeployment({
        blueprintsRepositoryRoot: root,
        configuration: configuration({}),
      }),
    ).rejects.toThrow("sample-checklist");
  });
});

/**
 * An installed deployment: a configuration directory whose own blueprints
 * clone tracks an origin, as the service requires at load. Every path is
 * disposable; nothing here resolves a conventional default.
 */
const installedDeployment = async (options: {
  adjudicationPolicyPath?: string;
}): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "heddle-installed-deployment-"));
  roots.push(root);
  const installedCatalog = join(root, "blueprints");
  const remote = join(root, "blueprints-origin.git");
  await mkdir(installedCatalog);
  await writeFile(join(installedCatalog, "README.md"), "# Sample catalog\n");
  await execute("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: installedCatalog,
  });
  await execute("git", ["add", "README.md"], { cwd: installedCatalog });
  await execute(
    "git",
    [
      "-c",
      "user.name=Sample User",
      "-c",
      "user.email=sample@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "add sample catalog",
    ],
    { cwd: installedCatalog },
  );
  await execute("git", ["init", "--quiet", "--bare", remote], { cwd: root });
  await execute("git", ["remote", "add", "origin", remote], {
    cwd: installedCatalog,
  });
  await execute(
    "git",
    ["push", "--quiet", "--set-upstream", "origin", "main"],
    { cwd: installedCatalog },
  );
  await writeFile(
    join(root, "config.yml"),
    stringify({
      adHocProject: { workspaceRoot: join(root, "workspace") },
      ...configuration(options),
      boardDirectory: join(root, "board"),
      cadenceMilliseconds: 1_000,
      incident: {
        failureThreshold: 3,
        githubIssueRepository: "sample-owner/sample-repository",
        retryDelayMilliseconds: 60_000,
        workspaceRoot: root,
      },
      observationThresholds: {
        endedMilliseconds: 1_000,
        failedMilliseconds: 1_000,
        stalledMilliseconds: 1_000,
      },
      pacing: {
        maxConcurrentSessions: 1,
        providerBudgets: {},
        subagents: { maxDepth: 1, maxFanOut: 1 },
        usageWindowHours: 5,
      },
      pushover: {
        apiUrl: "https://notify.invalid/messages",
        applicationToken: "application-secret-value",
        consoleBaseUrl: "https://console.invalid/",
        userKey: "operator-secret-value",
      },
      server: { port: 4999 },
      session: {
        baseRef: "main",
        defaultProviderAlias: "primary",
        defaultRuntimeMode: "auto",
        interactionMode: "default",
        skillPointer: "skill://sample",
      },
      stageThresholds: { taste: 10_000 },
      stateDirectory: join(root, "state"),
      stopTimeoutMilliseconds: 1_000,
      t3: {
        accessToken: "t3-secret-value",
        baseUrl: "http://127.0.0.1:3999",
      },
    }),
  );
  return root;
};

describe("the deployed validate-blueprints command", () => {
  it("writes the JSON summary and exits zero for a catalog this deployment can run", async () => {
    const catalog = await blueprintRepository({
      policyArtifactPath: "adjudication/policy.json",
      providerAlias: "primary",
    });
    const deployment = await installedDeployment({
      adjudicationPolicyPath: "adjudication/policy.json",
    });

    const { stderr, stdout } = await execute(
      process.execPath,
      [
        "bin/heddle-server.mjs",
        "validate-blueprints",
        catalog,
        "--config",
        deployment,
      ],
      { env: process.env },
    );

    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      artifacts: ["catering-run", "adjudication/policy"],
      repositoryRoot: catalog,
      requirements: [
        { configurationKey: "providerAliases.primary", node: "taste" },
        { configurationKey: "adjudication", node: "approve" },
      ],
    });
  });

  it("writes one line per mismatch and exits non-zero", async () => {
    const catalog = await blueprintRepository({
      providerAlias: "second-kitchen",
    });
    const deployment = await installedDeployment({});

    const failure = await execute(
      process.execPath,
      [
        "bin/heddle-server.mjs",
        "validate-blueprints",
        catalog,
        "--config",
        deployment,
      ],
      { env: process.env },
    ).catch(
      (error: unknown) =>
        error as { code: number; stderr: string; stdout: string },
    );

    expect(failure).toMatchObject({ code: 1, stdout: "" });
    expect(failure.stderr.split("\n").filter(Boolean)).toEqual([
      "catering-run node 'taste': selects provider alias 'second-kitchen'; the deployment defines no such alias; configure 'providerAliases.second-kitchen'",
      "catering-run node 'approve': asks the adjudicator; this deployment composes no adjudication; configure 'adjudication'",
    ]);
  });
});

describe("the validate-blueprints command line", () => {
  it("takes the repository root positionally and resolves it against the working directory", () => {
    expect(
      parseHeddleServerArguments(
        ["validate-blueprints", "catalog", "--config", "/tmp/sample-config"],
        {},
      ),
    ).toEqual({
      blueprintsRepositoryRoot: join(process.cwd(), "catalog"),
      command: "validate-blueprints",
      configurationDirectory: "/tmp/sample-config",
    });
    expect(
      parseHeddleServerArguments(
        ["validate-blueprints", "--config", "/tmp/sample-config", "/catalog"],
        {},
      ),
    ).toEqual({
      blueprintsRepositoryRoot: "/catalog",
      command: "validate-blueprints",
      configurationDirectory: "/tmp/sample-config",
    });
    expect(
      parseHeddleServerArguments(["validate-blueprints", "/catalog"], {
        HEDDLE_CONFIG: "/tmp/environment-config",
      }),
    ).toEqual({
      blueprintsRepositoryRoot: "/catalog",
      command: "validate-blueprints",
      configurationDirectory: "/tmp/environment-config",
    });
  });

  it("refuses a missing or repeated repository root", () => {
    for (const argument of [
      ["validate-blueprints"],
      ["validate-blueprints", "--config", "/tmp/sample-config"],
      ["validate-blueprints", "/catalog", "/other-catalog"],
      ["validate-blueprints", "  "],
    ]) {
      expect(() => parseHeddleServerArguments(argument, {})).toThrow(
        "Usage: heddle-server validate-blueprints <blueprints-repository-root>",
      );
    }
  });
});
