#!/usr/bin/env node

// ---
// relationships:
//   implements: heddle
// ---

// Resolves the Feature's package inputs to one installation source:
// an explicit https URL or absolute path, or an npm package specifier
// for the published `@wyrd-company/heddle` package.

const packageName = "@wyrd-company/heddle";
const [packageSource, requestedVersion] = process.argv.slice(2);

if (packageSource === undefined || requestedVersion === undefined) {
  fail("usage: resolve-package-source.mjs PACKAGE_SOURCE VERSION");
}

if (packageSource !== "") {
  if (!packageSource.startsWith("/") && !isHttpsUrl(packageSource)) {
    fail("packageSource must be an https URL or an absolute path.");
  }
  process.stdout.write(`${packageSource}\n`);
  process.exit(0);
}

const semver =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

if (requestedVersion.toLowerCase() === "latest") {
  process.stdout.write(`${packageName}@latest\n`);
} else if (semver.test(requestedVersion)) {
  process.stdout.write(`${packageName}@${requestedVersion}\n`);
} else {
  fail(
    `Heddle package version is not valid SemVer: ${JSON.stringify(requestedVersion)}.`,
  );
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function fail(message) {
  process.stderr.write(`[heddle] ERROR: ${message}\n`);
  process.exit(1);
}
