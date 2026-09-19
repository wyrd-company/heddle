// ---
// relationships:
//   verifies: agent-tools
// ---
import { fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qualification-"));
  roots.push(root);
  const bin = join(root, "native-bin");
  const home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(home);
  // Stub only native harness installation/execution. Hook commands themselves
  // execute the built Heddle CLI and reach the real qualification receiver.
  const native = `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('fixture-harness');
else if (args[0] === 'plugin') {
  const config = path.join(process.env.CODEX_HOME, 'config.toml');
  if (!fs.existsSync(config)) fs.writeFileSync(config, '');
} else {
  (async () => {
    const config = fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
    const origin = JSON.parse(config.match(/base_url=(.+)/)[1]);
    const session = 'sample-native-session';
    console.log(JSON.stringify({type:'thread.started', thread_id:session}));
    await fetch(origin, {method:'POST', body:JSON.stringify({input:'sample'})});
    if (config.includes('trusted_hash=')) {
      const hook = () => JSON.parse(cp.execFileSync('heddle', ['hook','stop','codex'], {
        env: process.env, encoding:'utf8',
        input:JSON.stringify({hook_event_name:'Stop',session_id:session})
      }));
      const first = hook();
      if (first.decision === 'block') {
        await fetch(origin, {method:'POST',body:JSON.stringify({input:first.reason})});
        hook();
      }
    }
    console.log(JSON.stringify({type:'turn.completed'}));
  })().catch(error => { console.error(error); process.exitCode=1; });
}
`;
  for (const name of ["codex", "claude"])
    writeFileSync(join(bin, name), native, { mode: 0o755 });
  return {
    root,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    },
  };
}
function launch(file: string, args: string[], env = process.env) {
  const child = spawn(process.execPath, [resolve(file), ...args], { env });
  children.push(child);
  let output = "",
    error = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    error += String(chunk);
  });
  return { child, output: () => output, error: () => error };
}
async function profile() {
  const f = fixture();
  const process = launch("scripts/pass-fixture-profiles.mjs", [f.root], f.env);
  const [code] = (await once(process.child, "close")) as unknown[];
  expect(code, process.error()).toBe(0);
  const env = JSON.parse(
    readFileSync(join(f.root, "profile-env.json"), "utf8"),
  ) as NodeJS.ProcessEnv;
  return { ...f, env };
}
async function hook(env: NodeJS.ProcessEnv) {
  const request = launch("dist/cli.js", ["hook", "stop", "codex"], env);
  request.child.stdin.end(
    JSON.stringify({ hook_event_name: "Stop", session_id: "sample-session" }),
  );
  const [code] = (await once(request.child, "close")) as unknown[];
  expect(code, request.error()).toBe(0);
  return JSON.parse(request.output()) as unknown;
}

it("Codex qualification sends trusted hooks to its receiver through the native environment", async () => {
  const f = fixture();
  const result = launch("scripts/qualify-codex-hooks.mjs", [], f.env);
  const [code] = (await once(result.child, "close")) as unknown[];
  expect(code, result.error()).toBe(0);
  expect(result.output()).toContain(
    '"trusted":true,"modelRequests":2,"hookCalls":2',
  );
  expect(result.output()).toContain('"sessionIdMatched":true');
});

it("the recorder receives callbacks from the exported profile instead of an inert ALLOW", async () => {
  const f = await profile();
  const recorder = launch("scripts/pass-hook-recorder.mjs", [f.root], f.env);
  await Promise.race([
    once(recorder.child.stdout, "data"),
    once(recorder.child, "exit"),
  ]);
  expect(recorder.output(), recorder.error()).toContain("receiver ready");
  expect(await hook(f.env)).toEqual({});
  expect(readFileSync(join(f.root, "hook-events.jsonl"), "utf8")).toContain(
    '"session_id":"sample-session"',
  );
});

it("the live pass service receives callbacks from the exported profile with a separate scenario database", async () => {
  const f = await profile();
  const state = join(f.root, "scenario");
  mkdirSync(state);
  const tokenFile = join(f.root, "fixture-token");
  writeFileSync(tokenFile, "fixture-token");
  const entry = join(f.root, "bin", "service.mjs");
  await build({
    entryPoints: ["scripts/pass-live-service.ts"],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    outfile: entry,
  });
  const configFile = join(f.root, "config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      state,
      profile: f.root,
      port: 0,
      t3Url: "http://127.0.0.1:1",
      tokenFile,
      workspace: f.root,
      model: { instanceId: "sample-provider", model: "sample-model" },
      blueprint: {
        id: "sample",
        nodes: [{ id: "finish", uses: "finish" }],
        edges: [],
      },
    }),
  );
  const child = fork(entry, [configFile], {
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  let errors = "";
  child.stderr?.on("data", (chunk) => {
    errors += String(chunk);
  });
  const [message] = (await Promise.race([
    once(child, "message"),
    once(child, "exit"),
  ])) as unknown[];
  expect(message, errors).toEqual({ kind: "ready" });
  expect(await hook(f.env)).toEqual({});
  const events = readFileSync(join(state, "ordering.jsonl"), "utf8");
  expect(events).toContain(
    '"kind":"native-stop","data":{"session_id":"sample-session"}',
  );
  expect(events).toContain('"kind":"hook-response","data":{"status":200}');
});
