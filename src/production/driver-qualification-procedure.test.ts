// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

describe("driver qualification procedure", () => {
  it("routes the documented pinned-T3 gate through one worker", async () => {
    const { stderr } = await execute("task", ["--dry", "test:pinned-t3"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HEDDLE_T3_INTEGRATION_BINARY: "/tmp/fixture-t3",
      },
    });
    expect(stderr).toContain(
      "npx vitest run src/production/ src/control-plane/ --maxWorkers=1",
    );

    const procedure = await readFile(
      "docs/operators/driver-qualification.md",
      "utf8",
    );
    expect(procedure).toContain("task test:pinned-t3");
  });

  it("refuses to skip the pinned-T3 gate when its binary is absent", async () => {
    const env = { ...process.env };
    delete env["HEDDLE_T3_INTEGRATION_BINARY"];

    await expect(
      execute("task", ["test:pinned-t3"], { cwd: process.cwd(), env }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "HEDDLE_T3_INTEGRATION_BINARY must name the pinned T3 binary",
      ),
    });
  });
});
