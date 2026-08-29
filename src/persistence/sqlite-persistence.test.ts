// ---
// relationships:
//   verifies: heddle
// ---

import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { SqlitePersistence } from "./sqlite-persistence.js";
import type { InstanceState } from "./types.js";

const temporaryDirectories: string[] = [];

const makeStateDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "sqlite-persistence-"));
  temporaryDirectories.push(directory);
  return directory;
};

const initialState: InstanceState = {
  correlationTokens: { primary: "token-a" },
  flowcraftContext: { active: "step-a", values: [1] },
  handoffs: [{ text: "first" }],
  todoState: [{ complete: false, text: "item-a" }],
};

const adversarialFlowcraftIndex = "idx_events_execution_timestamp_id_desc";
const equalTimestamp = "2026-01-01 00:00:00";

const addAdversarialFlowcraftIndex = (database: Database.Database): void => {
  database.exec(`
    CREATE INDEX ${adversarialFlowcraftIndex}
    ON events(execution_id, timestamp, id DESC)
  `);
};

const insertFlowcraftEvent = (
  database: Database.Database,
  executionId: string,
  value: number,
): void => {
  database
    .prepare(
      `INSERT INTO events
         (execution_id, event_type, event_payload, timestamp, created_at)
       VALUES (?, 'sample:observed', ?, ?, ?)`,
    )
    .run(
      executionId,
      JSON.stringify({ value }),
      equalTimestamp,
      equalTimestamp,
    );
};

const payloadValues = (
  events: Awaited<ReturnType<SqlitePersistence["flowcraftHistory"]["replay"]>>,
): number[] =>
  events.map(({ payload }) => (payload as { value: number }).value);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SqlitePersistence", () => {
  it("creates, reads, updates, lists, and deletes instances", async () => {
    const stateDirectory = await makeStateDirectory();
    const persistence = new SqlitePersistence({ stateDirectory });

    expect(persistence.createInstance("record-a", initialState)).toEqual({
      instanceId: "record-a",
      state: initialState,
      version: 1,
    });

    const nextState: InstanceState = {
      ...initialState,
      todoState: [{ complete: true, text: "item-a" }],
    };
    expect(persistence.updateInstance("record-a", nextState)).toEqual({
      instanceId: "record-a",
      state: nextState,
      version: 2,
    });
    expect(persistence.getInstance("record-a")?.state).toEqual(nextState);
    expect(
      persistence.listInstances().map(({ instanceId }) => instanceId),
    ).toEqual(["record-a"]);

    persistence.deleteInstance("record-a");
    expect(persistence.getInstance("record-a")).toBeUndefined();
    persistence.close();
  });

  it("places its database in the configured state directory", async () => {
    const stateDirectory = await makeStateDirectory();
    const persistence = new SqlitePersistence({ stateDirectory });
    persistence.close();

    expect(
      await readFile(join(stateDirectory, "heddle-state.sqlite")),
    ).not.toHaveLength(0);
    expect(() => new SqlitePersistence({ stateDirectory: " " })).toThrow(
      /stateDirectory/,
    );
  });

  it("rejects invalid instance writes", async () => {
    const persistence = new SqlitePersistence({
      stateDirectory: await makeStateDirectory(),
    });
    persistence.createInstance("record-a", initialState);

    expect(() => persistence.createInstance(" ", initialState)).toThrow(
      /instanceId/,
    );
    expect(() => persistence.createInstance("record-a", initialState)).toThrow(
      /already exists/,
    );
    expect(() => persistence.updateInstance("missing", initialState)).toThrow(
      /does not exist/,
    );
    expect(() => persistence.deleteInstance("missing")).toThrow(
      /does not exist/,
    );
    expect(persistence.replayEvents("record-a")).toHaveLength(1);
    persistence.close();
  });

  it("claims an instance update only at the expected version", async () => {
    const persistence = new SqlitePersistence({
      stateDirectory: await makeStateDirectory(),
    });
    persistence.createInstance("record-a", initialState);
    const winnerState: InstanceState = {
      ...initialState,
      todoState: [{ complete: true, text: "item-a" }],
    };
    const loserState: InstanceState = {
      ...initialState,
      todoState: [{ complete: false, text: "item-b" }],
    };

    expect(
      persistence.compareAndSwapInstance("record-a", 1, winnerState),
    ).toMatchObject({ state: winnerState, version: 2 });
    expect(
      persistence.compareAndSwapInstance("record-a", 1, loserState),
    ).toBeUndefined();
    expect(persistence.getInstance("record-a")).toMatchObject({
      state: winnerState,
      version: 2,
    });
    expect(
      persistence
        .replayEvents("record-a")
        .filter(({ type }) => type === "instance:updated"),
    ).toHaveLength(1);
    persistence.close();
  });

  it("claims an instance update and external event at one version", async () => {
    const persistence = new SqlitePersistence({
      stateDirectory: await makeStateDirectory(),
    });
    persistence.createInstance("record-a", initialState);
    const winnerState: InstanceState = {
      ...initialState,
      todoState: [{ complete: true, text: "item-a" }],
    };

    expect(
      persistence.compareAndSwapInstanceWithEvent(
        "record-a",
        1,
        winnerState,
        "sample:claimed",
        { value: "winner" },
      ),
    ).toMatchObject({
      event: { payload: { value: "winner" }, type: "sample:claimed" },
      record: { state: winnerState, version: 2 },
    });
    expect(
      persistence.compareAndSwapInstanceWithEvent(
        "record-a",
        1,
        initialState,
        "sample:claimed",
        { value: "loser" },
      ),
    ).toBeUndefined();
    expect(
      persistence
        .replayEvents("record-a")
        .filter(({ type }) => type === "sample:claimed")
        .map(({ payload }) => payload),
    ).toEqual([{ value: "winner" }]);
    persistence.close();
  });

  it("rejects invalid external events without changing history", async () => {
    const persistence = new SqlitePersistence({
      stateDirectory: await makeStateDirectory(),
    });
    persistence.createInstance("record-a", initialState);

    expect(() =>
      persistence.appendEvent("missing", "sample:observed", null),
    ).toThrow(/does not exist/);
    expect(() => persistence.appendEvent("record-a", " ", null)).toThrow(
      /must not be empty/,
    );
    expect(() =>
      persistence.appendEvent("record-a", "instance:updated", initialState),
    ).toThrow(/reserved/);
    expect(persistence.replayEvents("record-a")).toHaveLength(1);
    persistence.close();
  });

  it("appends and replays events in insertion order", async () => {
    const persistence = new SqlitePersistence({
      stateDirectory: await makeStateDirectory(),
    });
    persistence.createInstance("record-a", initialState);

    const first = persistence.appendEvent("record-a", "sample:observed", {
      value: 1,
    });
    const second = persistence.appendEvent("record-a", "sample:observed", {
      value: 2,
    });

    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(
      persistence
        .replayEvents("record-a")
        .filter(({ type }) => type === "sample:observed")
        .map(({ payload }) => payload),
    ).toEqual([{ value: 1 }, { value: 2 }]);
    persistence.close();
  });

  it("enforces append-only history in SQLite", async () => {
    const stateDirectory = await makeStateDirectory();
    const persistence = new SqlitePersistence({ stateDirectory });
    persistence.createInstance("record-a", initialState);
    persistence.close();

    const database = new Database(join(stateDirectory, "heddle-state.sqlite"));
    expect(() =>
      database.exec("UPDATE heddle_instance_events SET type = 'changed'"),
    ).toThrow(/append-only/);
    expect(() => database.exec("DELETE FROM heddle_instance_events")).toThrow(
      /append-only/,
    );
    database.close();
  });

  it("reconstructs identical state after the writer process is killed", async () => {
    const stateDirectory = await makeStateDirectory();
    const moduleUrl = pathToFileURL(
      join(process.cwd(), "src/persistence/sqlite-persistence.ts"),
    ).href;
    const expectedState: InstanceState = {
      ...initialState,
      flowcraftContext: { active: "step-b", values: [1, 2] },
      handoffs: [...initialState.handoffs, { text: "second" }],
    };
    const childScript = `
      import { SqlitePersistence } from ${JSON.stringify(moduleUrl)};
      const persistence = new SqlitePersistence({ stateDirectory: process.argv[1] });
      persistence.createInstance("record-a", ${JSON.stringify(initialState)});
      persistence.updateInstance("record-a", ${JSON.stringify(expectedState)});
      process.stdout.write("ready\\n");
      setInterval(() => {}, 1_000);
    `;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        childScript,
        stateDirectory,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    await once(child.stdout!, "data");
    child.kill("SIGKILL");
    await once(child, "exit");

    const interruptedProjection = new Database(
      join(stateDirectory, "heddle-state.sqlite"),
    );
    interruptedProjection.exec("DELETE FROM heddle_instances");
    interruptedProjection.close();

    const recovered = new SqlitePersistence({ stateDirectory });
    expect(recovered.getInstance("record-a")).toEqual({
      instanceId: "record-a",
      state: expectedState,
      version: 2,
    });
    expect(recovered.recoverInstances()).toEqual([
      { instanceId: "record-a", state: expectedState, version: 2 },
    ]);
    recovered.close();
  });

  it("does not resurrect a deleted instance during replay", async () => {
    const stateDirectory = await makeStateDirectory();
    const writer = new SqlitePersistence({ stateDirectory });
    writer.createInstance("record-a", initialState);
    writer.deleteInstance("record-a");
    writer.close();

    const recovered = new SqlitePersistence({ stateDirectory });
    expect(recovered.getInstance("record-a")).toBeUndefined();
    expect(recovered.replayEvents("record-a")).toHaveLength(2);
    recovered.close();
  });

  it("provides append-only Flowcraft history on the configured database", async () => {
    const stateDirectory = await makeStateDirectory();
    const persistence = new SqlitePersistence({ stateDirectory });

    expect(Object.isFrozen(persistence.flowcraftHistory)).toBe(true);
    expect("clear" in persistence.flowcraftHistory).toBe(false);

    await persistence.flowcraftHistory.append(
      {
        type: "workflow:start",
        payload: { blueprintId: "sample", executionId: "execution-a" },
      },
      "execution-a",
    );

    expect(await persistence.flowcraftHistory.replay("execution-a")).toEqual([
      {
        type: "workflow:start",
        payload: { blueprintId: "sample", executionId: "execution-a" },
      },
    ]);
    persistence.close();

    const database = new Database(join(stateDirectory, "heddle-state.sqlite"));
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM events").get(),
    ).toEqual({ count: 1 });
    expect(() =>
      database.exec("UPDATE events SET event_type = 'changed'"),
    ).toThrow(/append-only/);
    expect(() => database.exec("DELETE FROM events")).toThrow(/append-only/);
    database.close();
  });

  it("replays equal-timestamp Flowcraft events in durable append order", async () => {
    const stateDirectory = await makeStateDirectory();
    const persistence = new SqlitePersistence({ stateDirectory });
    const database = new Database(persistence.databasePath);
    addAdversarialFlowcraftIndex(database);
    insertFlowcraftEvent(database, "group-a", 1);
    insertFlowcraftEvent(database, "group-a", 2);

    const legacyQuery = `
      SELECT event_type, event_payload
      FROM events
      WHERE execution_id = ?
      ORDER BY timestamp ASC
    `;
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${legacyQuery}`)
      .all("group-a") as Array<{ detail: string }>;
    expect(plan.map(({ detail }) => detail).join(" ")).toContain(
      adversarialFlowcraftIndex,
    );
    const incidentalOrder = database
      .prepare(legacyQuery)
      .all("group-a") as Array<{
      event_payload: string;
    }>;
    expect(
      incidentalOrder.map(
        ({ event_payload }) =>
          (JSON.parse(event_payload) as { value: number }).value,
      ),
    ).toEqual([2, 1]);

    expect(
      payloadValues(await persistence.flowcraftHistory.replay("group-a")),
    ).toEqual([1, 2]);
    database.close();
    persistence.close();
  });

  it("replays multiple equal-timestamp Flowcraft executions in durable append order", async () => {
    const stateDirectory = await makeStateDirectory();
    const persistence = new SqlitePersistence({ stateDirectory });
    const database = new Database(persistence.databasePath);
    addAdversarialFlowcraftIndex(database);
    insertFlowcraftEvent(database, "group-b", 1);
    insertFlowcraftEvent(database, "group-a", 1);
    insertFlowcraftEvent(database, "group-b", 2);
    insertFlowcraftEvent(database, "group-a", 2);

    const legacyQuery = `
      SELECT execution_id, event_type, event_payload
      FROM events
      WHERE execution_id IN (?, ?)
      ORDER BY execution_id, timestamp ASC
    `;
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${legacyQuery}`)
      .all("group-a", "group-b") as Array<{ detail: string }>;
    expect(plan.map(({ detail }) => detail).join(" ")).toContain(
      adversarialFlowcraftIndex,
    );
    const incidentalOrder = database
      .prepare(legacyQuery)
      .all("group-a", "group-b") as Array<{
      event_payload: string;
      execution_id: string;
    }>;
    expect(
      incidentalOrder.map(({ event_payload, execution_id }) => [
        execution_id,
        (JSON.parse(event_payload) as { value: number }).value,
      ]),
    ).toEqual([
      ["group-a", 2],
      ["group-a", 1],
      ["group-b", 2],
      ["group-b", 1],
    ]);

    const replayed = await persistence.flowcraftHistory.replayMultiple([
      "group-a",
      "group-b",
    ]);
    expect(payloadValues(replayed.get("group-a") ?? [])).toEqual([1, 2]);
    expect(payloadValues(replayed.get("group-b") ?? [])).toEqual([1, 2]);
    database.close();
    persistence.close();
  });
});
