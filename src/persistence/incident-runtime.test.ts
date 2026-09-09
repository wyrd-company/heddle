// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqlitePersistence } from "./sqlite-persistence.js";

const directories: string[] = [];

const persistence = async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "incident-runtime-"));
  directories.push(stateDirectory);
  return { stateDirectory, store: new SqlitePersistence({ stateDirectory }) };
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("incident runtime persistence", () => {
  it("persists retry attempts and opens the breaker only at the failure threshold", async () => {
    const { stateDirectory, store } = await persistence();
    const input = {
      attentionId: "production:unanticipated:task:17",
      code: "unanticipated",
      failureThreshold: 3,
      observedAt: 1_000,
      retryDelayMilliseconds: 100,
    };

    expect(store.observeIncidentFailure(input)).toEqual({
      failureCount: 1,
      kind: "retry-scheduled",
      nextAttemptAt: 1_100,
    });
    expect(store.incidentFailureRetryReady(input.attentionId, 1_099)).toBe(
      false,
    );
    expect(store.incidentFailureRetryReady(input.attentionId, 1_100)).toBe(
      true,
    );
    expect(
      store.observeIncidentFailure({ ...input, observedAt: 1_050 }),
    ).toEqual({
      failureCount: 1,
      kind: "retry-waiting",
      nextAttemptAt: 1_100,
    });
    store.close();

    const restarted = new SqlitePersistence({ stateDirectory });
    expect(
      restarted.observeIncidentFailure({ ...input, observedAt: 1_100 }),
    ).toMatchObject({ failureCount: 2, kind: "retry-scheduled" });
    expect(
      restarted.observeIncidentFailure({ ...input, observedAt: 1_200 }),
    ).toEqual({ failureCount: 3, kind: "breaker-open" });
    expect(restarted.incidentFailureRetryReady(input.attentionId, 1_300)).toBe(
      false,
    );
    restarted.close();
  });

  it("converges repeated admission and restart on one incident identity", async () => {
    const { stateDirectory, store } = await persistence();
    const input = {
      attentionId: "production:sample:task:17:first",
      code: "sample-error",
      cooldownMilliseconds: 60_000,
      createdAt: 1_000,
      incidentId: `incident:${"a".repeat(64)}`,
      maximumConcurrent: 3,
      sourceInstanceId: "task-17",
      taskId: 17,
    };

    expect(store.admitIncident(input).kind).toBe("admitted");
    expect(store.admitIncident(input).kind).toBe("existing");
    store.close();

    const restarted = new SqlitePersistence({ stateDirectory });
    expect(restarted.admitIncident(input).kind).toBe("existing");
    expect(restarted.listIncidentRuntime()).toHaveLength(1);
    restarted.close();
  });

  it("bounds varying incident identities by code cooldown and concurrency", async () => {
    const { store } = await persistence();
    const admit = (input: {
      attentionId: string;
      code: string;
      createdAt: number;
      incidentId: string;
    }) =>
      store.admitIncident({
        ...input,
        cooldownMilliseconds: 100,
        maximumConcurrent: 2,
        taskId: 17,
      });

    expect(
      admit({
        attentionId: "production:left:task:17:first",
        code: "left",
        createdAt: 1_000,
        incidentId: `incident:${"a".repeat(64)}`,
      }).kind,
    ).toBe("admitted");
    expect(
      admit({
        attentionId: "production:left:task:17:second",
        code: "left",
        createdAt: 1_001,
        incidentId: `incident:${"b".repeat(64)}`,
      }),
    ).toEqual({ kind: "suppressed", reason: "per-code-cooldown" });
    expect(
      admit({
        attentionId: "production:right:task:17:first",
        code: "right",
        createdAt: 1_001,
        incidentId: `incident:${"c".repeat(64)}`,
      }).kind,
    ).toBe("admitted");
    expect(
      admit({
        attentionId: "production:third:task:17:first",
        code: "third",
        createdAt: 1_002,
        incidentId: `incident:${"d".repeat(64)}`,
      }),
    ).toEqual({ kind: "suppressed", reason: "concurrency-cap" });
    expect(store.listIncidentRuntime()).toHaveLength(2);
    store.close();
  });

  it("retains a resolved attention with its incident justification", async () => {
    const { store } = await persistence();
    const attentionId = "production:sample:task:17";
    const incidentId = `incident:${"a".repeat(64)}`;
    store.raiseAttention(attentionId, {
      attentionId,
      kind: "production-error",
    });

    expect(store.resolveAttention(attentionId, incidentId)).toBe(true);
    expect(store.listAttention()).toEqual([]);
    expect(store.getAttention(attentionId)).toMatchObject({
      attentionId,
      resolutionJustification: incidentId,
      resolvedAt: expect.any(String),
    });
    store.close();
  });
});
