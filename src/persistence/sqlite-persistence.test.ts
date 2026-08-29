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

  it("provides the Flowcraft SQLite history adapter on the configured database", async () => {
    const persistence = new SqlitePersistence({
      stateDirectory: await makeStateDirectory(),
    });

    await persistence.flowcraftHistory.store(
      {
        type: "workflow:start",
        payload: { blueprintId: "sample", executionId: "execution-a" },
      },
      "execution-a",
    );

    expect(await persistence.flowcraftHistory.retrieve("execution-a")).toEqual([
      {
        type: "workflow:start",
        payload: { blueprintId: "sample", executionId: "execution-a" },
      },
    ]);
    persistence.close();
  });
});
