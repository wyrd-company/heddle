// ---
// relationships:
//   verifies:
//     - blueprint-authoring
//     - engine-and-run-model
// ---
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { RunStore } from "../src/index.js";

async function run(
  path: string,
  mode: string,
  selection: string,
): Promise<unknown> {
  const child: ChildProcess = fork(
    fileURLToPath(new URL("./child-output-keys.fixture.ts", import.meta.url)),
    [path, mode, selection],
    { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const exited = once(child, "exit");
  let errors = "";
  child.stderr?.on("data", (chunk) => {
    errors += String(chunk);
  });
  let message: unknown;
  child.on("message", (value) => {
    message = value;
  });
  try {
    expect((await exited)[0], errors).toBe(0);
    return message;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
}
const literal = Object.fromEntries<unknown>([
  ["draft-notes", "first edition"],
  ["draft.notes", { pages: 12 }],
  ["draft notes", ["ink", "paper"]],
  ['draft\\"notes', "escaped"],
  ["__proto__", { edition: 2 }],
  ["", "unnamed"],
  ["ordinary", false],
]);
it.each(["complete", "restart"])(
  "preserves literal default output keys through public child completion and persisted %s results",
  async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "child-output-keys-"));
    const path = join(directory, "runs.sqlite");
    try {
      if (mode === "restart")
        expect(await run(path, "pause", "default")).toEqual({
          status: "awaiting",
          child: "awaiting",
        });
      expect(
        await run(path, mode === "restart" ? "resume" : "complete", "default"),
      ).toMatchObject({
        status: "completed",
        result: literal,
        completion: { completed: true, payload: literal },
        child: literal,
        events: [{ payload: { payload: literal } }],
      });
      const store = new RunStore(path);
      try {
        expect(store.get("collection-1").context["result"]).toEqual(literal);
        expect(store.get("collection-1").context["inspect"]).toEqual({
          completed: true,
          payload: literal,
        });
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
it.each([
  ["empty", {}],
  ["absent", { ordinary: false }],
  [
    "authored",
    { difference: 7, dotted: "nested", selected: "first edition", doubled: 10 },
  ],
] as const)(
  "preserves %s output mapping semantics through child completion",
  async (selection, expected) => {
    const directory = mkdtempSync(join(tmpdir(), "child-output-mapping-"));
    try {
      expect(
        await run(join(directory, "runs.sqlite"), "complete", selection),
      ).toMatchObject({
        status: "completed",
        result: expected,
        completion: { completed: true, payload: expected },
      });
      const store = new RunStore(join(directory, "runs.sqlite"));
      try {
        expect(store.get("collection-1").context["result"]).toEqual(expected);
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
