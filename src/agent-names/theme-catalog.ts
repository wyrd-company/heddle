// ---
// relationships:
//   implements: heddle
// ---

import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { Ajv2020 } from "ajv/dist/2020.js";
import { parse } from "yaml";

const execute = promisify(execFile);
const schemaPath = resolve(
  import.meta.dirname,
  "../../schemas/agent-name-theme.json",
);
const themeIdPattern = /^[a-z]+(?:-[a-z]+)*$/;
const themePathPattern = /^themes\/[a-z]+(?:-[a-z]+)*\.ya?ml$/;

export const agentNameListNames = [
  "leader",
  "companions",
  "allies",
  "antagonists",
  "neutrals",
  "heroes",
  "villains",
  "bystanders",
] as const;

export type AgentNameListName = (typeof agentNameListNames)[number];
export type AgentNameThemeKind = "soloist" | "team";

type ThemeArtifact = {
  $schema: string;
  kind: AgentNameThemeKind;
  relationships: { implements: "heddle" };
};

export type TeamAgentNameTheme = ThemeArtifact & {
  allies: string[];
  antagonists: string[];
  companions: string[];
  kind: "team";
  leader: string;
  neutrals: string[];
};

export type SoloistAgentNameTheme = ThemeArtifact & {
  bystanders: string[];
  heroes: string[];
  kind: "soloist";
  villains: string[];
};

export type AgentNameTheme = (TeamAgentNameTheme | SoloistAgentNameTheme) & {
  id: string;
};

export type AgentNameThemeCatalogSnapshot = {
  commit: string;
  themes: readonly AgentNameTheme[];
};

export class AgentNameCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentNameCatalogError";
  }
}

const themeNames = (theme: AgentNameTheme): string[] =>
  theme.kind === "team"
    ? [
        theme.leader,
        ...theme.companions,
        ...theme.allies,
        ...theme.antagonists,
        ...theme.neutrals,
      ]
    : [...theme.heroes, ...theme.villains, ...theme.bystanders];

const validateCatalog = (themes: readonly AgentNameTheme[]): void => {
  if (themes.length === 0) {
    throw new AgentNameCatalogError(
      "Agent-name theme catalog must contain at least one theme",
    );
  }
  const soloists = themes.filter(({ kind }) => kind === "soloist");
  if (soloists.length > 1) {
    throw new AgentNameCatalogError(
      "Agent-name theme catalog must not contain more than one soloist theme",
    );
  }
  const owners = new Map<string, string>();
  for (const theme of themes) {
    for (const name of themeNames(theme)) {
      const owner = owners.get(name);
      if (owner !== undefined) {
        throw new AgentNameCatalogError(
          `Agent name ${JSON.stringify(name)} is repeated by themes ${JSON.stringify(owner)} and ${JSON.stringify(theme.id)}`,
        );
      }
      owners.set(name, theme.id);
    }
  }
};

const parseThemes = async (
  entries: readonly { path: string; source: string }[],
): Promise<readonly AgentNameTheme[]> => {
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as object;
  const validator = new Ajv2020({ allErrors: true, strict: false }).compile(
    schema,
  );
  const ids = new Set<string>();
  const themes = entries
    .map(({ path, source }) => {
      if (!themePathPattern.test(path)) {
        throw new AgentNameCatalogError(
          `Agent-name theme path is invalid: ${JSON.stringify(path)}`,
        );
      }
      const id = basename(path, extname(path));
      if (!themeIdPattern.test(id) || ids.has(id)) {
        throw new AgentNameCatalogError(
          `Agent-name theme identity is invalid or repeated: ${JSON.stringify(id)}`,
        );
      }
      ids.add(id);
      let value: unknown;
      try {
        value = parse(source);
      } catch (error) {
        throw new AgentNameCatalogError(
          `Agent-name theme ${JSON.stringify(id)} is invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!validator(value)) {
        throw new AgentNameCatalogError(
          `Agent-name theme ${JSON.stringify(id)} violates the theme schema: ${JSON.stringify(validator.errors)}`,
        );
      }
      return { ...(value as TeamAgentNameTheme | SoloistAgentNameTheme), id };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  validateCatalog(themes);
  return themes;
};

export const validateAgentNameThemeRepository = async (
  repositoryRoot: string,
): Promise<readonly AgentNameTheme[]> => {
  const directory = join(resolve(repositoryRoot), "themes");
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: unknown) => {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    },
  );
  const themeEntries = entries
    .filter(({ name }) => /\.ya?ml$/.test(name))
    .map((entry) => {
      if (!entry.isFile()) {
        throw new AgentNameCatalogError(
          `Agent-name theme entry ${JSON.stringify(entry.name)} must be a file`,
        );
      }
      return entry.name;
    })
    .sort();
  return parseThemes(
    await Promise.all(
      themeEntries.map(async (name) => ({
        path: `themes/${name}`,
        source: await readFile(join(directory, name), "utf8"),
      })),
    ),
  );
};

export class GitAgentNameThemeCatalog {
  public readonly repositoryRoot: string;

  constructor(
    repositoryRoot: string,
    private readonly sourceRef = "refs/remotes/origin/HEAD",
  ) {
    this.repositoryRoot = resolve(repositoryRoot);
  }

  async validateCurrent(): Promise<AgentNameThemeCatalogSnapshot> {
    const { stdout } = await execute(
      "git",
      [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${this.sourceRef}^{commit}`,
      ],
      { cwd: this.repositoryRoot },
    );
    const commit = stdout.trim();
    return { commit, themes: await this.read(commit) };
  }

  async read(commit: string): Promise<readonly AgentNameTheme[]> {
    if (!/^[0-9a-f]{40,64}$/.test(commit)) {
      throw new AgentNameCatalogError(
        `Agent-name catalog commit is invalid: ${JSON.stringify(commit)}`,
      );
    }
    const { stdout } = await execute(
      "git",
      ["ls-tree", "-r", "--name-only", commit, "--", "themes"],
      { cwd: this.repositoryRoot },
    );
    const paths = stdout
      .split("\n")
      .filter((path) => path !== "" && /\.ya?ml$/.test(path))
      .sort();
    const entries = await Promise.all(
      paths.map(async (path) => ({
        path,
        source: (
          await execute("git", ["show", `${commit}:${path}`], {
            cwd: this.repositoryRoot,
          })
        ).stdout,
      })),
    );
    return parseThemes(entries);
  }
}

export const namesForThemeList = (
  theme: AgentNameTheme,
  list: AgentNameListName,
): readonly string[] | undefined => {
  if (theme.kind === "team") {
    if (list === "leader") return [theme.leader];
    if (
      list === "companions" ||
      list === "allies" ||
      list === "antagonists" ||
      list === "neutrals"
    ) {
      return theme[list];
    }
    return undefined;
  }
  if (list === "heroes" || list === "villains" || list === "bystanders") {
    return theme[list];
  }
  return undefined;
};
