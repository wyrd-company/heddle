// ---
// relationships:
//   verifies: heddle
// ---

import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BlueprintEditConflictError,
  BlueprintValidationError,
  type BlueprintArtifactRevision,
  type SaveBlueprintArtifactInput,
} from "../engine/index.js";
import type { ConsoleBlueprintEditor } from "./blueprint-editor.js";
import { createConsoleServer } from "./server.js";
import type { ConsoleBoard, ConsoleStateSource } from "./types.js";

const revision = (blobHash = "a".repeat(40)): BlueprintArtifactRevision => ({
  blobHash,
  blueprint: {
    id: "sample-process",
    nodes: [{ id: "inspect", uses: "wait" }],
    edges: [],
  },
  path: "blueprints/sample-process.json",
  positions: { inspect: { x: 40, y: 80 } },
});

class FixtureEditor implements ConsoleBlueprintEditor {
  readonly saves: SaveBlueprintArtifactInput[] = [];
  saveError?: Error;

  async load(artifactId: string): Promise<BlueprintArtifactRevision> {
    if (artifactId !== "sample-process") {
      throw new BlueprintValidationError("Blueprint artifact ID is invalid");
    }
    return revision();
  }

  async save(
    input: SaveBlueprintArtifactInput,
  ): Promise<BlueprintArtifactRevision> {
    this.saves.push(input);
    if (this.saveError !== undefined) throw this.saveError;
    return revision("b".repeat(40));
  }
}

const board: ConsoleBoard = {
  readBoard: async () => [],
  readBoardStatuses: async () => [],
  setEpicInProgress: async () => undefined,
};

const state: ConsoleStateSource = {
  listAttention: async () => [],
  listEvents: async () => [],
  listInstances: async () => [],
  readLifecycle: async () => {
    throw new Error("not used");
  },
};

describe("console blueprint editor API", () => {
  let baseUrl: string;
  let editor: FixtureEditor;
  let server: ReturnType<typeof createConsoleServer>;

  beforeEach(async () => {
    editor = new FixtureEditor();
    server = createConsoleServer({ blueprintEditor: editor, board, state });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  });

  it("loads and saves the repository artifact through one editor port", async () => {
    const loaded = await globalThis.fetch(
      `${baseUrl}/api/blueprints/sample-process`,
    );
    const saved = await globalThis.fetch(
      `${baseUrl}/api/blueprints/sample-process`,
      {
        body: JSON.stringify({
          edges: [],
          expectedBlobHash: "a".repeat(40),
          nodes: [{ id: "inspect", uses: "wait" }],
          positions: { inspect: { x: 120, y: 60 } },
        }),
        headers: { "content-type": "application/json; charset=utf-8" },
        method: "PUT",
      },
    );

    await expect(loaded.json()).resolves.toEqual(revision());
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toEqual(revision("b".repeat(40)));
    expect(editor.saves).toEqual([
      {
        artifactId: "sample-process",
        edges: [],
        expectedBlobHash: "a".repeat(40),
        nodes: [{ id: "inspect", uses: "wait" }],
        positions: { inspect: { x: 120, y: 60 } },
      },
    ]);
  });

  it("rejects malformed writes before the editor port and names allowed methods", async () => {
    const [malformed, wrongMethod] = await Promise.all([
      globalThis.fetch(`${baseUrl}/api/blueprints/sample-process`, {
        body: JSON.stringify({ nodes: [], edges: [] }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      }),
      globalThis.fetch(`${baseUrl}/api/blueprints/sample-process`, {
        method: "DELETE",
      }),
    ]);

    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      error:
        "request body must contain only nodes, edges, positions, and expectedBlobHash",
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET, PUT");
    expect(editor.saves).toEqual([]);
  });

  it("returns named validation and edit-conflict failures", async () => {
    const request = () =>
      globalThis.fetch(`${baseUrl}/api/blueprints/sample-process`, {
        body: JSON.stringify({
          edges: [],
          expectedBlobHash: "a".repeat(40),
          nodes: [],
          positions: {},
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
    editor.saveError = new BlueprintValidationError(
      "Blueprint schema violation: /nodes must NOT have fewer than 1 items",
    );
    const invalid = await request();
    editor.saveError = new BlueprintEditConflictError(
      "a".repeat(40),
      "b".repeat(40),
    );
    const conflict = await request();

    expect(invalid.status).toBe(422);
    await expect(invalid.json()).resolves.toEqual({
      error:
        "Blueprint schema violation: /nodes must NOT have fewer than 1 items",
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: expect.stringContaining("changed since it was loaded"),
    });
  });

  it("fails closed when no repository artifact editor is composed", async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
    server = createConsoleServer({ board, state });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const response = await globalThis.fetch(
      `${baseUrl}/api/blueprints/sample-process`,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error:
        "Blueprint artifact editor is not active in this deployment composition",
    });
  });
});
