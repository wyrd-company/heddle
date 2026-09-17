// ---
// relationships:
//   implements: agent-tools
// ---
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify, type TomlTable } from "smol-toml";
import type { ToolBinding } from "./state.js";
export type Harness = "claude" | "codex";
export interface HookBinding extends ToolBinding {
  origin: string;
}
const bindingFile = ".heddle-hook.json";
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
/** Only installs worktree configuration; Codex trust remains the operator's. */
export async function installStopHook(
  worktree: string,
  harness: Harness,
  binding: HookBinding,
): Promise<{ mode: "blocking" | "observation"; files: string[] }> {
  const directory = join(worktree, harness === "claude" ? ".claude" : ".codex");
  await mkdir(directory, { recursive: true });
  const command = `heddle hook stop ${harness}`;
  const file = join(
    directory,
    harness === "claude" ? "settings.local.json" : "hooks.json",
  );
  const source = await readOptional(file);
  const settings = source
    ? (JSON.parse(source) as Record<string, unknown>)
    : {};
  const hooks = (settings["hooks"] ?? {}) as Record<string, unknown[]>;
  const stops = (hooks["Stop"] ?? []) as {
    hooks: { type: string; command?: string }[];
  }[];
  if (
    !stops.some((group) =>
      group.hooks.some(
        (hook) => hook.type === "command" && hook.command === command,
      ),
    )
  )
    stops.push({ hooks: [{ type: "command", command }] });
  hooks["Stop"] = stops;
  settings["hooks"] = hooks;
  await writeFile(file, JSON.stringify(settings, null, 2) + "\n");
  const bindingPath = join(directory, bindingFile);
  await writeFile(bindingPath, JSON.stringify(binding) + "\n", { mode: 0o600 });
  const files = [file, bindingPath];
  if (harness === "codex") {
    const configPath = join(directory, "config.toml");
    const config = parse((await readOptional(configPath)) ?? "");
    const features = (config["features"] ?? {}) as TomlTable;
    features["hooks"] = true;
    config["features"] = features;
    await writeFile(configPath, stringify(config));
    files.push(configPath);
  }
  return { mode: harness === "claude" ? "blocking" : "observation", files };
}
/** Both harnesses use Stop's JSON stdin and decision/reason output. */
export async function runStopHook(
  harness: Harness,
  input: string,
): Promise<Record<string, unknown>> {
  const event = JSON.parse(input) as Record<string, unknown>;
  if (
    event["hook_event_name"] !== "Stop" ||
    typeof event["cwd"] !== "string" ||
    typeof event["session_id"] !== "string" ||
    typeof event["stop_hook_active"] !== "boolean"
  )
    throw new Error("Invalid Stop hook input");
  const directory = join(
    event["cwd"],
    harness === "claude" ? ".claude" : ".codex",
  );
  const binding = JSON.parse(
    await readFile(join(directory, bindingFile), "utf8"),
  ) as HookBinding;
  const response = await fetch(
    new URL(binding.path + "/policy", binding.origin),
    {
      headers: { authorization: `Bearer ${binding.token}` },
      redirect: "error",
    },
  );
  if (!response.ok)
    throw new Error(
      `Cannot read handoff requirement (${String(response.status)})`,
    );
  const policy = (await response.json()) as {
    policy: string;
    requirement: string;
  };
  if (policy.policy === "allow") return {};
  if (policy.policy !== "require-handoff")
    throw new Error("Unknown turn-end policy");
  return { decision: "block", reason: policy.requirement };
}
export async function hookCli(harness: Harness): Promise<number> {
  try {
    let input = "";
    for await (const chunk of process.stdin) input += String(chunk);
    console.log(JSON.stringify(await runStopHook(harness, input)));
    return 0;
  } catch (error) {
    console.error(
      `Heddle could not check the missing handoff: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
}
