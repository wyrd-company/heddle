// ---
// relationships:
//   verifies: heddle
// ---

import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
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
  it("migrates legacy epic projects to durable tombstone storage", async () => {
    const stateDirectory = await makeStateDirectory();
    const databasePath = join(stateDirectory, "heddle-state.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE heddle_epic_projects (
        epic_id INTEGER PRIMARY KEY,
        product_name TEXT NOT NULL,
        project_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('creating', 'active', 'deleting')),
        create_command_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        delete_command_id TEXT NOT NULL UNIQUE
      );
      INSERT INTO heddle_epic_projects VALUES
        (101, 'Sample product', 'sample-project', 'active',
         'sample-create', '2026-01-01T00:00:00.000Z', 'sample-delete');
    `);
    legacy.close();

    const persistence = new SqlitePersistence({ stateDirectory });
    expect(persistence.getEpicProject(101)).toMatchObject({
      epicId: 101,
      projectId: "sample-project",
      state: "active",
    });
    const migrated = new Database(databasePath, { readonly: true });
    expect(
      (
        migrated
          .prepare("PRAGMA table_info(heddle_epic_projects)")
          .all() as Array<{ name: string }>
      ).map(({ name }) => name),
    ).toContain("deleted");
    migrated.close();
    persistence.close();
  });

  it("keeps legacy notification failures unverifiable until details are reconstructed", async () => {
    const stateDirectory = await makeStateDirectory();
    const databasePath = join(stateDirectory, "heddle-state.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE heddle_notification_failures (
        stable_id TEXT PRIMARY KEY,
        occurrence INTEGER NOT NULL CHECK (occurrence > 0),
        category TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('rejected', 'retry-authorized')),
        recorded_at TEXT NOT NULL
      );
      INSERT INTO heddle_notification_failures VALUES
        ('sample-notification', 1, 'request-rejected', 'rejected',
         '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const persistence = new SqlitePersistence({ stateDirectory });
    expect(persistence.notificationFailure("sample-notification")).toEqual({
      category: "request-rejected",
      message: null,
      occurrence: 1,
      recipientLabel: null,
      stableId: "sample-notification",
      state: "rejected",
    });
    const migrated = new Database(databasePath, { readonly: true });
    expect(
      (
        migrated
          .prepare("PRAGMA table_info(heddle_notification_failures)")
          .all() as Array<{ name: string }>
      ).map(({ name }) => name),
    ).toEqual(expect.arrayContaining(["recipient_label", "message"]));
    migrated.close();
    persistence.close();
  });

  it("keeps the first verification snapshot for one rejected occurrence", async () => {
    const stateDirectory = await makeStateDirectory();
    const persistence = new SqlitePersistence({ stateDirectory });

    persistence.recordNotificationFailure(
      "sample-notification",
      "request-rejected",
      {
        message: "A sample needs attention",
        recipientLabel: "First recipient",
      },
    );
    const repeated = persistence.recordNotificationFailure(
      "sample-notification",
      "recipient-rejected",
      {
        message: "A different sample",
        recipientLabel: "Second recipient",
      },
    );

    expect(repeated).toMatchObject({
      category: "recipient-rejected",
      message: "A sample needs attention",
      occurrence: 1,
      recipientLabel: "First recipient",
      state: "rejected",
    });
    persistence.close();
  });

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

  it("serializes one correlation token across two synchronized worker claims and reload", async () => {
    const stateDirectory = await makeStateDirectory();
    const setup = new SqlitePersistence({ stateDirectory });
    const emptyTokens = { ...initialState, correlationTokens: {} };
    setup.createInstance("record-a", emptyTokens);
    setup.createInstance("record-b", emptyTokens);
    setup.close();
    const moduleUrl = pathToFileURL(
      join(process.cwd(), "src/persistence/sqlite-persistence.ts"),
    ).href;
    const workerScript = `
      import { SqlitePersistence } from ${JSON.stringify(moduleUrl)};
      const [stateDirectory, instanceId] = process.argv.slice(1);
      const persistence = new SqlitePersistence({ stateDirectory });
      const current = persistence.getInstance(instanceId);
      process.stdout.write("ready\\n");
      for await (const chunk of process.stdin) {
        if (!chunk.toString().includes("go")) continue;
        try {
          const claimed = persistence.compareAndSwapInstance(
            instanceId,
            current.version,
            {
              ...current.state,
              correlationTokens: {
                ...current.state.correlationTokens,
                child: "shared-token",
              },
            },
          );
          process.stdout.write(JSON.stringify({ claimed: claimed !== undefined }) + "\\n");
        } catch (error) {
          process.stdout.write(JSON.stringify({ claimed: false, error: error.code ?? error.name }) + "\\n");
        }
        persistence.close();
        break;
      }
    `;
    const startWorker = (instanceId: string) =>
      spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          workerScript,
          stateDirectory,
          instanceId,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
    const workers: Array<ReturnType<typeof startWorker>> = [];
    const exits: Array<ReturnType<typeof once>> = [];
    const outputs: AsyncIterableIterator<string>[] = [];
    for (const instanceId of ["record-a", "record-b"]) {
      const worker = startWorker(instanceId);
      const output = createInterface({
        input: worker.stdout!,
      })[Symbol.asyncIterator]();
      workers.push(worker);
      exits.push(once(worker, "exit"));
      outputs.push(output);
      await expect(output.next()).resolves.toMatchObject({
        done: false,
        value: "ready",
      });
    }
    for (const worker of workers) worker.stdin!.end("go\n");
    const parsed = await Promise.all(
      outputs.map(async (output) => {
        const line = await output.next();
        return JSON.parse(line.value) as {
          claimed: boolean;
          error?: string;
        };
      }),
    );
    await Promise.all(exits);

    expect(parsed.filter(({ claimed }) => claimed)).toHaveLength(1);
    expect(
      parsed.filter(({ error }) => error?.includes("CONSTRAINT")),
    ).toHaveLength(1);
    const staleProjection = new Database(
      join(stateDirectory, "heddle-state.sqlite"),
    );
    staleProjection.prepare("DELETE FROM heddle_correlation_tokens").run();
    staleProjection.close();
    const reloaded = new SqlitePersistence({ stateDirectory });
    const records = reloaded.listInstances();
    expect(
      records.filter(
        ({ state }) => state.correlationTokens.child === "shared-token",
      ),
    ).toHaveLength(1);
    expect(records.map(({ version }) => version).sort()).toEqual([1, 2]);
    const loser = records.find(
      ({ state }) => state.correlationTokens.child === undefined,
    )!;
    expect(() =>
      reloaded.updateInstance(loser.instanceId, {
        ...loser.state,
        correlationTokens: {
          ...loser.state.correlationTokens,
          child: "shared-token",
        },
      }),
    ).toThrow(/UNIQUE constraint failed|SQLITE_CONSTRAINT/);
    reloaded.close();
  }, 15_000);

  it("fails recovery closed when event history contains duplicate correlation tokens", async () => {
    const stateDirectory = await makeStateDirectory();
    const persistence = new SqlitePersistence({ stateDirectory });
    persistence.createInstance("record-a", {
      ...initialState,
      correlationTokens: { primary: "token-a" },
    });
    persistence.createInstance("record-b", {
      ...initialState,
      correlationTokens: { primary: "token-b" },
    });
    persistence.close();
    const database = new Database(join(stateDirectory, "heddle-state.sqlite"));
    database
      .prepare(
        `INSERT INTO heddle_instance_events
          (instance_id, type, payload_json, recorded_at)
         VALUES (?, 'instance:updated', ?, ?)`,
      )
      .run(
        "record-b",
        JSON.stringify({
          ...initialState,
          correlationTokens: { primary: "token-a" },
        }),
        new Date(0).toISOString(),
      );
    database.close();

    expect(() => new SqlitePersistence({ stateDirectory })).toThrow(
      /UNIQUE constraint failed|SQLITE_CONSTRAINT/,
    );
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
