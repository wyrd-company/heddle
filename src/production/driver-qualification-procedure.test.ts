// ---
// relationships:
//   verifies: heddle
// ---

import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

const killFixtureProcessGroup = (processGroupId: number): void => {
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code !== "ESRCH") throw error;
  }
};

const prepareScratchOwnedGate = async () => {
  const root = await mkdtemp(join(tmpdir(), "heddle-owned-t3-command-"));
  const installInvocation = join(root, "install-invocation");
  const gateInvocation = join(root, "gate-invocation");
  const npm = join(root, "npm");
  const npx = join(root, "npx");
  await writeFile(
    npm,
    `#!/usr/bin/env bash
prefix=""
package_source=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)
      prefix="$2"
      shift 2
      ;;
    *)
      package_source="$1"
      shift
      ;;
  esac
done
mkdir -p "$prefix/bin"
printf '#!/usr/bin/env bash\\nexit 0\\n' > "$prefix/bin/t3"
chmod +x "$prefix/bin/t3"
printf '%s\\n%s\\n' "$prefix" "$package_source" > "$HEDDLE_INSTALL_INVOCATION"
`,
  );
  await writeFile(
    npx,
    `#!/usr/bin/env bash
printf '%s\\n' "$HEDDLE_T3_INTEGRATION_BINARY" > "$HEDDLE_QUALIFICATION_INVOCATION"
if [ "\${HEDDLE_QUALIFICATION_WAIT:-0}" = 1 ]; then
  trap 'exit 143' TERM
  while true; do sleep 1; done
fi
exit "\${HEDDLE_QUALIFICATION_EXIT_CODE:-0}"
`,
  );
  await chmod(npm, 0o755);
  await chmod(npx, 0o755);

  const env = {
    ...process.env,
    HEDDLE_INSTALL_INVOCATION: installInvocation,
    HEDDLE_QUALIFICATION_INVOCATION: gateInvocation,
    PATH: `${root}:${process.env["PATH"] ?? ""}`,
    TMPDIR: root,
  };
  delete env["HEDDLE_T3_INTEGRATION_BINARY"];
  return { env, gateInvocation, installInvocation, root };
};

describe("driver qualification procedure", () => {
  it("routes the documented pinned-T3 gate through one worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-pinned-t3-command-"));
    try {
      const invocation = join(root, "invocation");
      const npx = join(root, "npx");
      const t3 = join(root, "t3");
      await writeFile(
        npx,
        `#!/usr/bin/env bash
printf 'FORCE_COLOR=%s\\n' "\${FORCE_COLOR-unset}" > "$HEDDLE_QUALIFICATION_INVOCATION"
printf 'NO_COLOR=%s\\n' "\${NO_COLOR-unset}" >> "$HEDDLE_QUALIFICATION_INVOCATION"
printf '%s\\n' "$@" >> "$HEDDLE_QUALIFICATION_INVOCATION"
`,
      );
      await writeFile(t3, "#!/usr/bin/env bash\nexit 0\n");
      await chmod(npx, 0o755);
      await chmod(t3, 0o755);

      await execute("scripts/deployment/qualify-pinned-t3.sh", [], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          FORCE_COLOR: "1",
          HEDDLE_QUALIFICATION_INVOCATION: invocation,
          HEDDLE_T3_INTEGRATION_BINARY: t3,
          NO_COLOR: "1",
          PATH: `${root}:${process.env["PATH"] ?? ""}`,
        },
      });
      expect((await readFile(invocation, "utf8")).trim().split("\n")).toEqual([
        "FORCE_COLOR=unset",
        "NO_COLOR=unset",
        "vitest",
        "run",
        "src/production/",
        "src/control-plane/",
        "--maxWorkers=1",
      ]);

      const { stderr } = await execute("task", ["--dry", "test:pinned-t3"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HEDDLE_T3_INTEGRATION_BINARY: "/tmp/fixture-t3",
        },
      });
      expect(stderr).toContain("scripts/deployment/qualify-pinned-t3.sh");

      const procedure = await readFile(
        "docs/operators/driver-qualification.md",
        "utf8",
      );
      expect(procedure).toContain("task test:pinned-t3");
      expect(procedure).toContain(
        "The pinned-T3 target creates a uniquely named scratch prefix",
      );
      expect(
        procedure.match(
          /scripts\/deployment\/qualify-native-driver\.sh codex/g,
        ),
      ).toHaveLength(1);
      expect(procedure).not.toContain("${SCRATCH}");
      expect(procedure).toContain("For `task test:pinned-t3` failures only");
      expect(procedure).toMatch(/does not\s+retain native-row state/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("installs pinned T3 in an owned scratch prefix and removes it", async () => {
    const fixture = await prepareScratchOwnedGate();
    try {
      await execute("scripts/deployment/qualify-pinned-t3.sh", [], {
        cwd: process.cwd(),
        env: fixture.env,
      });
      const [prefix, packageSource] = (
        await readFile(fixture.installInvocation, "utf8")
      )
        .trim()
        .split("\n");
      const supported = JSON.parse(
        await readFile("deployment/supported-versions.json", "utf8"),
      ) as { t3PackageSource: string };
      expect(prefix).toMatch(
        new RegExp(`^${fixture.root}/heddle-pinned-t3\\.[A-Za-z0-9]+/t3$`),
      );
      expect(packageSource).toBe(supported.t3PackageSource);
      expect(await readFile(fixture.gateInvocation, "utf8")).toBe(
        `${prefix}/bin/t3\n`,
      );
      await expect(access(join(prefix!, ".."))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("removes its pinned-T3 scratch prefix when the gate fails", async () => {
    const fixture = await prepareScratchOwnedGate();
    try {
      await expect(
        execute("scripts/deployment/qualify-pinned-t3.sh", [], {
          cwd: process.cwd(),
          env: {
            ...fixture.env,
            HEDDLE_QUALIFICATION_EXIT_CODE: "23",
          },
        }),
      ).rejects.toMatchObject({ code: 23 });
      const [prefix] = (await readFile(fixture.installInvocation, "utf8"))
        .trim()
        .split("\n");
      expect(await readFile(fixture.gateInvocation, "utf8")).toBe(
        `${prefix}/bin/t3\n`,
      );
      await expect(access(join(prefix!, ".."))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("removes its pinned-T3 scratch prefix when interrupted", async () => {
    const fixture = await prepareScratchOwnedGate();
    const child = spawn("scripts/deployment/qualify-pinned-t3.sh", [], {
      cwd: process.cwd(),
      detached: true,
      env: {
        ...fixture.env,
        HEDDLE_QUALIFICATION_WAIT: "1",
      },
      stdio: "ignore",
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>(
      (resolveExit) => {
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
      },
    );
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await access(fixture.gateInvocation);
          break;
        } catch {
          if (attempt === 99) throw new Error("Pinned-T3 gate did not start");
          await delay(10);
        }
      }
      const [prefix] = (await readFile(fixture.installInvocation, "utf8"))
        .trim()
        .split("\n");
      if (child.pid === undefined) throw new Error("Pinned-T3 gate has no PID");
      process.kill(-child.pid, "SIGTERM");

      const outcome = await exited;
      await expect(access(join(prefix!, ".."))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(outcome).toEqual({ code: 143, signal: null });
    } finally {
      if (child.exitCode === null && child.pid !== undefined) {
        killFixtureProcessGroup(child.pid);
        await exited;
      }
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("refuses a non-executable pinned-T3 path", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-unusable-t3-command-"));
    try {
      const npx = join(root, "npx");
      const t3 = join(root, "t3");
      await writeFile(npx, "#!/usr/bin/env bash\nexit 0\n");
      await writeFile(t3, "not executable\n");
      await chmod(npx, 0o755);

      await expect(
        execute("scripts/deployment/qualify-pinned-t3.sh", [], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HEDDLE_T3_INTEGRATION_BINARY: t3,
            PATH: `${root}:${process.env["PATH"] ?? ""}`,
          },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "HEDDLE_T3_INTEGRATION_BINARY must name an executable pinned T3 binary",
        ),
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
