// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it, vi } from "vitest";

import {
  ProviderSelectionError,
  type ResolvedProviderSelection,
} from "../control-plane/index.js";
import type { ResolvedProductionSessionConfiguration } from "./configuration.js";
import {
  resolveStageSessionSelection,
  StageSessionSelectionError,
} from "./stage-session-selection.js";

const session = (): ResolvedProductionSessionConfiguration => ({
  baseRef: "main",
  defaultProviderAlias: "default",
  defaultRuntimeMode: "auto",
  defaultSelection: selection("default", "auto"),
  interactionMode: "default",
  resolvedSelections: [selection("default", "auto")],
  skillPointer: "skill://sample",
});

const selection = (
  alias: string,
  runtimeMode: ResolvedProviderSelection["runtimeMode"],
): ResolvedProviderSelection => ({
  alias,
  driverKind: "codex",
  interactionMode: "default",
  model: { isCustom: false, name: "Sample Model", slug: `${alias}-model` },
  observedCliVersion: "sample-version",
  providerDisplayName: `Workbench ${alias}`,
  providerInstanceId: `${alias}-instance`,
  runtimeMode,
});

describe("stage session selection", () => {
  it.each([
    {
      expected: "task",
      label: "task override over stage alias",
      stageProviderAlias: "stage",
      taskProviderAliases: { review: "task" },
    },
    {
      expected: "stage",
      label: "stage alias when task override is absent",
      stageProviderAlias: "stage",
      taskProviderAliases: { implement: "task" },
    },
    {
      expected: "default",
      label: "configured default when both overrides are absent",
      stageProviderAlias: undefined,
      taskProviderAliases: { implement: "task" },
    },
  ])("selects $label", async (testCase) => {
    const resolve = vi.fn(
      async (alias: string, inputs: { runtimeMode: "full-access" }) =>
        selection(alias, inputs.runtimeMode),
    );

    const resolved = await resolveStageSessionSelection(
      {
        session: session(),
        stageId: "review",
        stageProviderAlias: testCase.stageProviderAlias,
        stageRuntimeMode: "full-access",
        taskId: 17,
        taskProviderAliases: testCase.taskProviderAliases,
      },
      { resolve },
    );

    expect(resolved.alias).toBe(testCase.expected);
    expect(resolve).toHaveBeenCalledWith(testCase.expected, {
      interactionMode: "default",
      runtimeMode: "full-access",
    });
  });

  it("uses the configured runtime when the stage does not override it", async () => {
    const resolve = vi.fn(async (alias: string, inputs) =>
      selection(alias, inputs.runtimeMode),
    );

    await resolveStageSessionSelection(
      { session: session(), stageId: "implement", taskId: 17 },
      { resolve },
    );

    expect(resolve).toHaveBeenCalledWith("default", {
      interactionMode: "default",
      runtimeMode: "auto",
    });
  });

  it.each([
    {
      label: "task override",
      stageProviderAlias: "stage",
      taskProviderAliases: { review: "unknown" },
    },
    {
      label: "stage alias",
      stageProviderAlias: "unknown",
      taskProviderAliases: undefined,
    },
  ])(
    "names the task and stage when a present $label is unknown",
    async (testCase) => {
      const resolve = vi.fn(async (alias: string) => {
        throw new ProviderSelectionError(
          "provider-alias-not-allowed",
          `Provider alias '${alias}' cannot be selected: the alias is not configured`,
        );
      });

      const error = await resolveStageSessionSelection(
        {
          session: session(),
          stageId: "review",
          stageProviderAlias: testCase.stageProviderAlias,
          taskId: 17,
          taskProviderAliases: testCase.taskProviderAliases,
        },
        { resolve },
      ).catch((candidate: unknown) => candidate);

      expect(resolve).toHaveBeenCalledOnce();
      expect(resolve).toHaveBeenCalledWith("unknown", expect.any(Object));
      expect(error).toBeInstanceOf(StageSessionSelectionError);
      expect(error).toMatchObject({
        message: expect.stringContaining(
          "Task 17 stage 'review' cannot select a session",
        ),
        reason: "provider-alias-not-allowed",
      });
    },
  );
});
