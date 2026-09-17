// ---
// relationships:
//   verifies: agent-tools
// ---
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { parse } from "smol-toml";
import { afterEach, expect, it } from "vitest";
import { installStopHook, runStopHook } from "../src/agent-tools/hooks.js";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
it.each(["claude", "codex"] as const)(
  "installs %s and invokes its actual CLI command with real Stop input, allowing live policy changes",
  async (harness) => {
    const worktree = mkdtempSync(join(tmpdir(), "heddle-hook-"));
    cleanups.push(() => {
      rmSync(worktree, { recursive: true, force: true });
    });
    let policy = "require-handoff";
    let status = 200;
    const requests: {
      url: string | undefined;
      authorization: string | undefined;
    }[] = [];
    const server = createServer((req, res) => {
      requests.push({ url: req.url, authorization: req.headers.authorization });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          policy,
          requirement: "Call the missing handoff tool.",
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
          server.closeAllConnections();
        }),
    );
    const origin = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
    const directory = join(
      worktree,
      harness === "claude" ? ".claude" : ".codex",
    );
    mkdirSync(directory);
    const file = join(
      directory,
      harness === "claude" ? "settings.local.json" : "hooks.json",
    );
    writeFileSync(
      file,
      JSON.stringify({
        custom: { keep: true },
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo retained" }] }],
        },
      }),
    );
    if (harness === "codex")
      writeFileSync(
        join(directory, "config.toml"),
        'model = "fixture-model"\n[features]\nretained = true\n',
      );
    const install = () =>
      installStopHook(worktree, harness, {
        origin,
        path: "/agent-tools/fixture",
        token: "fixture-token",
      });
    const installed = await install();
    await install();
    const settings = JSON.parse(readFileSync(file, "utf8")) as {
      custom: unknown;
      hooks: { Stop: { hooks: { command: string }[] }[] };
    };
    expect(settings.custom).toEqual({ keep: true });
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(required(required(settings.hooks.Stop[1]).hooks[0]).command).toBe(
      `heddle hook stop ${harness}`,
    );
    expect(installed.mode).toBe(
      harness === "codex" ? "observation" : "blocking",
    );
    if (harness === "codex")
      expect(
        parse(readFileSync(join(directory, "config.toml"), "utf8")),
      ).toMatchObject({
        model: "fixture-model",
        features: { hooks: true, retained: true },
      });
    const input = {
      session_id: "session-fixture",
      transcript_path: "/tmp/transcript-fixture",
      cwd: worktree,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "Finished.",
      ...(harness === "codex"
        ? {
            turn_id: "turn-fixture",
            model: "fixture-model",
            permission_mode: "default",
          }
        : {}),
    };
    const invoke = async () => {
      const args = required(required(settings.hooks.Stop[1]).hooks[0])
        .command.split(" ")
        .slice(1);
      const child = spawn(process.execPath, [
        join(process.cwd(), "dist/cli.js"),
        ...args,
      ]);
      let out = "";
      child.stdout.on("data", (data) => (out += String(data)));
      child.stdin.end(JSON.stringify(input));
      const [code] = (await once(child, "close")) as unknown[];
      expect(code).toBe(0);
      return JSON.parse(out) as unknown;
    };
    expect(await invoke()).toEqual({
      decision: "block",
      reason: "Call the missing handoff tool.",
    });
    input.stop_hook_active = true;
    expect(await invoke()).toMatchObject({ decision: "block" });
    policy = "allow";
    expect(await invoke()).toEqual({});
    expect(requests).toEqual(
      Array.from({ length: 3 }, () => ({
        url: "/agent-tools/fixture/policy",
        authorization: "Bearer fixture-token",
      })),
    );
    policy = "unknown";
    await expect(runStopHook(harness, JSON.stringify(input))).rejects.toThrow(
      "Unknown turn-end policy",
    );
    policy = "allow";
    status = 401;
    await expect(runStopHook(harness, JSON.stringify(input))).rejects.toThrow(
      "Cannot read handoff requirement",
    );
    await expect(
      runStopHook(
        harness,
        JSON.stringify({ ...input, hook_event_name: "Other" }),
      ),
    ).rejects.toThrow("Invalid Stop hook input");
  },
);

it("retains configured validation dispatch beside Stop hook commands", async () => {
  const directory = mkdtempSync(join(tmpdir(), "heddle-cli-"));
  cleanups.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const config = join(directory, "invalid.yml");
  writeFileSync(config, "projects: invalid\n");
  const child = spawn(
    process.execPath,
    [
      join(process.cwd(), "dist/cli.js"),
      "validate",
      "--check-requires-issue",
      "fixtures/blueprints/recipe-pipeline/recipe-pipeline.yml",
    ],
    { env: { ...process.env, HEDDLE_CONFIG: config } },
  );
  let error = "";
  child.stderr.on("data", (data) => (error += String(data)));
  const [code] = (await once(child, "close")) as unknown[];
  expect(code).toBe(1);
  expect(error).toContain("projects");
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
