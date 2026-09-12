// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { URL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const resolver = ".devcontainer/features/heddle/resolve-package-source.mjs";
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

describe("Heddle package source resolution", () => {
  it("resolves an exact package version without using the Feature version", async () => {
    await expect(execute(resolver, ["", "2.3.4"])).resolves.toMatchObject({
      stdout:
        "https://github.com/wyrd-company/heddle/releases/download/heddle@2.3.4/heddle-2.3.4.tgz\n",
    });
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

  it("selects the newest heddle release and ignores the Feature release unit", async () => {
    const api = await releaseApi([
      { assets: [], tag_name: "heddle-feature@9.0.0" },
      {
        assets: [
          {
            browser_download_url:
              "https://packages.example.invalid/heddle-2.0.0.tgz",
            name: "heddle-2.0.0.tgz",
          },
        ],
        tag_name: "heddle@2.0.0",
      },
      {
        assets: [
          {
            browser_download_url:
              "https://packages.example.invalid/heddle-1.0.0.tgz",
            name: "heddle-1.0.0.tgz",
          },
        ],
        tag_name: "heddle@1.0.0",
      },
    ]);

    await expect(execute(resolver, ["", "latest", api])).resolves.toMatchObject(
      { stdout: "https://packages.example.invalid/heddle-2.0.0.tgz\n" },
    );
  });

  it("continues through every releases page", async () => {
    const api = await paginatedReleaseApi([
      [{ assets: [], tag_name: "heddle-feature@9.0.0" }],
      [
        {
          assets: [
            {
              browser_download_url:
                "https://packages.example.invalid/heddle-3.0.0.tgz",
              name: "heddle-3.0.0.tgz",
            },
          ],
          tag_name: "heddle@3.0.0",
        },
      ],
    ]);

    await expect(execute(resolver, ["", "latest", api])).resolves.toMatchObject(
      { stdout: "https://packages.example.invalid/heddle-3.0.0.tgz\n" },
    );
  });

  it("fails closed when the newest Heddle release has no package asset", async () => {
    const api = await releaseApi([
      { assets: [], tag_name: "heddle@2.0.0" },
      {
        assets: [
          {
            browser_download_url:
              "https://packages.example.invalid/heddle-1.0.0.tgz",
            name: "heddle-1.0.0.tgz",
          },
        ],
        tag_name: "heddle@1.0.0",
      },
    ]);

    await expect(execute(resolver, ["", "latest", api])).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Release heddle@2.0.0 does not contain the required asset heddle-2.0.0.tgz.",
      ),
    });
  });
});

async function releaseApi(releases: unknown[]) {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(releases));
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test release API did not bind a TCP port.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function paginatedReleaseApi(pages: unknown[][]) {
  let api = "";
  const server = createServer((request, response) => {
    const page = Number(
      new URL(request.url ?? "/", api).searchParams.get("page") ?? "1",
    );
    if (page < pages.length) {
      response.setHeader(
        "link",
        `<${api}/repos/wyrd-company/heddle/releases?page=${page + 1}>; rel="next"`,
      );
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(pages[page - 1] ?? []));
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test release API did not bind a TCP port.");
  }
  api = `http://127.0.0.1:${address.port}`;
  return api;
}
