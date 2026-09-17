// ---
// relationships:
//   verifies: agent-tools
// ---
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  symlink,
  writeFile,
  readFile,
  copyFile,
  chmod,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { exportHookPlugins } from "../dist/index.js";

/** Fixture-only native profile isolation; credential bytes never enter this process. */
export async function fixtureProfiles(root, { trusted = false } = {}) {
  const nativeHome = homedir();
  const home = join(root, "home");
  const codex = join(home, ".codex");
  const claude = join(home, ".claude");
  const bin = join(root, "bin");
  for (const path of [codex, claude, bin])
    await mkdir(path, { recursive: true });
  await symlink(join(nativeHome, ".codex/auth.json"), join(codex, "auth.json"));
  await symlink(
    join(nativeHome, ".claude/.credentials.json"),
    join(claude, ".credentials.json"),
  );
  await copyFile(resolve("dist/cli.js"), join(bin, "heddle"));
  await chmod(join(bin, "heddle"), 0o755);
  const schemas = join(root, "docs/specifications");
  await mkdir(schemas, { recursive: true });
  for (const name of ["blueprint.schema.yml", "policy-rule.schema.yml"])
    await copyFile(resolve("docs/specifications", name), join(schemas, name));
  await symlink(resolve("node_modules"), join(root, "node_modules"));
  await writeFile(
    join(codex, "config.toml"),
    "[features]\nhooks = true\nplugins = true\n",
  );
  const env = {
    PATH: bin + ":" + process.env.PATH,
    HOME: home,
    CODEX_HOME: codex,
    CLAUDE_CONFIG_DIR: claude,
    HEDDLE_STATE_DIR: root,
  };
  const source = join(root, "packages");
  await exportHookPlugins(source);
  const exec = promisify(execFile);
  const smoke = exec(join(bin, "heddle"), ["hook", "stop", "codex"], { env });
  smoke.child.stdin.end(
    JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "fixture-smoke",
    }),
  );
  await smoke;
  for (const harness of ["claude", "codex"]) {
    await exec(
      harness,
      ["plugin", "marketplace", "add", join(source, harness)],
      { env, cwd: home },
    );
    await exec(
      harness,
      harness === "claude"
        ? ["plugin", "install", "heddle@heddle", "--scope", "user"]
        : ["plugin", "add", "heddle@heddle"],
      { env, cwd: home },
    );
  }
  if (trusted) {
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
    const config = join(codex, "config.toml");
    await writeFile(
      config,
      (await readFile(config, "utf8")) +
        `\n[hooks.state."heddle@heddle:hooks/hooks.json:stop:0:0"]\ntrusted_hash=${JSON.stringify(hash)}\n`,
    );
  }
  return env;
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const root = process.argv[2];
  if (!root) throw new Error("Fixture root required");
  const env = await fixtureProfiles(root, {
    trusted: process.argv.includes("--trusted"),
  });
  await writeFile(
    join(root, "profile-env.json"),
    JSON.stringify(env, null, 2) + "\n",
  );
  console.log(join(root, "profile-env.json"));
}
