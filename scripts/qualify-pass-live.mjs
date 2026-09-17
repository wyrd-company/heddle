// ---
// relationships:
//   verifies:
//     - node-types
//     - agent-tools
// ---
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { once } from "node:events";
import { fork, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import assert from "node:assert/strict";
const [root, provider = "codex", scenario = "handoff"] = process.argv.slice(2);
if (!root) throw new Error("Supply the isolated pass fixture root");
const connection = JSON.parse(
  await readFile(join(root, "connection.json"), "utf8"),
);
const state = join(root, provider + "-" + scenario + "-" + String(Date.now()));
console.log(JSON.stringify({ fixtureState: state }));
await mkdir(state, { recursive: true });
const prompt =
  scenario === "observe"
    ? "Reply with exactly ready. Do not use any tools."
    : scenario === "block"
      ? 'Reply once with exactly ready. If a Stop hook tells you to hand off, call the handoff tool with {"accepted":true}. Do not inspect files or use other tools.'
      : 'Call the handoff tool immediately with {"accepted":true}. Do not inspect files, run commands, or use other tools. After the tool succeeds, reply done.';
const isolation = scenario === "isolation";
const killMid = scenario === "kill-mid";
const killTerminal = scenario === "kill-terminal";
const blueprint = {
  id: "inspection",
  nodes: [
    {
      id: "inspect",
      uses: "pass",
      params: {
        prompt: {
          inline:
            killMid || isolation
              ? 'Call status with a short checkpoint message, then call handoff with {"accepted":true}. If the status connection closes, continue with handoff; the service is recovering. Do not inspect files or run commands.'
              : prompt,
        },
        handoff: {
          type: "object",
          description: "Submit the inspection result",
          properties: { accepted: { type: "boolean" } },
          required: ["accepted"],
          additionalProperties: false,
        },
      },
    },
    { id: "finish", uses: "finish" },
  ],
  edges:
    scenario === "observe"
      ? [
          {
            source: "inspect",
            target: "inspect",
            condition: "result.output.turnEnded and stages.inspect.visits < 2",
          },
          {
            source: "inspect",
            target: "finish",
            condition: "result.output.turnEnded and stages.inspect.visits >= 2",
          },
        ]
      : [
          {
            source: "inspect",
            target: "finish",
            condition: "result.output.handoff",
          },
        ],
};
if (scenario === "approval") {
  blueprint.nodes[0].params.runtimeMode = "approval-required";
  blueprint.nodes[0].params.prompt = {
    inline: `Use Bash to run the exact command: printf ready > ${join(state, "approval-proof.txt")}. Then call handoff with {"accepted":true}. Do not do any other work.`,
  };
}
if (scenario === "reuse") {
  blueprint.nodes.splice(1, 0, {
    id: "review",
    uses: "pass",
    params: { ...blueprint.nodes[0].params, resumeThread: "inspect" },
  });
  blueprint.edges = [
    { source: "inspect", target: "review", condition: "result.output.handoff" },
    { source: "review", target: "finish", condition: "result.output.handoff" },
  ];
}
if (scenario === "allow") {
  blueprint.nodes[0].params.turnEndPolicy = "allow";
  blueprint.nodes[0].params.prompt = {
    inline: "Reply with exactly ready. Do not call tools.",
  };
  blueprint.edges = [
    {
      source: "inspect",
      target: "finish",
      condition: "result.output.turnEnded",
    },
  ];
}
const config = {
  ...connection,
  state,
  holdOnStatus: killMid || isolation,
  holdAfterHandoff: killTerminal,
  blueprint,
  qualifyApprovals: scenario === "approval",
  model: {
    instanceId: provider,
    model: provider === "codex" ? "gpt-5.6-luna" : "sonnet",
  },
};
const configFile = join(state, "config.json");
await writeFile(configFile, JSON.stringify(config));
await mkdir(join(root, "bin"), { recursive: true });
const serviceFile = join(root, "bin", "service.mjs");
await build({
  entryPoints: ["scripts/pass-live-service.ts"],
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  outfile: serviceFile,
});
// The fixture uses the same public schema assets as the installed package.
await mkdir(join(root, "docs/specifications"), { recursive: true });
for (const name of ["blueprint.schema.yml", "policy-rule.schema.yml"])
  await copyFile(
    resolve("docs/specifications", name),
    join(root, "docs/specifications", name),
  );
let errors = "";
const messages = [];
let notify = () => {};
const spawn = () => {
  const child = fork(serviceFile, [configFile], {
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  child.on("message", (message) => {
    messages.push(message);
    notify();
  });
  child.on("exit", () => notify());
  return child;
};
let service = spawn();
const wait = async (kind, predicate = () => true) => {
  for (;;) {
    const index = messages.findIndex(
      (message) => message.kind === kind && predicate(message),
    );
    if (index >= 0) return messages.splice(index, 1)[0];
    if (service.exitCode !== null || service.signalCode !== null)
      throw new Error(`service exited: ${errors}`);
    await new Promise((resolve) => {
      notify = resolve;
    });
  }
};
try {
  await wait("ready");
  service.send("start");
  await wait("started");
  if (isolation) {
    service.send({ start: "second-fixture" });
    await wait("started");
    await wait("status-held", (message) => message.runId === "fixture");
    await wait("status-held", (message) => message.runId === "second-fixture");
    service.send("state");
    const held = await wait("state");
    assert.equal(held.views.length, 2);
    assert.equal(
      new Set(held.views.map((view) => view.nativeSessionId)).size,
      2,
    );
    await build({
      entryPoints: ["src/t3code/index.ts"],
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      outfile: join(root, "client.mjs"),
    });
    const { T3Client } = await import(join(root, "client.mjs"));
    const client = T3Client.create({
      baseUrl: config.t3Url,
      accessToken: (await readFile(config.tokenFile, "utf8")).trim(),
    });
    try {
      const project = await client.projects.findByWorkspaceRoot(
        config.workspace,
      );
      const ordinary = await client.threads.ensure({
        threadId: randomUUID(),
        projectId: project.id,
        title: "ordinary inspection",
        modelSelection: config.model,
        runtimeMode: "full-access",
        worktreePath: config.workspace,
      });
      const turn = await client.threads.startTurn({
        threadId: ordinary.id,
        text: "Reply with exactly ready. Do not call tools.",
      });
      assert.equal((await turn.completion).state, "completed");
      const native = (await client.threads.get(ordinary.id)).session
        .providerThreadId;
      const events = (await readFile(join(state, "ordering.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.ok(
        events.some(
          (event) =>
            event.kind === "hook-decision" &&
            event.data.session_id === native &&
            event.data.mapped === null,
        ),
      );
      assert.equal(
        events.filter((event) => event.kind === "policy-request").length,
        0,
      );
      const env = JSON.parse(
        await readFile(join(root, "profile-env.json"), "utf8"),
      );
      for (const view of held.views) {
        const hooked = promisify(execFile)(
          join(config.profile, "bin/heddle"),
          ["hook", "stop", provider === "codex" ? "codex" : "claude"],
          { env },
        );
        hooked.child.stdin.end(
          JSON.stringify({
            hook_event_name: "Stop",
            session_id: view.nativeSessionId,
          }),
        );
        assert.equal(JSON.parse((await hooked).stdout).decision, "block");
      }
      service.send("state");
      const after = await wait("state");
      assert.deepEqual(after.runs, held.runs);
      assert.deepEqual(after.events, held.events);
      await writeFile(
        join(state, "isolation.json"),
        JSON.stringify(
          {
            ordinaryThreadId: ordinary.id,
            ordinaryNativeSessionId: native,
            active: held.views.map(({ runId, threadId, nativeSessionId }) => ({
              runId,
              threadId,
              nativeSessionId,
            })),
          },
          null,
          2,
        ),
      );
    } finally {
      await client.close();
    }
    service.send("release");
    await wait("terminal");
  }
  if (killMid || killTerminal) {
    await wait(killMid ? "status-held" : "handoff-committed");
    const killed = once(service, "exit");
    service.kill("SIGKILL");
    await killed;
    config.holdOnStatus = false;
    config.holdAfterHandoff = false;
    await writeFile(configFile, JSON.stringify(config));
    messages.length = 0;
    service = spawn();
    await wait("ready");
  }
  const terminal = await wait("terminal");
  service.send("state");
  const result = await wait("state");
  await writeFile(join(state, "result.json"), JSON.stringify(result, null, 2));
  assert.equal(terminal.status, "completed", JSON.stringify(result));
  const resumed = result.events.filter((event) => event.type === "resume");
  assert.equal(
    resumed.length,
    scenario === "observe" || scenario === "reuse" || isolation ? 2 : 1,
  );
  assert.ok(
    resumed.every(
      (event) =>
        event.payload.result ===
        (scenario === "observe" || scenario === "allow"
          ? "turnEnded"
          : "handoff"),
    ),
  );
  console.log(
    JSON.stringify({
      provider,
      scenario,
      status: terminal.status,
      resumeCount: resumed.length,
      state,
    }),
  );
  if (scenario !== "observe" && scenario !== "allow")
    await wait("terminal-stop");
  service.send("close");
} catch (error) {
  if (service.connected) service.send("state");
  await writeFile(join(state, "error.txt"), String(error) + "\n" + errors);
  service.kill("SIGTERM");
  throw error;
}
