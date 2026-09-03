// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SqlitePersistence,
  type InstanceRecord,
  type InstanceState,
} from "../persistence/index.js";
import { ensureCorrelationToken } from "./correlation-token.js";

const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

const initialState = (): InstanceState => ({
  correlationTokens: {},
  flowcraftContext: null,
  handoffs: [],
  todoState: null,
});

describe("ensureCorrelationToken", () => {
  it("mints once and stores the token on the instance", () => {
    let record: InstanceRecord = {
      instanceId: "instance-1",
      state: initialState(),
      version: 1,
    };
    const store = {
      getInstance: vi.fn(() => record),
      compareAndSwapInstance: vi.fn(
        (
          _instanceId: string,
          expectedVersion: number,
          state: InstanceState,
        ) => {
          if (expectedVersion !== record.version) return undefined;
          record = { ...record, state, version: record.version + 1 };
          return record;
        },
      ),
    };
    const mint = vi.fn(() => "token-1");

    expect(
      ensureCorrelationToken(store, "instance-1", "session-1", mint),
    ).toMatchObject({ token: "token-1" });
    expect(
      ensureCorrelationToken(store, "instance-1", "session-1", mint),
    ).toMatchObject({ token: "token-1" });
    expect(record.state.correlationTokens).toEqual({ "session-1": "token-1" });
    expect(mint).toHaveBeenCalledOnce();
  });

  it("recovers the minted token from SQLite", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "heddle-token-"));
    scratchDirectories.push(stateDirectory);
    let persistence = new SqlitePersistence({ stateDirectory });
    persistence.createInstance("instance-1", initialState());

    ensureCorrelationToken(
      persistence,
      "instance-1",
      "session-1",
      () => "token-1",
    );
    persistence.close();
    persistence = new SqlitePersistence({ stateDirectory });

    expect(
      persistence.getInstance("instance-1")?.state.correlationTokens,
    ).toEqual({ "session-1": "token-1" });
    persistence.close();
  });

  it("reuses one candidate across a compare-and-swap retry", () => {
    let record: InstanceRecord = {
      instanceId: "instance-1",
      state: initialState(),
      version: 1,
    };
    let losesFirstClaim = true;
    const store = {
      getInstance: () => record,
      compareAndSwapInstance: (
        _instanceId: string,
        _expectedVersion: number,
        state: InstanceState,
      ) => {
        if (losesFirstClaim) {
          losesFirstClaim = false;
          record = {
            ...record,
            state: { ...record.state, todoState: ["preserved"] },
            version: record.version + 1,
          };
          return undefined;
        }
        record = { ...record, state, version: record.version + 1 };
        return record;
      },
    };
    const mint = vi.fn(() => "token-1");

    expect(
      ensureCorrelationToken(store, "instance-1", "session-1", mint),
    ).toMatchObject({ token: "token-1" });
    expect(record.state).toMatchObject({
      correlationTokens: { "session-1": "token-1" },
      todoState: ["preserved"],
    });
    expect(mint).toHaveBeenCalledOnce();
  });

  it("rejects empty session keys and minted tokens", () => {
    const record: InstanceRecord = {
      instanceId: "instance-1",
      state: initialState(),
      version: 1,
    };
    const store = {
      getInstance: () => record,
      compareAndSwapInstance: () => record,
    };

    expect(() => ensureCorrelationToken(store, "instance-1", " ")).toThrow(
      /sessionKey/,
    );
    expect(() =>
      ensureCorrelationToken(store, "instance-1", "session-1", () => " "),
    ).toThrow(/token/);
  });

  it("rejects a registration-incompatible token already stored on the instance", () => {
    const record: InstanceRecord = {
      instanceId: "instance-1",
      state: {
        ...initialState(),
        correlationTokens: { "session-1": " " },
      },
      version: 1,
    };

    expect(() =>
      ensureCorrelationToken(
        {
          getInstance: () => record,
          compareAndSwapInstance: () => record,
        },
        "instance-1",
        "session-1",
      ),
    ).toThrow(/invalid correlation token/);
  });

  it.each(["two words", "x".repeat(8193)])(
    "rejects a minted registration-incompatible token",
    (token) => {
      const record: InstanceRecord = {
        instanceId: "instance-1",
        state: initialState(),
        version: 1,
      };

      expect(() =>
        ensureCorrelationToken(
          {
            getInstance: () => record,
            compareAndSwapInstance: () => record,
          },
          "instance-1",
          "session-1",
          () => token,
        ),
      ).toThrow(/1 to 8192 non-whitespace characters/);
    },
  );
});
