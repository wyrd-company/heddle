// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const resolver = "features/heddle/resolve-package-source.mjs";

describe("Heddle package source resolution", () => {
  it("resolves an exact package version to the published package specifier", async () => {
    await expect(execute(resolver, ["", "2.3.4"])).resolves.toMatchObject({
      stdout: "@wyrd-company/heddle@2.3.4\n",
    });
    await expect(execute(resolver, ["", "3.0.0-rc.1"])).resolves.toMatchObject({
      stdout: "@wyrd-company/heddle@3.0.0-rc.1\n",
    });
  });

  it("resolves latest to the registry dist-tag, independent of the Feature version", async () => {
    for (const requested of ["latest", "LATEST"]) {
      await expect(execute(resolver, ["", requested])).resolves.toMatchObject({
        stdout: "@wyrd-company/heddle@latest\n",
      });
    }
  });

  it("rejects a version that is neither latest nor SemVer", async () => {
    for (const requested of ["", "1", "1.2", "v1.2.3", "^1.2.3", "next"]) {
      await expect(execute(resolver, ["", requested])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          `Heddle package version is not valid SemVer: ${JSON.stringify(requested)}.`,
        ),
      });
    }
  });

  it("lets an https or absolute packageSource override version resolution", async () => {
    for (const source of [
      "https://packages.example.invalid/heddle-build.tgz",
      "/opt/packages/heddle-build.tgz",
    ]) {
      await expect(
        execute(resolver, [source, "not-a-version"]),
      ).resolves.toMatchObject({ stdout: `${source}\n` });
    }
    await expect(
      execute(resolver, [
        "http://packages.example.invalid/heddle.tgz",
        "1.0.0",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "packageSource must be an https URL or an absolute path.",
      ),
    });
  });

  it("never consults a network to resolve a version", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(resolver, "utf8"),
    );

    expect(source).not.toMatch(/\bfetch\(/u);
    expect(source).not.toContain("api.github.com");
    expect(source).not.toContain("releases/download");
  });
});
