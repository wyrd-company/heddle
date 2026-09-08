// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

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
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("refuses to skip the pinned-T3 gate when its binary is absent", async () => {
    const env = { ...process.env };
    delete env["HEDDLE_T3_INTEGRATION_BINARY"];

    await expect(
      execute("scripts/deployment/qualify-pinned-t3.sh", [], {
        cwd: process.cwd(),
        env,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "HEDDLE_T3_INTEGRATION_BINARY must name an executable pinned T3 binary",
      ),
    });
  });

  it("refuses a non-executable pinned-T3 path", async () => {
    await expect(
      execute("scripts/deployment/qualify-pinned-t3.sh", [], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HEDDLE_T3_INTEGRATION_BINARY: "/tmp/missing-fixture-t3",
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "HEDDLE_T3_INTEGRATION_BINARY must name an executable pinned T3 binary",
      ),
    });
  });
});
