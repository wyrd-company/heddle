// ---
// relationships:
//   verifies: command-line-interface
// ---
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; config: string; state: string } {
  const root = mkdtempSync(join(tmpdir(), "service-process-"));
  roots.push(root);
  const config = join(root, "config.yml"),
    state = join(root, "state");
  writeFileSync(
    config,
    "projects: []\ngithub:\n  credentialFile: /unused/app.yml\nblueprints:\n  repository: /unused/blueprints\nt3Code:\n  endpoint: http://127.0.0.1:3000\n",
  );
  return { root, config, state };
}

function launch(config: string, state: string): ChildProcess {
  const child = spawn(
    process.execPath,
    [resolve("dist/cli.js"), "start", "--config", config, "--state", state],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  return child;
}

async function started(child: ChildProcess): Promise<string> {
  return new Promise((resolveLine, reject) => {
    let output = "",
      errors = "";
    child.stderr?.on("data", (chunk) => {
      errors += String(chunk);
    });
    child.once("exit", (code, signal) =>
      reject(
        new Error(
          `service exited before startup (${String(code)}/${String(signal)}): ${errors}`,
        ),
      ),
    );
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("Heddle started")) resolveLine(output);
    });
  });
}

async function exited(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null)
    return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolveExit) =>
    child.once("exit", (code, signal) => resolveExit({ code, signal })),
  );
}

it.each(["SIGINT", "SIGTERM"] as const)(
  "%s closes the writer and permits immediate restart",
  async (signal) => {
    const f = fixture(),
      first = launch(f.config, f.state);
    await started(first);
    first.kill(signal);
    expect(await exited(first)).toEqual({ code: 0, signal: null });
    expect(existsSync(join(f.state, "heddle.sqlite.writer"))).toBe(false);
    const second = launch(f.config, f.state);
    await started(second);
    second.kill("SIGTERM");
    expect(await exited(second)).toEqual({ code: 0, signal: null });
  },
);

it("reclaims only a dead process lease after SIGKILL and opens the same durable store", async () => {
  const f = fixture(),
    first = launch(f.config, f.state);
  await started(first);
  first.kill("SIGKILL");
  expect((await exited(first)).signal).toBe("SIGKILL");
  const second = launch(f.config, f.state);
  const output = await started(second);
  expect(output).toContain(join(f.state, "heddle.sqlite"));
  second.kill("SIGTERM");
  expect((await exited(second)).code).toBe(0);
});
