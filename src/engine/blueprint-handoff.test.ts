// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import { validateBlueprint } from "./blueprint.js";
import type { LifecycleBlueprint } from "./types.js";

const blueprint = (): LifecycleBlueprint => ({
  edges: [
    {
      condition: "result.output.dispositions.complete",
      description: "Complete the stage",
      disposition: "complete",
      source: "prepare",
      target: "finish",
    },
  ],
  nodes: [
    {
      handoff: "standard",
      "handoff-template": {
        commitSha: "a".repeat(40),
        path: "handoff-templates/standard.md",
      },
      id: "prepare",
      tools: ["advance"],
      "todo-template": "sample-prepare",
      uses: "wait",
    },
    { id: "finish", uses: "finish" },
  ],
});

const validate = (value: LifecycleBlueprint): void =>
  validateBlueprint(value, { finish: async () => null });

describe("lifecycle blueprint handoff metadata", () => {
  it("rejects an agent wait with missing handoff metadata", () => {
    const value = blueprint();
    delete value.nodes[0]!.handoff;

    expect(() => validate(value)).toThrow(
      'Agent wait node "prepare" has no handoff metadata',
    );
  });

  it("rejects invalid handoff metadata", () => {
    const value = blueprint();
    value.nodes[0]!.handoff = "private" as "standard";

    expect(() => validate(value)).toThrow(
      'Node "prepare" has invalid handoff metadata',
    );
  });

  it("rejects an agent wait without a pinned handoff template", () => {
    const value = blueprint();
    delete value.nodes[0]!["handoff-template"];

    expect(() => validate(value)).toThrow(
      'Agent wait node "prepare" has no valid pinned handoff template',
    );
  });

  it("rejects the removed handoff blobHash shape with a named diagnostic", () => {
    const value = blueprint();
    value.nodes[0]!["handoff-template"] = {
      blobHash: "a".repeat(40),
      path: "handoff-templates/standard.md",
    } as unknown as NonNullable<
      LifecycleBlueprint["nodes"][number]["handoff-template"]
    >;

    expect(() => validate(value)).toThrow(
      "uses removed handoff template field 'blobHash'; use 'commitSha'",
    );
  });

  it("accepts a SHA-256 handoff template commit pin", () => {
    const value = blueprint();
    value.nodes[0]!["handoff-template"]!.commitSha = "a".repeat(64);

    expect(() => validate(value)).not.toThrow();
  });

  it("accepts unique kebab-case skill names on a wait node", () => {
    const value = blueprint();
    value.nodes[0]!.skills = ["evidence-review", "task-execution"];

    expect(() => validate(value)).not.toThrow();
  });

  it("rejects a non-string stage skill with a named diagnostic", () => {
    const value = blueprint();
    value.nodes[0]!.skills = [17] as unknown as string[];

    expect(() => validate(value)).toThrow(
      'Node "prepare" skills must be a non-empty array of kebab-case names',
    );
  });

  it("rejects duplicate stage skills with a named diagnostic", () => {
    const value = blueprint();
    value.nodes[0]!.skills = ["evidence-review", "evidence-review"];

    expect(() => validate(value)).toThrow(
      'Node "prepare" skills must not contain duplicate names',
    );
  });

  it("rejects a stage skill name longer than 64 characters", () => {
    const value = blueprint();
    value.nodes[0]!.skills = ["a".repeat(65)];

    expect(() => validate(value)).toThrow(
      'Node "prepare" skills must be a non-empty array of kebab-case names no longer than 64 characters',
    );
  });

  it("rejects stage skills on a non-wait node", () => {
    const value = blueprint();
    value.nodes[1]!.skills = ["evidence-review"];

    expect(() => validate(value)).toThrow(
      'Non-wait node "finish" must not declare skills',
    );
  });

  it.each(["a".repeat(41), "A".repeat(40)])(
    "rejects invalid handoff template commit pin %s",
    (commitSha) => {
      const value = blueprint();
      value.nodes[0]!["handoff-template"]!.commitSha = commitSha;

      expect(() => validate(value)).toThrow(
        'Agent wait node "prepare" has no valid pinned handoff template',
      );
    },
  );

  it("rejects handoff metadata on a non-wait node", () => {
    const value = blueprint();
    value.nodes[1]!.handoff = "standard";

    expect(() => validate(value)).toThrow(
      'Non-wait node "finish" must not declare handoff metadata',
    );
  });

  it("accepts a declared repository only on a wait node", () => {
    const value = blueprint();
    value.nodes[0]!.repo = "sample-repository";
    expect(() => validate(value)).not.toThrow();

    value.nodes[0]!.repo = "../outside";
    expect(() => validate(value)).toThrow(
      'Node "prepare" has invalid repository metadata',
    );

    delete value.nodes[0]!.repo;
    value.nodes[1]!.repo = "sample-repository";
    expect(() => validate(value)).toThrow(
      'Node "finish" has invalid repository metadata',
    );
  });
});
