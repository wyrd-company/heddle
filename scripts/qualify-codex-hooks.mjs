// ---
// relationships:
//   verifies: agent-tools
// ---
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { exportHookPlugins } from "../dist/index.js";
const version = execFileSync("codex", ["--version"], {
  encoding: "utf8",
}).trim();
for (const trusted of [false, true]) {
  const directory = mkdtempSync(join(tmpdir(), "heddle-codex-qualification-"));
  const home = join(directory, "home"),
    worktree = join(directory, "work");
  mkdirSync(home);
  mkdirSync(worktree);
  mkdirSync(join(worktree, ".git"));
  mkdirSync(join(directory, "bin"));
  symlinkSync(resolve("dist/cli.js"), join(directory, "bin/heddle"));
  const requests = [];
  let hookCalls = 0;
  let child;
  let nativeSession;
  const hookInputs = [];
  const hookSocket = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    hookInputs.push(input);
    assert.equal(input.session_id, nativeSession);
    assert.deepEqual(Object.keys(input), ["session_id"]);
    hookCalls++;
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify(
          hookCalls === 1
            ? { decision: "block", reason: "Call the missing handoff tool." }
            : {},
        ),
      );
  });
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const n = requests.length;
    const item = {
      id: `msg-${n}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Finished.", annotations: [] }],
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: `resp-${n}` } },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: `resp-${n}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ])
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    const source = join(directory, "packages");
    await exportHookPlugins(source);
    const installEnvironment = {
      PATH: process.env.PATH,
      HOME: directory,
      CODEX_HOME: home,
    };
    execFileSync(
      "codex",
      ["plugin", "marketplace", "add", join(source, "codex")],
      { env: installEnvironment, cwd: directory },
    );
    execFileSync("codex", ["plugin", "add", "heddle@heddle"], {
      env: installEnvironment,
      cwd: directory,
    });
    hookSocket.listen(join(directory, "hooks.sock"));
    await once(hookSocket, "listening");
    // Fixture-only operator trust. Production installation never writes this.
    const identity = {
      event_name: "stop",
      hooks: [
        {
          async: false,
          command: "heddle hook stop codex",
          timeout: 600,
          type: "command",
        },
      ],
    };
    const hash =
      "sha256:" +
      createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const trust = trusted
      ? `\n[hooks.state.${JSON.stringify("heddle@heddle:hooks/hooks.json:stop:0:0")}]\ntrusted_hash=${JSON.stringify(hash)}\n`
      : "";
    const installedConfig = readFileSync(join(home, "config.toml"), "utf8");
    writeFileSync(
      join(home, "config.toml"),
      `model='fixture-model'\nmodel_provider='fixture'\n` +
        installedConfig +
        `\n[model_providers.fixture]\nname='Fixture'\nbase_url=${JSON.stringify(origin)}\nwire_api='responses'\nrequires_openai_auth=false\n[projects.${JSON.stringify(worktree)}]\ntrust_level='trusted'\n${trust}`,
    );
    child = spawn(
      "codex",
      [
        "--enable",
        "hooks",
        "exec",
        "--skip-git-repo-check",
        "--json",
        "--sandbox",
        "danger-full-access",
        "-C",
        worktree,
        "Return Finished.",
      ],
      {
        env: {
          PATH: join(directory, "bin") + ":" + process.env.PATH,
          HOME: directory,
          CODEX_HOME: home,
          HEDDLE_STATE_DIR: directory,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      error = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      for (const line of output.split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.type === "thread.started") nativeSession = event.thread_id;
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => (error += chunk));
    const [code] = await once(child, "close");
    assert.equal(code, 0, error);
    assert.equal(requests.length, trusted ? 2 : 1);
    assert.equal(hookCalls, trusted ? 2 : 0);
    assert.equal(
      output
        .split("\n")
        .filter((line) => line.includes('"type":"turn.completed"')).length,
      1,
    );
    if (trusted)
      assert.match(
        JSON.stringify(requests[1]),
        /Call the missing handoff tool/,
      );
    console.log(
      JSON.stringify({
        version,
        trusted,
        modelRequests: requests.length,
        hookCalls,
        turnCompleted: 1,
        blockingMeasured: trusted,
        sessionIdMatched:
          hookInputs.length > 0 &&
          hookInputs.every((input) => input.session_id === nativeSession),
      }),
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await new Promise((resolve) => {
      hookSocket.close(resolve);
      hookSocket.closeAllConnections();
    });
    rmSync(directory, { recursive: true, force: true });
  }
}
