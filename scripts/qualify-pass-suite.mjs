// ---
// relationships:
//   verifies: node-types
// ---
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const exec = promisify(execFile);
const [source, root] = process.argv.slice(2);
if (!source || !root)
  throw new Error("Supply exact T3 source and fresh suite root");
await mkdir(root, { recursive: true });
const manifest = {
  sourceHead: (await exec("git", ["rev-parse", "HEAD"])).stdout.trim(),
  t3Head: (
    await exec("git", ["rev-parse", "HEAD"], { cwd: source })
  ).stdout.trim(),
  harnesses: {
    claude: (await exec("claude", ["--version"])).stdout.trim(),
    codex: (await exec("codex", ["--version"])).stdout.trim(),
  },
  cases: [],
};
const cases = [
  ["claudeAgent", "block"],
  ["codex", "block"],
  ["codex", "allow"],
  ["codex", "reuse"],
  ["claudeAgent", "reuse"],
  ["codex", "kill-mid"],
  ["codex", "kill-terminal"],
  ["claudeAgent", "approval"],
  ["codex", "isolation"],
  ["codex", "observe"],
];
for (const [provider, scenario] of cases) {
  const fixture = join(root, `${provider}-${scenario}`);
  let entry;
  try {
    await exec(process.execPath, [
      "scripts/pass-live-server.mjs",
      source,
      fixture,
      "3987",
      scenario === "observe" ? "untrusted" : "trusted",
    ]);
    const { stdout } = await exec(
      process.execPath,
      ["scripts/qualify-pass-live.mjs", fixture, provider, scenario],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const state = JSON.parse(
      stdout.split("\n").find((line) => line.includes('"fixtureState"')),
    ).fixtureState;
    entry = { provider, scenario, state, exit: 0 };
  } catch (error) {
    await writeFile(join(fixture, "qualification-error.txt"), String(error));
    throw error;
  } finally {
    // Capture descendants before terminating the owned server. Never match by name.
    let parent;
    try {
      parent = Number(await readFile(join(fixture, "server.pid"), "utf8"));
    } catch {
      /* Setup may fail before the server exists. */
    }
    if (parent) {
      const rows = (await exec("ps", ["-eo", "pid=,ppid=,stat=,comm="])).stdout
        .trim()
        .split("\n")
        .map((line) => {
          const [pid, ppid, state, command] = line.trim().split(/\s+/);
          return { pid: Number(pid), ppid: Number(ppid), state, command };
        });
      const owned = new Set([parent]);
      for (;;) {
        const before = owned.size;
        for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid);
        if (owned.size === before) break;
      }
      await writeFile(
        join(fixture, "owned-processes.json"),
        JSON.stringify(
          rows.filter((row) => owned.has(row.pid)),
          null,
          2,
        ),
      );
      for (const pid of [...owned].reverse()) {
        try {
          process.kill(pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      for (const pid of owned) {
        let stat;
        try {
          stat = await readFile(`/proc/${pid}/stat`, "utf8");
        } catch {
          continue;
        }
        if (stat.split(") ")[1][0] !== "Z")
          throw new Error(`Owned process ${pid} still running`);
      }
    }
  }
  manifest.cases.push(entry);
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  console.log(JSON.stringify(entry));
}
