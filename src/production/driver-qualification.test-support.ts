// ---
// relationships:
//   verifies: heddle
//   references: t3-headless
// ---

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import {
  T3ControlPlaneClient,
  type T3ProviderCatalogReader,
} from "../control-plane/index.js";

const execute = promisify(execFile);

/**
 * The operator's live control plane. A qualification run that reaches it would
 * dispatch against real provider accounts and real threads.
 */
export const LIVE_T3_PORT = 3773;

/** The operator's live board. Heddle is its single writer of child status. */
export const LIVE_BOARD_DIRECTORY = "/workspaces/kanban";

export class QualificationIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualificationIsolationError";
  }
}

/**
 * Refuse any qualification surface that could reach operator state.
 *
 * Each check has a named test in `driver-qualification-isolation.test.ts`; the
 * suite asserts both that a safe surface is accepted and that each unsafe one
 * is refused.
 */
export const assertQualificationIsolation = (surface: {
  readonly boardDirectory: string;
  readonly port: number;
  readonly stateDirectory: string;
  readonly t3BaseDirectory: string;
}): void => {
  if (surface.port === LIVE_T3_PORT) {
    throw new QualificationIsolationError(
      `Refusing the operator's live T3 port ${LIVE_T3_PORT}`,
    );
  }
  const board = resolve(surface.boardDirectory);
  if (board === LIVE_BOARD_DIRECTORY || board.startsWith(`${LIVE_BOARD_DIRECTORY}${sep}`)) {
    throw new QualificationIsolationError(
      `Refusing the operator's live board at ${LIVE_BOARD_DIRECTORY}`,
    );
  }
  const scratch = resolve(tmpdir());
  for (const [label, directory] of [
    ["T3 base directory", surface.t3BaseDirectory],
    ["state directory", surface.stateDirectory],
  ] as const) {
    const resolved = resolve(directory);
    if (resolved !== scratch && !resolved.startsWith(`${scratch}${sep}`)) {
      throw new QualificationIsolationError(
        `Refusing a ${label} outside the scratch root: ${resolved}`,
      );
    }
  }
};

export type IsolatedT3 = {
  readonly accessToken: string;
  readonly baseUrl: string;
  readonly observedVersion: string;
  readonly port: number;
  readonly projectPath: string;
  /** Everything the isolated server has written, for diagnosing a rejection. */
  serverLog(): string;
  stop(): Promise<void>;
};

const allocatePort = async (): Promise<number> => {
  const socket = createServer();
  await new Promise<void>((resolvePort, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => resolvePort());
  });
  const address = socket.address();
  if (address === null || typeof address === "string") {
    throw new Error("Unable to allocate an isolated T3 port");
  }
  const { port } = address;
  await new Promise<void>((resolvePort, reject) =>
    socket.close((error) => (error ? reject(error) : resolvePort())),
  );
  return port;
};

const readPairingToken = (server: ChildProcess): Promise<string> =>
  new Promise((resolvePairing, reject) => {
    let output = "";
    const inspect = (chunk: Buffer): void => {
      output += chunk.toString();
      const token = output.match(/Token:\s+(\S+)/)?.[1];
      if (token) resolvePairing(token);
    };
    server.stdout?.on("data", inspect);
    server.stderr?.on("data", inspect);
    server.once("exit", (code) =>
      reject(new Error(`Isolated T3 exited before pairing (code ${code})`)),
    );
  });

export type ProviderInstanceFixture = {
  readonly displayName: string;
  readonly driver: string;
  readonly instanceId: string;
};

/**
 * Start a real T3 whose state is isolated but whose provider identity is the
 * operator's own. `T3CODE_HOME` carries state and is scratch; `HOME` carries
 * identity and is the caller's, because separate test-only provider accounts
 * do not exist.
 */
export const startIsolatedT3 = async (options: {
  readonly binary: string;
  readonly home: string;
  readonly providerInstances?: readonly ProviderInstanceFixture[];
  readonly scratch: string;
}): Promise<IsolatedT3> => {
  const baseDirectory = join(options.scratch, "t3-base");
  const projectPath = join(options.scratch, "t3-project");
  await mkdir(join(baseDirectory, "userdata"), { recursive: true });
  await mkdir(projectPath, { recursive: true });
  if (options.providerInstances !== undefined) {
    await writeFile(
      join(baseDirectory, "userdata", "settings.json"),
      JSON.stringify({
        providerInstances: Object.fromEntries(
          options.providerInstances.map((instance) => [
            instance.instanceId,
            {
              displayName: instance.displayName,
              driver: instance.driver,
              enabled: true,
            },
          ]),
        ),
      }),
    );
  }
  await execute("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: projectPath,
  });
  await execute(
    "git",
    [
      "-c",
      "user.name=Qualification Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "initial",
    ],
    { cwd: projectPath },
  );

  const port = await allocatePort();
  assertQualificationIsolation({
    boardDirectory: options.scratch,
    port,
    stateDirectory: options.scratch,
    t3BaseDirectory: baseDirectory,
  });

  const { stdout: versionOutput } = await execute(
    options.binary,
    ["--version"],
    { timeout: 10_000 },
  );
  const observedVersion = versionOutput.trim().match(/t3 v(\S+)/)?.[1];
  if (observedVersion === undefined) {
    throw new Error(`Unable to read the T3 version from ${options.binary}`);
  }

  const server = spawn(
    options.binary,
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
      env: {
        HOME: options.home,
        LANG: "C.UTF-8",
        NO_COLOR: "1",
        PATH: `${dirname(process.execPath)}:${dirname(options.binary)}:${process.env["PATH"] ?? ""}`,
        T3CODE_HOME: baseDirectory,
        T3CODE_NO_BROWSER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let serverOutput = "";
  server.stdout?.on("data", (chunk: Buffer) => {
    serverOutput += chunk.toString();
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    serverOutput += chunk.toString();
  });

  const stop = async (): Promise<void> => {
    if (server.pid === undefined || server.exitCode !== null) return;
    const signal = (value: NodeJS.Signals): void => {
      try {
        process.kill(-(server.pid as number), value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    signal("SIGTERM");
    await Promise.race([
      new Promise<void>((resolveExit) => server.once("exit", () => resolveExit())),
      delay(3_000),
    ]);
    if (server.exitCode === null) signal("SIGKILL");
  };

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const pairingToken = await Promise.race([
      readPairingToken(server),
      delay(20_000).then(() => {
        throw new Error("Isolated T3 emitted no pairing token");
      }),
    ]);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await globalThis.fetch(`${baseUrl}/api/orchestration/shell`, {
          signal: globalThis.AbortSignal.timeout(500),
        });
        break;
      } catch {
        if (attempt === 199) throw new Error("Isolated T3 did not become ready");
        await delay(100);
      }
    }
    const client = new T3ControlPlaneClient({ baseUrl });
    const exchanged = await client.exchangePairingToken(
      pairingToken,
      "heddle-driver-qualification",
    );
    return {
      accessToken: exchanged.access_token,
      baseUrl,
      observedVersion,
      port,
      projectPath,
      serverLog: () => serverOutput,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
};

export const makeQualificationScratch = async (): Promise<{
  cleanup(): Promise<void>;
  root: string;
}> => {
  const root = await mkdtemp(join(tmpdir(), "heddle-driver-qualification-"));
  return { cleanup: () => rm(root, { force: true, recursive: true }), root };
};

export const QUALIFICATION_EXECUTION = {
  displayName: "Workbench Alpha",
  driver: "claudeAgent",
  instanceId: "claude-execution",
} as const;

export const QUALIFICATION_REVIEW = {
  displayName: "Workbench Beta",
  driver: "claudeAgent",
  instanceId: "claude-review",
} as const;

export const QUALIFICATION_SECOND_DRIVER = {
  displayName: "Workbench Gamma",
  driver: "codex",
  instanceId: "codex-execution",
} as const;

export const QUALIFICATION_INSTANCES = [
  QUALIFICATION_EXECUTION,
  QUALIFICATION_REVIEW,
  QUALIFICATION_SECOND_DRIVER,
] as const;

/**
 * Wait until every configured instance has finished discovery and reports a
 * model. T3 answers before discovery completes, and that early answer looks
 * exactly like an unsupported driver.
 */
export const readyProviderModels = async (
  client: T3ProviderCatalogReader,
): Promise<Map<string, string>> => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const catalog = await client.readProviderCatalog();
    const ready = QUALIFICATION_INSTANCES.every((instance) =>
      catalog.some(
        (row) =>
          row.instanceId === instance.instanceId &&
          row.state === "ready" &&
          row.models.length > 0,
      ),
    );
    if (ready) {
      return new Map(
        catalog.map((row) => [row.instanceId, row.models[0]?.slug ?? ""]),
      );
    }
    await delay(250);
  }
  throw new Error("Isolated T3 never finished provider discovery");
};

export const qualificationAliases = (models: Map<string, string>) => ({
  execution: {
    model: models.get(QUALIFICATION_EXECUTION.instanceId) ?? "",
    providerDisplayName: QUALIFICATION_EXECUTION.displayName,
  },
  review: {
    model: models.get(QUALIFICATION_REVIEW.instanceId) ?? "",
    providerDisplayName: QUALIFICATION_REVIEW.displayName,
  },
  secondary: {
    model: models.get(QUALIFICATION_SECOND_DRIVER.instanceId) ?? "",
    providerDisplayName: QUALIFICATION_SECOND_DRIVER.displayName,
  },
});
