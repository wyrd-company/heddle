// ---
// relationships:
//   implements: command-line-interface
// ---
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { bindingConfigSchema } from "../binding/config.js";

export const AGENT_TOOLS_LISTEN_REQUIRED =
  "agentTools.listen.port is required when the service starts passes";

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_DATABASE_NAME = "heddle.sqlite";

const model = z.object({
  instanceId: z.string().min(1),
  model: z.string().min(1),
});
const serviceConfigSchema = bindingConfigSchema.extend({
  projects: z.array(bindingConfigSchema.shape.projects.element).default([]),
  state: z.object({ databasePath: z.string().min(1).optional() }).default({}),
  polling: z
    .object({
      intervalMs: z.number().int().positive().default(DEFAULT_POLL_INTERVAL_MS),
    })
    .default({ intervalMs: DEFAULT_POLL_INTERVAL_MS }),
  intake: z
    .object({ blueprintId: z.string().min(1), commit: z.string().min(1) })
    .optional(),
  pass: z
    .object({
      defaultModel: model,
      defaultWorktree: z.string().min(1),
    })
    .optional(),
  agentTools: z
    .object({
      listen: z.object({
        host: z.string().trim().min(1).default("127.0.0.1"),
        port: z.number().int().min(1).max(65535),
      }),
    })
    .optional(),
  notifications: z
    .object({ pushoverCredentialFile: z.string().min(1) })
    .optional(),
});

export type ServiceConfig = z.infer<typeof serviceConfigSchema>;

export interface StartOverrides {
  configPath?: string;
  stateDirectory?: string;
  databasePath?: string;
  pollingIntervalMs?: number;
  githubCredentialFile?: string;
  t3TokenFile?: string;
  webhookSecretFile?: string;
}

export interface ResolvedServiceConfig extends ServiceConfig {
  configPath: string;
  stateDirectory: string;
  databasePath: string;
  polling: { intervalMs: number };
}

export function defaultConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return join(
    environment["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"),
    "heddle",
    "config.yml",
  );
}

export function defaultStateDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return join(
    environment["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"),
    "heddle",
  );
}

export function resolveServiceConfig(
  overrides: StartOverrides = {},
): ResolvedServiceConfig {
  const configPath = resolve(overrides.configPath ?? defaultConfigPath());
  let source: unknown;
  try {
    source = parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot load Heddle configuration ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const parsed = serviceConfigSchema.safeParse(source);
  if (!parsed.success)
    throw new Error(
      `Invalid Heddle configuration ${configPath}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  if (
    (parsed.data.projects.length > 0 || parsed.data.pass !== undefined) &&
    parsed.data.agentTools === undefined
  )
    throw new Error(
      `Invalid Heddle configuration ${configPath}: ${AGENT_TOOLS_LISTEN_REQUIRED}`,
    );
  const stateDirectory = resolve(
    overrides.stateDirectory ?? defaultStateDirectory(),
  );
  const configuredDatabase =
    overrides.databasePath ?? parsed.data.state.databasePath;
  const databasePath = resolve(
    configuredDatabase ?? join(stateDirectory, DEFAULT_DATABASE_NAME),
  );
  return {
    ...parsed.data,
    configPath,
    stateDirectory,
    databasePath,
    polling: {
      intervalMs: overrides.pollingIntervalMs ?? parsed.data.polling.intervalMs,
    },
    github: {
      credentialFile:
        overrides.githubCredentialFile ?? parsed.data.github.credentialFile,
    },
    t3Code: {
      ...parsed.data.t3Code,
      ...(overrides.t3TokenFile === undefined
        ? {}
        : { tokenFile: overrides.t3TokenFile }),
    },
    ...(parsed.data.webhook === undefined &&
    overrides.webhookSecretFile === undefined
      ? {}
      : {
          webhook: {
            ...parsed.data.webhook,
            secretFile:
              overrides.webhookSecretFile ??
              parsed.data.webhook?.secretFile ??
              "",
          },
        }),
  };
}
