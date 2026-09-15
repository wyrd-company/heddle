// ---
// relationships:
//   implements: heddle
// ---

import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  questionNodeParams,
  questionNodeUse,
  readBlueprintArtifacts,
  validateBlueprintRepository,
  type LifecycleBlueprint,
  type LifecycleNode,
} from "../engine/index.js";
import {
  conventionalAdjudicationPolicyPath,
  type ProductionConfiguration,
} from "../production/index.js";

/**
 * One thing a blueprint node asks of the deployment that runs it. `unmet`
 * carries why this deployment cannot supply it, and is absent when it can.
 */
export type DeploymentRequirement = {
  blueprint: string;
  configurationKey: string;
  node: string;
  requirement: string;
  unmet?: string;
};

/** What the installed deployment supplies, as the node checks read it. */
export type DeploymentCapabilities = {
  /** Absent when the deployment composes no adjudication at all. */
  adjudication?: {
    policyArtifactPresent: boolean;
    policyPath: string;
  };
  providerAliases: readonly string[];
};

export type BlueprintDeploymentValidation = {
  artifacts: string[];
  repositoryRoot: string;
  requirements: DeploymentRequirement[];
};

/** The configuration keys a blueprint author can be told to add. */
const adjudicationKey = "adjudication";
const adjudicationPolicyKey = "adjudication.policyPath";
const providerAliasKey = (alias: string): string => `providerAliases.${alias}`;

const asksTheAdjudicator = (node: LifecycleNode): boolean => {
  if (node.uses !== questionNodeUse) return false;
  return questionNodeParams(node).role === "adjudicator";
};

const adjudicationRequirement = (
  blueprint: string,
  node: LifecycleNode,
  capabilities: DeploymentCapabilities,
): DeploymentRequirement => {
  const requirement = "asks the adjudicator";
  const adjudication = capabilities.adjudication;
  if (adjudication === undefined) {
    return {
      blueprint,
      configurationKey: adjudicationKey,
      node: node.id,
      requirement,
      unmet: "this deployment composes no adjudication",
    };
  }
  if (!adjudication.policyArtifactPresent) {
    return {
      blueprint,
      configurationKey: adjudicationPolicyKey,
      node: node.id,
      requirement,
      unmet: `the adjudication policy artifact '${adjudication.policyPath}' is absent from the blueprint repository`,
    };
  }
  return {
    blueprint,
    configurationKey: adjudicationKey,
    node: node.id,
    requirement,
  };
};

const providerAliasRequirement = (
  blueprint: string,
  node: LifecycleNode,
  alias: string,
  capabilities: DeploymentCapabilities,
): DeploymentRequirement => ({
  blueprint,
  configurationKey: providerAliasKey(alias),
  node: node.id,
  requirement: `selects provider alias '${alias}'`,
  ...(capabilities.providerAliases.includes(alias)
    ? {}
    : { unmet: "the deployment defines no such alias" }),
});

/**
 * Every deployment-supplied requirement the catalog declares, met or not, in
 * blueprint then node order.
 */
export const blueprintDeploymentRequirements = (
  blueprints: readonly { blueprint: LifecycleBlueprint; id: string }[],
  capabilities: DeploymentCapabilities,
): DeploymentRequirement[] =>
  blueprints.flatMap(({ blueprint, id }) =>
    blueprint.nodes.flatMap((node) => {
      const requirements: DeploymentRequirement[] = [];
      if (asksTheAdjudicator(node)) {
        requirements.push(adjudicationRequirement(id, node, capabilities));
      }
      const alias = node["provider-alias"];
      if (alias !== undefined) {
        requirements.push(
          providerAliasRequirement(id, node, alias, capabilities),
        );
      }
      return requirements;
    }),
  );

const isFile = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => undefined))?.isFile() === true;

export const deploymentCapabilitiesOf = async (
  configuration: Pick<
    ProductionConfiguration,
    "adjudication" | "providerAliases"
  >,
  repositoryRoot: string,
): Promise<DeploymentCapabilities> => {
  const adjudication = configuration.adjudication;
  // A configuration the loader produced carries the conventional path already;
  // one composed in code may omit it, and both resolve to the same artifact.
  const policyPath =
    adjudication?.policyPath ?? conventionalAdjudicationPolicyPath;
  return {
    ...(adjudication === undefined
      ? {}
      : {
          adjudication: {
            policyArtifactPresent: await isFile(
              join(repositoryRoot, policyPath),
            ),
            policyPath,
          },
        }),
    providerAliases: Object.keys(configuration.providerAliases),
  };
};

/**
 * Validates the catalog as the service does, then reports what its nodes ask
 * of this deployment. Read-only: nothing here writes configuration, board, or
 * state.
 */
export const validateBlueprintDeployment = async (options: {
  blueprintsRepositoryRoot: string;
  configuration: Pick<
    ProductionConfiguration,
    "adjudication" | "providerAliases"
  >;
}): Promise<BlueprintDeploymentValidation> => {
  const repositoryRoot = resolve(options.blueprintsRepositoryRoot);
  const artifacts = await validateBlueprintRepository(repositoryRoot);
  const blueprints = (await readBlueprintArtifacts(repositoryRoot)).map(
    ({ artifact, artifactId }) => ({
      blueprint: {
        ...(artifact as Record<string, unknown>),
        id: artifactId,
      } as LifecycleBlueprint,
      id: artifactId,
    }),
  );
  return {
    artifacts,
    repositoryRoot,
    requirements: blueprintDeploymentRequirements(
      blueprints,
      await deploymentCapabilitiesOf(options.configuration, repositoryRoot),
    ),
  };
};

export const deploymentRequirementLine = (
  requirement: DeploymentRequirement,
): string =>
  `${requirement.blueprint} node '${requirement.node}': ${requirement.requirement}; ${requirement.unmet ?? "satisfied"}; configure '${requirement.configurationKey}'`;

/**
 * What the command writes and exits with: unmet requirements one per line on
 * standard error, otherwise a JSON summary on standard output.
 */
export const blueprintDeploymentReport = (
  validation: BlueprintDeploymentValidation,
): { exitCode: number; stderr: string; stdout: string } => {
  const unmet = validation.requirements.filter(
    ({ unmet }) => unmet !== undefined,
  );
  if (unmet.length > 0) {
    return {
      exitCode: 1,
      stderr: unmet
        .map((requirement) => `${deploymentRequirementLine(requirement)}\n`)
        .join(""),
      stdout: "",
    };
  }
  return {
    exitCode: 0,
    stderr: "",
    stdout: `${JSON.stringify(validation, null, 2)}\n`,
  };
};
