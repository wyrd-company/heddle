#!/usr/bin/env node

// ---
// relationships:
//   verifies: heddle
//   references: t3-headless
// ---

import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const t3BinaryInput = process.env.HEDDLE_T3_BINARY;
const installedPackageInput = process.env.HEDDLE_INSTALLED_PACKAGE;
const expectedVersion = process.env.HEDDLE_EXPECTED_T3_VERSION;

if (!t3BinaryInput || !installedPackageInput || !expectedVersion) {
  throw new Error(
    "HEDDLE_T3_BINARY, HEDDLE_INSTALLED_PACKAGE, and HEDDLE_EXPECTED_T3_VERSION are required",
  );
}

const t3Binary = await realpath(t3BinaryInput);
const installedPackage = await realpath(installedPackageInput);
if (
  t3Binary === "/usr/local/bin/t3" ||
  t3Binary === "/home/vscode/.t3" ||
  t3Binary.startsWith(`/home/vscode/.t3${sep}`)
) {
  throw new Error(`Refusing forbidden T3 path: ${t3Binary}`);
}
if (!installedPackage.startsWith(`/usr/local/lib/node_modules/heddle${sep}`)) {
  throw new Error(`Refusing non-deployed Heddle package: ${installedPackage}`);
}

const { stdout: versionOutput } = await execute(t3Binary, ["--version"], {
  timeout: 10_000,
});
const observedVersion = versionOutput.trim().match(/\d+\.\d+\.\d+/)?.[0];
if (observedVersion !== expectedVersion) {
  throw new Error(
    `Pinned T3 mismatch: expected ${expectedVersion}, observed ${observedVersion ?? "unknown"}`,
  );
}

const { T3ControlPlaneClient } = await import(
  pathToFileURL(
    join(installedPackage, "dist/control-plane/t3-control-plane-client.js"),
  ).href
);

const scratch = await mkdtemp(join(tmpdir(), "heddle-pinned-t3-"));
const baseDirectory = join(scratch, "base");
const projectPath = join(scratch, "project");
await mkdir(baseDirectory, { recursive: true });
await mkdir(projectPath, { recursive: true });
await execute("git", ["init", "--quiet", "--initial-branch=main"], {
  cwd: projectPath,
});
await execute("git", ["config", "user.email", "test@example.invalid"], {
  cwd: projectPath,
});
await execute("git", ["config", "user.name", "Test Operator"], {
  cwd: projectPath,
});
await execute("git", ["commit", "--allow-empty", "--quiet", "-m", "initial"], {
  cwd: projectPath,
});

const { createServer } = await import("node:net");
const socket = createServer();
await new Promise((resolve, reject) => {
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", resolve);
});
const socketAddress = socket.address();
if (!socketAddress || typeof socketAddress === "string") {
  throw new Error("Unable to allocate an isolated T3 port");
}
const port = socketAddress.port;
await new Promise((resolve, reject) =>
  socket.close((error) => (error ? reject(error) : resolve())),
);
if (port === 3773) throw new Error("Refusing the live T3 port 3773");

const childEnvironment = {
  HOME: join(scratch, "home"),
  LANG: "C.UTF-8",
  NO_COLOR: "1",
  PATH: `${dirname(t3Binary)}:/usr/bin:/bin`,
  T3CODE_HOME: baseDirectory,
  T3CODE_NO_BROWSER: "1",
};
await mkdir(childEnvironment.HOME, { recursive: true });
const server = spawn(
  t3Binary,
  [
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--base-dir",
    baseDirectory,
    projectPath,
  ],
  {
    detached: true,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let serverOutput = "";
const pairing = new Promise((resolvePairing, rejectPairing) => {
  const inspect = (chunk) => {
    serverOutput += chunk.toString();
    const token = serverOutput.match(/Token:\s+(\S+)/)?.[1];
    if (token) resolvePairing(token);
  };
  server.stdout.on("data", inspect);
  server.stderr.on("data", inspect);
  server.once("exit", (code) =>
    rejectPairing(new Error(`Isolated T3 exited before pairing (${code})`)),
  );
});

const terminateServer = async () => {
  if (server.exitCode !== null || server.pid === undefined) return;
  process.kill(-server.pid, "SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => server.once("exit", resolveExit)),
    delay(3_000),
  ]);
  if (server.exitCode === null) process.kill(-server.pid, "SIGKILL");
};

try {
  const token = await Promise.race([
    pairing,
    delay(15_000).then(() => {
      throw new Error(`Isolated T3 emitted no pairing token: ${serverOutput}`);
    }),
  ]);
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      await globalThis.fetch(`${baseUrl}/api/orchestration/shell`, {
        signal: globalThis.AbortSignal.timeout(500),
      });
      break;
    } catch {
      if (attempt === 149) throw new Error("Isolated T3 did not become ready");
      await delay(100);
    }
  }

  const client = new T3ControlPlaneClient({ baseUrl });
  const exchanged = await client.exchangePairingToken(
    token,
    "heddle-deployment-qualification",
  );
  const projectId = globalThis.crypto.randomUUID();
  const threadId = globalThis.crypto.randomUUID();
  const branch = "qualification/thread";
  const worktreePath = join(scratch, "thread-worktree");
  await execute(
    "git",
    ["worktree", "add", "--quiet", "-b", branch, worktreePath, "main"],
    { cwd: projectPath },
  );
  const projectDispatch = await client.dispatch({
    type: "project.create",
    commandId: globalThis.crypto.randomUUID(),
    projectId,
    title: "Sample Project",
    workspaceRoot: projectPath,
    createdAt: new Date().toISOString(),
  });
  const threadDispatch = await client.dispatch({
    type: "thread.create",
    commandId: globalThis.crypto.randomUUID(),
    threadId,
    projectId,
    title: "Sample Thread",
    modelSelection: { instanceId: "claudeAgent", model: "default" },
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    branch,
    worktreePath,
    createdAt: new Date().toISOString(),
  });
  const observations = client.pollThread(threadId, 0);
  const observation = await observations.next();
  await observations.return(undefined);
  if (observation.done || observation.value.thread.id !== threadId) {
    throw new Error("Installed Heddle client did not poll the created thread");
  }
  process.stdout.write(
    `${JSON.stringify({
      accessTokenIssued: exchanged.access_token.length > 0,
      installedClient: installedPackage,
      isolatedBaseDirectory: baseDirectory,
      isolatedPort: port,
      projectSequence: projectDispatch.sequence,
      shellPhase: observation.value.phase,
      t3Binary,
      t3Version: observedVersion,
      threadSequence: threadDispatch.sequence,
    })}\n`,
  );
} finally {
  await terminateServer();
  await rm(scratch, { force: true, recursive: true });
}
