// ---
// relationships:
//   verifies: heddle
// ---

// A minimal npm registry for deployment qualification. It serves one packed
// `@wyrd-company/heddle` tarball as the package's only version and as its
// `latest` dist-tag, so the Feature's default and exact-version resolution can
// be proven without publishing to a public registry.
//
// usage: qualification-npm-registry.mjs TARBALL_PATH PACKAGE_VERSION
// Prints the bound port on the first line, then one line per served request.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import process from "node:process";

const [tarballPath, packageVersion] = process.argv.slice(2);
if (tarballPath === undefined || packageVersion === undefined) {
  process.stderr.write(
    "usage: qualification-npm-registry.mjs TARBALL_PATH PACKAGE_VERSION\n",
  );
  process.exit(1);
}

const packageName = "@wyrd-company/heddle";
const tarballName = `heddle-${packageVersion}.tgz`;
const tarballRoute = `/${packageName}/-/${tarballName}`;
const tarball = readFileSync(tarballPath);
const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
const shasum = createHash("sha1").update(tarball).digest("hex");

const server = createServer((request, response) => {
  const route = decodeURIComponent(request.url ?? "/");
  process.stdout.write(`${request.method} ${route}\n`);
  if (request.method !== "GET") {
    response.writeHead(405).end();
    return;
  }
  if (route === `/${packageName}`) {
    const host = request.headers.host ?? "127.0.0.1";
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        "dist-tags": { latest: packageVersion },
        name: packageName,
        versions: {
          [packageVersion]: {
            dist: {
              integrity,
              shasum,
              tarball: `http://${host}${tarballRoute}`,
            },
            name: packageName,
            version: packageVersion,
          },
        },
      }),
    );
    return;
  }
  if (route === tarballRoute) {
    response
      .writeHead(200, { "content-type": "application/octet-stream" })
      .end(tarball);
    return;
  }
  response
    .writeHead(404, { "content-type": "application/json" })
    .end(JSON.stringify({ error: "Not found" }));
});

server.listen(0, "0.0.0.0", () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The qualification npm registry did not bind a TCP port.");
  }
  process.stdout.write(`${address.port}\n`);
});
