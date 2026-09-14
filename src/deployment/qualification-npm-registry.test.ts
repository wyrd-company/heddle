// ---
// relationships:
//   verifies: heddle
// ---

import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const registryScript = "scripts/deployment/qualification-npm-registry.mjs";
const packageName = "@wyrd-company/heddle";
const version = "7.8.9";

let directory = "";
let tarballPath = "";
let tarballDigest = "";
let registry: ReturnType<typeof spawn> | undefined;
let registryUrl = "";
let registryLog = "";
let userConfig = "";
let globalConfig = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "heddle-npm-registry-"));
  tarballPath = join(directory, "fixture.tgz");
  // The registry serves whatever bytes it is given; npm verifies the
  // packument's integrity against them, so any tarball content will do.
  await writeFile(tarballPath, `fixture tarball ${Math.random()}`);
  tarballDigest = createHash("sha256")
    .update(await readFile(tarballPath))
    .digest("hex");

  // The installer must win over an npmrc that maps the scope elsewhere, so
  // the test process gets an isolated npm configuration with an adversarial
  // mapping instead of relying on whatever the host happens to configure.
  userConfig = join(directory, "user.npmrc");
  globalConfig = join(directory, "global.npmrc");
  await writeFile(
    userConfig,
    "@wyrd-company:registry=http://127.0.0.1:9/\nregistry=http://127.0.0.1:9/\n",
  );
  await writeFile(globalConfig, "");

  registry = spawn(process.execPath, [registryScript, tarballPath, version], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  registry.stdout?.on("data", (chunk: Buffer) => {
    registryLog += chunk.toString();
  });
  const port = await new Promise<string>((resolve, reject) => {
    const onData = () => {
      const [firstLine] = registryLog.split("\n");
      if (firstLine !== undefined && /^[0-9]+$/u.test(firstLine)) {
        registry?.stdout?.off("data", onData);
        resolve(firstLine);
      }
    };
    registry?.stdout?.on("data", onData);
    registry?.on("exit", (code) =>
      reject(new Error(`registry exited early with ${code}`)),
    );
  });
  registryUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  registry?.kill();
  await rm(directory, { force: true, recursive: true });
});

async function pack(spec: string, destination: string) {
  return execute(
    "npm",
    [
      "pack",
      "--silent",
      "--json",
      "--ignore-scripts",
      "--registry",
      registryUrl,
      `--@wyrd-company:registry=${registryUrl}`,
      "--pack-destination",
      destination,
      spec,
    ],
    {
      env: {
        ...process.env,
        NPM_CONFIG_FETCH_RETRIES: "0",
        NPM_CONFIG_GLOBALCONFIG: globalConfig,
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
        NPM_CONFIG_USERCONFIG: userConfig,
      },
    },
  );
}

describe("qualification npm registry", () => {
  it("serves the packed tarball as latest and as the exact version", async () => {
    for (const spec of [`${packageName}@latest`, `${packageName}@${version}`]) {
      const destination = await mkdtemp(join(directory, "pack-"));
      const { stdout } = await pack(spec, destination);
      const [packed] = JSON.parse(stdout) as Array<{
        filename: string;
        name: string;
        version: string;
      }>;

      expect(packed).toMatchObject({
        filename: `wyrd-company-heddle-${version}.tgz`,
        name: packageName,
        version,
      });
      const fetched = await readFile(join(destination, packed!.filename));
      expect(createHash("sha256").update(fetched).digest("hex")).toBe(
        tarballDigest,
      );
    }
    expect(registryLog).toContain(
      `GET /${packageName}/-/heddle-${version}.tgz\n`,
    );
  });

  it("would follow the adversarial scope mapping without the scope override", async () => {
    const destination = await mkdtemp(join(directory, "pack-"));

    await expect(
      execute(
        "npm",
        [
          "pack",
          "--silent",
          "--json",
          "--ignore-scripts",
          "--registry",
          registryUrl,
          "--pack-destination",
          destination,
          `${packageName}@${version}`,
        ],
        {
          env: {
            ...process.env,
            NPM_CONFIG_FETCH_RETRIES: "0",
            NPM_CONFIG_GLOBALCONFIG: globalConfig,
            NPM_CONFIG_UPDATE_NOTIFIER: "false",
            NPM_CONFIG_USERCONFIG: userConfig,
          },
        },
      ),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining("http://127.0.0.1:9/"),
    });
  });

  it("names a missing version as an npm target failure", async () => {
    const destination = await mkdtemp(join(directory, "pack-"));

    await expect(
      pack(`${packageName}@9.9.9`, destination),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('"code": "ETARGET"'),
    });
  });
});
