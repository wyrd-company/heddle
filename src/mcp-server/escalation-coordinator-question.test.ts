// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SqlitePersistence } from "../persistence/index.js";
import { EscalationCoordinator } from "./escalation-coordinator.js";
import { EscalationHistory } from "./escalation-history.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const harness = async (adjudication: boolean) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "heddle-question-"));
  directories.push(stateDirectory);
  const persistence = new SqlitePersistence({ stateDirectory });
  const instance = persistence.createInstance("instance-q", {
    correlationTokens: {},
    flowcraftContext: {
      awaitingNodeIds: ["confirm"],
      blueprintBlobHash: "a".repeat(40),
      blueprintPath: "blueprints/sample.json",
      completedOperations: {},
    },
    handoffs: [],
    todoState: null,
  });
  const raise = vi.fn(async () => undefined);
  const start = vi.fn(async () => ({ modelSlug: "sample-model" }));
  const coordinator = new EscalationCoordinator({
    ...(adjudication
      ? { adjudication: { start, stop: vi.fn(async () => undefined) } }
      : {}),
    attention: { raise },
    decisionLog: { record: vi.fn(async () => undefined) },
    delivery: { deliver: vi.fn(async () => undefined) },
    persistence,
    pushover: { send: vi.fn(async () => undefined) },
    session: { steer: vi.fn(async () => undefined) },
  });
  const ask = (role: "adjudication" | "operator") =>
    coordinator.escalate(
      {
        instance,
        sessionKey: "question:confirm:1",
        stage: { id: "confirm", skills: [], tools: [] },
      },
      {
        escalationId: "question:confirm:1",
        questions: [
          {
            id: "serve",
            multiSelect: false,
            options: [{ label: "yes" }, { label: "no" }],
            question: "Serve?",
          },
        ],
        requestId: "instance-q:question:confirm:1",
        threadId: "lifecycle:instance-q",
      },
      { answeringAuthority: role, question: { nodeId: "confirm", visit: 1 } },
    );
  const opened = () =>
    new EscalationHistory(persistence).find(
      "instance-q",
      "question:confirm:1",
      "question:confirm:1",
    ).opened;
  return { ask, opened, persistence, raise, start };
};

describe("lifecycle question escalations", () => {
  it("asks the operator even when adjudication is available", async () => {
    const { ask, opened, persistence, raise, start } = await harness(true);
    await ask("operator");
    await vi.waitFor(() => expect(raise).toHaveBeenCalledTimes(1));
    expect(opened()).toMatchObject({
      answeringAuthority: { kind: "operator" },
      question: { nodeId: "confirm", visit: 1 },
    });
    expect(start).not.toHaveBeenCalled();
    persistence.close();
  });

  it("asks the adjudicator when adjudication is available", async () => {
    const { ask, opened, persistence, start } = await harness(true);
    await ask("adjudication");
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(opened()).toMatchObject({
      answeringAuthority: { kind: "adjudication" },
      question: { nodeId: "confirm", visit: 1 },
    });
    persistence.close();
  });

  it("falls back to the operator when no adjudicator is composed", async () => {
    const { ask, opened, persistence, raise } = await harness(false);
    await ask("adjudication");
    await vi.waitFor(() => expect(raise).toHaveBeenCalledTimes(1));
    expect(opened()).toMatchObject({
      answeringAuthority: { kind: "operator" },
      question: { nodeId: "confirm", visit: 1 },
    });
    persistence.close();
  });

  it("surfaces a failed attention raise to the activation that asked", async () => {
    const { ask, raise } = await harness(false);
    raise.mockRejectedValueOnce(new Error("attention store unavailable"));
    await expect(ask("operator")).rejects.toThrow(
      "attention store unavailable",
    );
  });

  it("reads the occurrence back from the persisted event", async () => {
    const { ask, persistence } = await harness(false);
    await ask("operator");
    expect(new EscalationHistory(persistence).pending("instance-q")).toEqual([
      expect.objectContaining({ question: { nodeId: "confirm", visit: 1 } }),
    ]);
    persistence.close();
  });
});
