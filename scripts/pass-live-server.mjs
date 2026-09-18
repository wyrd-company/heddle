// ---
// relationships:
//   verifies: node-types
// ---
import { mkdir, writeFile, symlink, open } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { fixtureProfiles } from "./pass-fixture-profiles.mjs";
const [source, root, port = "3987", mode = "trusted"] = process.argv.slice(2);
if (!source || !root)
  throw new Error("Supply T3 source and fresh fixture root");
const workspace = join(root, "workspace"),
  home = join(root, "t3"),
  profile = join(root, "profile");
for (const path of [workspace, home, join(root, "service")])
  await mkdir(path, { recursive: true });
await symlink(resolve("node_modules"), join(root, "node_modules"));
const exec = promisify(execFile);
await exec("git", ["init", "-q", workspace]);
await exec("git", [
  "-C",
  workspace,
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.test",
  "commit",
  "--allow-empty",
  "-qm",
  "fixture",
]);
const profileEnv = await fixtureProfiles(profile, {
  trusted: mode === "trusted",
});
const env = { ...process.env, ...profileEnv };
await writeFile(join(root, "profile-env.json"), JSON.stringify(profileEnv));
const tokenFile = join(root, "token");
const token = await exec(
  process.execPath,
  [
    "apps/server/src/bin.ts",
    "auth",
    "session",
    "issue",
    "--base-dir",
    home,
    "--label",
    "pass-fixture",
    "--token-only",
  ],
  { cwd: source, env },
);
await writeFile(tokenFile, token.stdout.trim(), { mode: 0o600 });
const log = await open(join(root, "server.log"), "a");
const server = spawn(
  process.execPath,
  [
    "apps/server/src/bin.ts",
    "serve",
    "--port",
    port,
    "--host",
    "127.0.0.1",
    "--base-dir",
    home,
    "--log-level",
    "warn",
    workspace,
  ],
  { cwd: source, env, detached: true, stdio: ["ignore", log.fd, log.fd] },
);
server.unref();
await log.close();
await writeFile(join(root, "server.pid"), String(server.pid));
await writeFile(
  join(root, "connection.json"),
  JSON.stringify({
    t3Url: `http://127.0.0.1:${port}`,
    tokenFile,
    workspace,
    profile,
    state: join(root, "service"),
    port: Number(port) + 1,
    t3Head: (
      await exec("git", ["rev-parse", "HEAD"], { cwd: source })
    ).stdout.trim(),
    hookMode: mode,
  }),
);
console.log(JSON.stringify({ root, serverPid: server.pid, t3Port: port }));
