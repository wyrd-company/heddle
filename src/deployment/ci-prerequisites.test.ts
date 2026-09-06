// ---
// relationships:
//   verifies: heddle
// ---

import { readFile } from "node:fs/promises";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

describe("hosted CI command prerequisites", () => {
  it("installs the pinned Go toolchain and command prerequisites before the repository gate", async () => {
    const workflow = parse(
      await readFile(".github/workflows/ci.yml", "utf8"),
    ) as { jobs: { check: { steps: WorkflowStep[] } } };
    const steps = workflow.jobs.check.steps;
    const go = steps.find((step) => step.name === "Install Go");
    const prerequisitesIndex = steps.findIndex(
      (step) => step.name === "Install command prerequisites",
    );
    const gateIndex = steps.findIndex(
      (step) => step.name === "Run the repository gate",
    );

    expect(go).toEqual({
      name: "Install Go",
      uses: "actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16",
      with: { cache: false, "go-version": "1.25.7" },
    });
    expect(prerequisitesIndex).toBeGreaterThan(-1);
    expect(prerequisitesIndex).toBeLessThan(gateIndex);
    expect(steps[prerequisitesIndex]?.run).toBe(
      'scripts/ci/install-prerequisites.sh "${RUNNER_TEMP}/heddle-tools"\n' +
        'echo "${RUNNER_TEMP}/heddle-tools" >> "${GITHUB_PATH}"\n',
    );
  });

  it("binds both executables to their canonical immutable sources", async () => {
    const installer = await readFile(
      "scripts/ci/install-prerequisites.sh",
      "utf8",
    );
    const supportedVersions = JSON.parse(
      await readFile("deployment/supported-versions.json", "utf8"),
    ) as { kanbanMd: string };

    expect(installer).toContain('kanban_branch="source/0.37.0-fork-b9fc380"');
    expect(installer).toContain(
      'kanban_commit="b9fc380c3f97f41c9aa11077b858c75dad6ec0ee"',
    );
    expect(installer).toContain(
      `kanban_version="${supportedVersions.kanbanMd}"`,
    );
    expect(installer).toContain('gitpr_version="0.4.0"');
    expect(installer).toContain(
      'gitpr_checksum="a92933afd9459074cdffb217cd02f87b29105d4ba45557290fdcd71d340cbd1a"',
    );
    expect(installer).toContain(
      'test "$(git -C "${working_directory}/kanban-md" rev-parse HEAD)" = "${kanban_commit}"',
    );
    expect(installer).toContain(
      'test "$("${destination}/kanban-md" --version)" =',
    );
    expect(installer).toContain(
      'test "$("${destination}/gitpr" --version)" = "gitpr version ${gitpr_version}"',
    );
  });
});
