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

import {
  GitAgentNameThemeCatalog,
  validateAgentNameThemeRepository,
} from "./theme-catalog.js";

const execute = promisify(execFile);
const roots: string[] = [];
const header = `$schema: https://wyrd.company/heddle/agent-name-theme.schema.json
relationships:
  implements: heddle
`;
const team = (leader = "sample-lead") => `${header}kind: team
leader: ${leader}
companions: [sample-companion]
allies: [sample-ally]
antagonists: [sample-antagonist]
neutrals: [sample-neutral]
`;
const soloist = (hero = "sample-hero") => `${header}kind: soloist
heroes: [${hero}]
villains: [sample-villain]
bystanders: [sample-bystander]
`;

const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "heddle-agent-name-catalog-"));
  roots.push(root);
  await mkdir(join(root, "themes"));
  await writeFile(join(root, "themes", "sample-team.yml"), team());
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
      "Add sample theme",
    ],
    { cwd: root },
  );
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("agent-name theme catalog", () => {
  it("loads an exact Git commit instead of mutable working-tree content", async () => {
    const root = await repository();
    const commit = (
      await execute("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim();
    await writeFile(join(root, "themes", "sample-team.yml"), team("changed"));

    const themes = await new GitAgentNameThemeCatalog(root, "HEAD").read(
      commit,
    );

    expect(themes[0]).toMatchObject({
      id: "sample-team",
      leader: "sample-lead",
    });
  });

  it("rejects a duplicate name across different themes and lists", async () => {
    const root = await repository();
    await writeFile(
      join(root, "themes", "sample-soloist.yml"),
      soloist("sample-ally"),
    );

    await expect(validateAgentNameThemeRepository(root)).rejects.toThrow(
      'Agent name "sample-ally" is repeated',
    );
  });

  it("rejects a second soloist theme", async () => {
    const root = await repository();
    await writeFile(join(root, "themes", "sample-soloist.yml"), soloist());
    await writeFile(
      join(root, "themes", "second-soloist.yml"),
      soloist("second-hero")
        .replace("sample-villain", "second-villain")
        .replace("sample-bystander", "second-bystander"),
    );

    await expect(validateAgentNameThemeRepository(root)).rejects.toThrow(
      "must not contain more than one soloist theme",
    );
  });
});
