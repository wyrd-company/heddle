// ---
// relationships:
//   verifies: heddle
//   references: t3-headless
// ---

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";
import { createServer } from "node:net";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import {
  T3ControlPlaneClient,
  type T3ProviderCatalogReader,
} from "../control-plane/index.js";
import {
  resolveT3AwarenessPhase,
  type T3ShellThread,
} from "../control-plane/t3-agent-awareness.js";

const execute = promisify(execFile);
const T3_STARTUP_CAPTURE_LIMIT = 65_536;
const T3_STARTUP_DIAGNOSTIC_LIMIT = 2_000;
const ESCAPE_CONTROL = String.fromCharCode(27);
const BELL_CONTROL = String.fromCharCode(7);
const ANSI_STRING_SEQUENCE = new RegExp(
  `${ESCAPE_CONTROL}(?:\\][\\s\\S]*?(?:${BELL_CONTROL}|${ESCAPE_CONTROL}\\\\|$)|[PX^_][\\s\\S]*?(?:${ESCAPE_CONTROL}\\\\|$))`,
  "g",
);
const ANSI_CONTROL_SEQUENCE = new RegExp(
  `${ESCAPE_CONTROL}(?:\\[[0-?]*[ -/]*[@-~]|[ -/]*[0-~])`,
  "g",
);

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
  if (
    board === LIVE_BOARD_DIRECTORY ||
    board.startsWith(`${LIVE_BOARD_DIRECTORY}${sep}`)
  ) {
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

const errorCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;

const filesystemIdentity = async (directory: string): Promise<string> => {
  const missingSegments: string[] = [];
  let candidate = resolve(directory);
  for (;;) {
    try {
      return join(await realpath(candidate), ...missingSegments);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new QualificationIsolationError(
          "Unable to resolve qualification path identity: " + candidate,
        );
      }
    }

    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new QualificationIsolationError(
          "Unable to inspect qualification path identity: " + candidate,
        );
      }
    }
    if (metadata?.isSymbolicLink()) {
      throw new QualificationIsolationError(
        "Refusing a qualification path through a dangling link: " + candidate,
      );
    }

    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new QualificationIsolationError(
        "Unable to resolve qualification path identity: " + directory,
      );
    }
    missingSegments.unshift(basename(candidate));
    candidate = parent;
  }
};

const isWithin = (candidate: string, root: string): boolean =>
  candidate === root || candidate.startsWith(root + sep);

const assertQualificationFilesystemIsolation = async (
  scratch: string,
  derivedPaths: readonly string[],
): Promise<void> => {
  const [physicalScratchRoot, physicalLiveBoard, physicalScratch] =
    await Promise.all([
      filesystemIdentity(tmpdir()),
      filesystemIdentity(LIVE_BOARD_DIRECTORY),
      filesystemIdentity(scratch),
    ]);
  if (
    !isWithin(physicalScratch, physicalScratchRoot) ||
    isWithin(physicalScratch, physicalLiveBoard)
  ) {
    throw new QualificationIsolationError(
      "Refusing a scratch directory outside the physical scratch root: " +
        physicalScratch,
    );
  }
  for (const directory of derivedPaths) {
    const identity = await filesystemIdentity(directory);
    if (
      !isWithin(identity, physicalScratch) ||
      isWithin(identity, physicalLiveBoard)
    ) {
      throw new QualificationIsolationError(
        "Refusing a derived qualification path outside its scratch identity: " +
          identity,
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
  readonly providerHome: string;
  readonly controlledProviderLog: string;
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

const appendStartupOutput = (current: string, chunk: Buffer): string =>
  `${current}${chunk.toString()}`.slice(-T3_STARTUP_CAPTURE_LIMIT);

export const safeT3StartupDiagnostic = (output: string): string => {
  const withoutEscapeSequences = output
    .replace(ANSI_STRING_SEQUENCE, "")
    .replace(ANSI_CONTROL_SEQUENCE, "");
  const withoutTerminalControls = Array.from(withoutEscapeSequences)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 32 && (code < 127 || code > 159))
      );
    })
    .join("");
  const redacted = withoutTerminalControls
    .replace(
      /\b(authorization)(["']?\s*[:=]\s*)[^"'\s,}\]][^"'\r\n,}\]]*/gi,
      "$1$2[redacted]",
    )
    .replace(
      /\b(authorization)(["']?\s*[:=]\s*)(["'])(.*?)\3/gi,
      "$1$2$3[redacted]$3",
    )
    .replace(
      /\b(api[_-]?key|(?:[a-z0-9]+[_-])+(?:secret|token|key)|secret|token)(["']?\s*[:=]\s*)[^"'\s,}\]][^\s,}\]]*/gi,
      "$1$2[redacted]",
    )
    .replace(
      /\b(api[_-]?key|(?:[a-z0-9]+[_-])+(?:secret|token|key)|secret|token)(["']?\s*[:=]\s*)(["'])(.*?)\3/gi,
      "$1$2$3[redacted]$3",
    )
    .replace(/(["']?)\bBearer(\s+)[^"'\s,}\]]+\1/gi, "$1Bearer$2[redacted]$1");
  const lines = redacted
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const classified = lines.filter(
    (line) =>
      /\b(error|failed|fatal)\b/i.test(line) || /\bE[A-Z]{3,}\b/.test(line),
  );
  return (classified.length > 0 ? classified : lines)
    .join(" | ")
    .slice(0, T3_STARTUP_DIAGNOSTIC_LIMIT);
};

const readPairingToken = (
  server: ChildProcess,
  startupDiagnostic: () => string,
): Promise<string> =>
  new Promise((resolvePairing, reject) => {
    let output = "";
    const cleanup = (): void => {
      server.stdout?.off("data", inspect);
      server.stderr?.off("data", inspect);
      server.off("exit", exited);
    };
    const inspect = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-4_096);
      const token = output.match(/Token:\s+(\S+)/)?.[1];
      if (token) {
        cleanup();
        resolvePairing(token);
      }
    };
    const exited = (code: number | null): void => {
      cleanup();
      const diagnostic = startupDiagnostic();
      reject(
        new Error(
          `Isolated T3 exited before pairing (code ${code})${diagnostic === "" ? "" : `: ${diagnostic}`}`,
        ),
      );
    };
    server.stdout?.on("data", inspect);
    server.stderr?.on("data", inspect);
    server.once("exit", exited);
    if (server.exitCode !== null) exited(server.exitCode);
  });

export type ProviderInstanceFixture = {
  readonly config?: Readonly<Record<string, unknown>>;
  readonly displayName: string;
  readonly driver: string;
  readonly instanceId: string;
};

/**
 * Start a real T3 whose state and provider HOME are both scratch-owned.
 * Non-native fixtures use the controllable credential-free provider binary.
 * Native rows copy only their selected provider identity into this HOME from
 * an already provider-isolated container.
 */
export const startIsolatedT3 = async (options: {
  readonly binary: string;
  readonly providerInstances?: readonly ProviderInstanceFixture[];
  readonly scratch: string;
}): Promise<IsolatedT3> => {
  const baseDirectory = join(options.scratch, "t3-base");
  const projectPath = join(options.scratch, "t3-project");
  const providerHome = join(options.scratch, "provider-home");
  const controlledProviderLog = join(
    options.scratch,
    "controlled-provider.jsonl",
  );
  assertQualificationIsolation({
    boardDirectory: options.scratch,
    port: 0,
    stateDirectory: options.scratch,
    t3BaseDirectory: baseDirectory,
  });
  await assertQualificationFilesystemIsolation(options.scratch, [
    baseDirectory,
    join(baseDirectory, "userdata"),
    join(baseDirectory, "userdata", "settings.json"),
    projectPath,
    providerHome,
    join(providerHome, "credential-sentinel"),
    controlledProviderLog,
  ]);

  const port = await allocatePort();
  assertQualificationIsolation({
    boardDirectory: options.scratch,
    port,
    stateDirectory: options.scratch,
    t3BaseDirectory: baseDirectory,
  });

  await mkdir(join(baseDirectory, "userdata"), { recursive: true });
  await mkdir(projectPath, { recursive: true });
  await mkdir(providerHome, { recursive: true });
  await writeFile(
    join(providerHome, "credential-sentinel"),
    "provider-state\n",
  );
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
              config: instance.config ?? {},
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
        HEDDLE_CONTROLLED_PROVIDER: "1",
        HEDDLE_CONTROLLED_PROVIDER_LOG: controlledProviderLog,
        HEDDLE_CONTROLLED_PROVIDER_PROBE_DELAY_MS: "1500",
        HEDDLE_CURSOR_TEST_PROMPT_DELAY_MS: "600000",
        HOME: providerHome,
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
    serverOutput = appendStartupOutput(serverOutput, chunk);
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    serverOutput = appendStartupOutput(serverOutput, chunk);
  });

  const stop = async (): Promise<void> => {
    if (server.pid === undefined || server.exitCode !== null) return;
    const signal = (value: "SIGKILL" | "SIGTERM"): void => {
      try {
        process.kill(-(server.pid as number), value);
      } catch (error) {
        if ((error as { code?: string }).code !== "ESRCH") throw error;
      }
    };
    signal("SIGTERM");
    await Promise.race([
      new Promise<void>((resolveExit) =>
        server.once("exit", () => resolveExit()),
      ),
      delay(3_000),
    ]);
    if (server.exitCode === null) signal("SIGKILL");
  };

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const pairingToken = await Promise.race([
      readPairingToken(server, () => safeT3StartupDiagnostic(serverOutput)),
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
        if (attempt === 199)
          throw new Error("Isolated T3 did not become ready");
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
      providerHome,
      controlledProviderLog,
      serverLog: () => safeT3StartupDiagnostic(serverOutput),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
};

const NATIVE_CREDENTIAL_PATHS: Readonly<Record<string, readonly string[]>> = {
  "claude-code": [".claude", ".claude.json"],
  codex: [".codex"],
  cursor: [".cursor", ".config/cursor"],
  grok: [".grok"],
  opencode: [".config/opencode", ".local/share/opencode"],
};

/** Copy only one provider identity from the disposable row container. */
export const prepareNativeProviderHome = async (options: {
  readonly driver: string;
  readonly scratch: string;
  readonly sourceHome: string;
}): Promise<void> => {
  const paths = NATIVE_CREDENTIAL_PATHS[options.driver];
  if (paths === undefined) {
    throw new QualificationIsolationError(
      `No isolated credential map exists for '${options.driver}'`,
    );
  }
  const targetHome = join(options.scratch, "provider-home");
  await mkdir(targetHome, { recursive: true });
  for (const relative of paths) {
    const target = join(targetHome, relative);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(options.sourceHome, relative), target, {
      dereference: false,
      filter: async (source) => {
        const metadata = await lstat(source);
        return (
          metadata.isDirectory() ||
          metadata.isFile() ||
          metadata.isSymbolicLink()
        );
      },
      recursive: true,
    });
  }
};

export const makeQualificationScratch = async (): Promise<{
  cleanup(): Promise<void>;
  root: string;
}> => {
  const root = await mkdtemp(join(tmpdir(), "heddle-driver-qualification-"));
  // Retaining scratch state is the only way to read a driver's provider event
  // log after a failure, since the isolated T3 keeps it under its base
  // directory. Opt-in, so ordinary runs still clean up after themselves.
  if (process.env["HEDDLE_QUALIFICATION_KEEP_SCRATCH"] === "1") {
    return {
      cleanup: async () => {
        process.stdout.write(`QUALIFICATION scratch retained at ${root}\n`);
      },
      root,
    };
  }
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

export const QUALIFICATION_CURSOR = {
  displayName: "Workbench Delta",
  driver: "cursor",
  instanceId: "cursor-execution",
} as const;

export const QUALIFICATION_GROK = {
  displayName: "Workbench Epsilon",
  driver: "grok",
  instanceId: "grok-execution",
} as const;

export const QUALIFICATION_OPENCODE = {
  displayName: "Workbench Zeta",
  driver: "opencode",
  instanceId: "opencode-execution",
} as const;

const CONTROLLED_PROVIDER_BINARY = resolve(
  "src/control-plane/fixtures/cursor-agent.mjs",
);

export const CONTROLLED_QUALIFICATION_EXECUTION = {
  config: { binaryPath: CONTROLLED_PROVIDER_BINARY },
  displayName: "Workbench Alpha",
  driver: "cursor",
  instanceId: "claude-execution",
} as const;

export const CONTROLLED_QUALIFICATION_REVIEW = {
  config: { binaryPath: CONTROLLED_PROVIDER_BINARY },
  displayName: "Workbench Beta",
  driver: "cursor",
  instanceId: "claude-review",
} as const;

export const CONTROLLED_QUALIFICATION_SECOND_DRIVER = {
  config: {
    binaryPath: CONTROLLED_PROVIDER_BINARY,
    customModels: ["default"],
  },
  displayName: "Workbench Gamma",
  driver: "grok",
  instanceId: "codex-execution",
} as const;

export const CONTROLLED_QUALIFICATION_INSTANCES = [
  CONTROLLED_QUALIFICATION_EXECUTION,
  CONTROLLED_QUALIFICATION_REVIEW,
  CONTROLLED_QUALIFICATION_SECOND_DRIVER,
] as const;

export const QUALIFICATION_INSTANCES = [
  QUALIFICATION_EXECUTION,
  QUALIFICATION_REVIEW,
  QUALIFICATION_SECOND_DRIVER,
] as const;

/** One configured instance per supported driver, plus a second Claude Code
 * instance so a same-driver, differently-named pair is always present. */
export const QUALIFICATION_ALL_DRIVERS = [
  QUALIFICATION_EXECUTION,
  QUALIFICATION_REVIEW,
  QUALIFICATION_SECOND_DRIVER,
  QUALIFICATION_CURSOR,
  QUALIFICATION_GROK,
  QUALIFICATION_OPENCODE,
] as const;

/**
 * Wait until the named instances have finished discovery. Cursor is
 * consistently the slowest, so a window sized to the others reports it
 * unsupported when it is merely late.
 */
export const readyModelsFor = async (
  client: T3ProviderCatalogReader,
  instances: readonly { readonly instanceId: string }[],
  attempts = 240,
): Promise<Map<string, string>> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const catalog = await client.readProviderCatalog();
    const ready = instances.every((instance) =>
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

/**
 * The least expensive adequate model for each driver, chosen by the operator.
 * Qualification proves the seam, not the model, so a run must not spend on a
 * frontier model to do it. A missing preferred slug stops qualification before
 * dispatch rather than spending provider budget on a catalog fallback.
 */
export const PREFERRED_MODEL_SLUGS: Readonly<Record<string, string>> = {
  "claude-execution": "claude-haiku-4-5",
  "claude-review": "claude-haiku-4-5",
  "codex-execution": "gpt-5.6-luna",
  "cursor-execution": "composer-2.5",
  "grok-execution": "grok-4.6",
  "opencode-execution": "opencode-go/deepseek-v4-flash",
};

export class QualificationModelSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualificationModelSelectionError";
  }
}

/**
 * Resolve the operator-approved least-expensive model for every instance.
 * Qualification must stop before dispatch when the live catalog does not
 * offer that exact slug; selecting another model would spend provider budget
 * without operator approval.
 */
export const preferredModelsFor = async (
  client: T3ProviderCatalogReader,
  instances: readonly { readonly instanceId: string }[],
  attempts = 240,
): Promise<Map<string, string>> => {
  const ready = await readyModelsFor(client, instances, attempts);
  const catalog = await client.readProviderCatalog();
  const resolved = new Map(ready);
  for (const instance of instances) {
    const preferred = PREFERRED_MODEL_SLUGS[instance.instanceId];
    if (preferred === undefined) {
      throw new QualificationModelSelectionError(
        `Provider instance '${instance.instanceId}' has no operator-approved qualification model`,
      );
    }
    const row = catalog.find(
      ({ instanceId }) => instanceId === instance.instanceId,
    );
    if (!row?.models.some(({ slug }) => slug === preferred)) {
      throw new QualificationModelSelectionError(
        `Provider instance '${instance.instanceId}' does not expose operator-approved qualification model '${preferred}'`,
      );
    }
    resolved.set(instance.instanceId, preferred);
  }
  return resolved;
};

/** Observed CLI versions, keyed by instance, as qualification provenance. */
export const observedCliVersions = async (
  client: T3ProviderCatalogReader,
): Promise<Map<string, string | null>> => {
  const catalog = await client.readProviderCatalog();
  return new Map(
    catalog.map((row) => [row.instanceId, row.observedCliVersion]),
  );
};

export const requiredObservedCliVersion = async (
  client: T3ProviderCatalogReader,
  instanceId: string,
): Promise<string> => {
  const version = (await observedCliVersions(client)).get(instanceId);
  if (version === undefined || version === null) {
    throw new Error(`T3 did not report a CLI version for '${instanceId}'`);
  }
  return version;
};

export type NativeDriverEvidence = {
  readonly advanceResult: "review" | null;
  readonly benignFileAction: "native-driver-qualified" | null;
  readonly driver: string;
  readonly listProvidersResult: "selected-generated-alias" | null;
  readonly model: string;
  readonly providerAlias: string;
  readonly providerCliVersion: string;
  readonly providerInstanceId: string;
  readonly result: "passed" | "provider-turn-failed";
  readonly runtimeMode: "full-access";
  readonly spawnResult: "persisted-child-assignment" | null;
  readonly version: 1;
};

/** One non-secret, machine-readable row for the task evidence record. */
export const nativeDriverEvidenceLine = (
  evidence: NativeDriverEvidence,
): string => `HEDDLE_NATIVE_EVIDENCE ${JSON.stringify(evidence)}`;

/**
 * Return a failure row only for T3's explicit provider session/prompt error.
 * A terminal session error or an unfinished turn is not provider evidence.
 */
export const nativeProviderTurnFailureEvidenceLine = (
  thread: T3ShellThread | undefined,
  expectedProvider: string,
  evidence: Omit<NativeDriverEvidence, "result">,
): string | null => {
  const providerFailurePrefix = `Provider adapter request failed (${expectedProvider}) for session/prompt:`;
  if (
    thread === undefined ||
    resolveT3AwarenessPhase(thread) !== "failed" ||
    thread.latestTurn?.state !== "error" ||
    !thread.session?.lastError?.startsWith(providerFailurePrefix)
  ) {
    return null;
  }
  return nativeDriverEvidenceLine({
    advanceResult: evidence.advanceResult,
    benignFileAction: evidence.benignFileAction,
    driver: evidence.driver,
    listProvidersResult: evidence.listProvidersResult,
    model: evidence.model,
    providerAlias: evidence.providerAlias,
    providerCliVersion: evidence.providerCliVersion,
    providerInstanceId: evidence.providerInstanceId,
    result: "provider-turn-failed",
    runtimeMode: evidence.runtimeMode,
    spawnResult: evidence.spawnResult,
    version: evidence.version,
  });
};

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
