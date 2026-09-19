// ---
// relationships:
//   verifies: agent-tools
// ---
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportHookPlugins } from "../dist/index.js";
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "heddle-native-plugins-"));
try {
  const home = join(root, "home");
  const codex = join(home, ".codex");
  const claude = join(home, ".claude");
  await mkdir(codex, { recursive: true });
  await mkdir(claude, { recursive: true });
  const preserved =
    '# Fixture leading comment\nmodel = "fixture-model" # Fixture inline comment\n';
  await writeFile(join(codex, "config.toml"), preserved);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: codex,
    CLAUDE_CONFIG_DIR: claude,
  };
  const run = async (harness, args) =>
    (await exec(harness, args, { cwd: home, env })).stdout;
  const source = join(home, "heddle-plugins");
  await exportHookPlugins(source, "0.0.1");
  for (const harness of ["claude", "codex"]) {
    await exportHookPlugins(source, "0.0.1");
    const version = (await run(harness, ["--version"])).trim();
    await run(harness, ["plugin", "marketplace", "add", join(source, harness)]);
    const install =
      harness === "claude"
        ? ["plugin", "install", "heddle@heddle", "--scope", "user"]
        : ["plugin", "add", "heddle@heddle"];
    await run(harness, install);
    await run(harness, install);
    await exportHookPlugins(source, "0.0.2");
    await run(
      harness,
      harness === "claude" ? ["plugin", "update", "heddle@heddle"] : install,
    );
    const listed = await run(harness, ["plugin", "list", "--json"]);
    const installed = JSON.parse(listed);
    const entries = harness === "claude" ? installed : installed.installed;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].version, "0.0.2");
    console.log(
      JSON.stringify({
        harness,
        version,
        pluginVersion: entries[0].version,
        installedCount: entries.length,
      }),
    );
  }
  const config = await readFile(join(codex, "config.toml"), "utf8");
  assert.ok(
    config.startsWith(preserved),
    "native installer preserves unrelated leading/inline comments",
  );
  assert.ok(
    !config.includes("trusted_hash"),
    "installation does not create separate hook trust",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
