// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
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
  it("probes an open breaker and resets admission when its attention resolves", async () => {
    const { stateDirectory, store } = await persistence();
    const input = {
      attentionId: "production:unanticipated:task:17",
      code: "unanticipated",
      failureThreshold: 3,
      observedAt: 1_000,
      retryDelayMilliseconds: 100,
    };
    store.raiseAttention(input.attentionId, {
      attentionId: input.attentionId,
      kind: "production-error",
    });

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
    expect(restarted.incidentFailureRetryReady(input.attentionId, 1_299)).toBe(
      false,
    );
    expect(restarted.incidentFailureRetryReady(input.attentionId, 1_300)).toBe(
      true,
    );
    expect(
      restarted.observeIncidentFailure({ ...input, observedAt: 1_300 }),
    ).toEqual({ failureCount: 3, kind: "breaker-open" });
    expect(restarted.incidentFailureRetryReady(input.attentionId, 1_399)).toBe(
      false,
    );
    expect(restarted.incidentFailureRetryReady(input.attentionId, 1_400)).toBe(
      true,
    );

    expect(restarted.resolveAttention(input.attentionId)).toBe(true);
    expect(restarted.reopenAttention(input.attentionId)).toBe(true);
    expect(
      restarted.observeIncidentFailure({ ...input, observedAt: 1_400 }),
    ).toEqual({
      failureCount: 1,
      kind: "retry-scheduled",
      nextAttemptAt: 1_500,
    });
    restarted.close();
  });

  it("converges restart within one occurrence and allocates after terminal state", async () => {
    const { stateDirectory, store } = await persistence();
    const input = {
      attentionId: "production:sample:task:17:first",
      code: "sample-error",
      cooldownMilliseconds: 60_000,
      createdAt: 1_000,
      incidentId: `incident:${"a".repeat(64)}`,
      maximumConcurrent: 3,
      occurrence: 1,
      sourceInstanceId: "task-17",
      taskId: 17,
    };

    expect(store.admitIncident(input).kind).toBe("admitted");
    expect(store.admitIncident(input).kind).toBe("existing");
    store.close();

    const restarted = new SqlitePersistence({ stateDirectory });
    expect(restarted.admitIncident(input).kind).toBe("existing");
    const first = restarted.listIncidentRuntime()[0]!;
    restarted.writeIncidentRuntime({ ...first, state: "done" });
    const recurrence = {
      ...input,
      cooldownMilliseconds: 0,
      createdAt: 2_000,
      incidentId: `incident:${"b".repeat(64)}`,
      occurrence: 2,
    };
    expect(restarted.admitIncident(recurrence)).toMatchObject({
      kind: "admitted",
      runtime: { occurrence: 2 },
    });
    restarted.close();

    const replayed = new SqlitePersistence({ stateDirectory });
    expect(replayed.admitIncident(recurrence).kind).toBe("existing");
    expect(replayed.listIncidentRuntime()).toMatchObject([
      { incidentId: input.incidentId, occurrence: 1, state: "done" },
      { incidentId: recurrence.incidentId, occurrence: 2, state: "starting" },
    ]);
    expect(() =>
      replayed.admitIncident({
        ...recurrence,
        incidentId: `incident:${"c".repeat(64)}`,
        occurrence: 3,
      }),
    ).toThrow("changed durable identity");
    const second = replayed.listIncidentRuntime()[1]!;
    replayed.writeIncidentRuntime({ ...second, state: "done" });
    expect(() =>
      replayed.admitIncident({
        ...recurrence,
        createdAt: 3_000,
        incidentId: `incident:${"d".repeat(64)}`,
        occurrence: 4,
      }),
    ).toThrow("occurrence is not next");
    replayed.close();
  });

  it("migrates one retained incident as occurrence one without changing identity", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "incident-runtime-"));
    directories.push(stateDirectory);
    const databasePath = join(stateDirectory, "heddle-state.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE heddle_incident_runtime (
        incident_id TEXT PRIMARY KEY,
        attention_id TEXT NOT NULL UNIQUE,
        code TEXT NOT NULL,
        task_id INTEGER NOT NULL CHECK (task_id > 0),
        source_instance_id TEXT,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        state TEXT NOT NULL CHECK (state IN ('starting', 'waiting', 'done', 'failed')),
        provider TEXT,
        stage_id TEXT,
        stage_entered_at INTEGER,
        session_key TEXT,
        thread_id TEXT,
        diagnosis_json TEXT,
        accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
        rejection_operation_ids_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX heddle_incident_runtime_code_time
        ON heddle_incident_runtime(code, created_at);
      INSERT INTO heddle_incident_runtime
        (incident_id, attention_id, code, task_id, created_at, state)
      VALUES
        ('incident:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
         'production:sample:task:17', 'sample-error', 17, 1000, 'done');
    `);
    legacy.close();

    const store = new SqlitePersistence({ stateDirectory });
    expect(store.listIncidentRuntime()).toMatchObject([
      {
        attentionId: "production:sample:task:17",
        incidentId: `incident:${"a".repeat(64)}`,
        occurrence: 1,
        state: "done",
      },
    ]);
    expect(
      store.admitIncident({
        attentionId: "production:sample:task:17",
        code: "sample-error",
        cooldownMilliseconds: 0,
        createdAt: 2_000,
        incidentId: `incident:${"b".repeat(64)}`,
        maximumConcurrent: 3,
        occurrence: 2,
        taskId: 17,
      }),
    ).toMatchObject({ kind: "admitted", runtime: { occurrence: 2 } });
    store.close();
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
        occurrence: 1,
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
