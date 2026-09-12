#!/usr/bin/env node

// ---
// relationships:
//   implements: heddle
// ---

const [packageSource, requestedVersion, apiBase = "https://api.github.com"] =
  process.argv.slice(2);

if (packageSource === undefined || requestedVersion === undefined) {
  fail("usage: resolve-package-source.mjs PACKAGE_SOURCE VERSION [API_BASE]");
}

if (packageSource !== "") {
  if (!packageSource.startsWith("/") && !isHttpsUrl(packageSource)) {
    fail("packageSource must be an https URL or an absolute path.");
  }
  process.stdout.write(`${packageSource}\n`);
  process.exit(0);
}

const semver =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

try {
  if (requestedVersion.toLowerCase() !== "latest") {
    if (!semver.test(requestedVersion)) {
      fail(
        `Heddle package version is not valid SemVer: ${JSON.stringify(requestedVersion)}.`,
      );
    }
    process.stdout.write(`${releaseAssetUrl(requestedVersion)}\n`);
    process.exit(0);
  }

  const releases = await listReleases(apiBase);
  const release = releases.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      typeof candidate.tag_name === "string" &&
      candidate.tag_name.startsWith("heddle@") &&
      semver.test(candidate.tag_name.slice("heddle@".length)),
  );
  if (release === undefined) {
    fail("No Heddle package releases exist in the heddle@* tag namespace.");
  }

  const version = release.tag_name.slice("heddle@".length);
  const assetName = `heddle-${version}.tgz`;
  const asset = Array.isArray(release.assets)
    ? release.assets.find((candidate) => candidate?.name === assetName)
    : undefined;
  if (asset === undefined || !isHttpsUrl(asset.browser_download_url)) {
    fail(
      `Release ${release.tag_name} does not contain the required asset ${assetName}.`,
    );
  }
  process.stdout.write(`${asset.browser_download_url}\n`);
} catch (error) {
  fail(
    `Unable to resolve the latest Heddle package release: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function releaseAssetUrl(version) {
  return `https://github.com/wyrd-company/heddle/releases/download/heddle@${version}/heddle-${version}.tgz`;
}

async function listReleases(base) {
  const releases = [];
  let url = new URL("/repos/wyrd-company/heddle/releases?per_page=100", base);
  for (;;) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "heddle-devcontainer-feature",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(
        `GitHub releases request failed with HTTP ${response.status}.`,
      );
    }
    const page = await response.json();
    if (!Array.isArray(page)) {
      throw new Error("GitHub returned an invalid releases response.");
    }
    releases.push(...page);
    const next = nextLink(response.headers.get("link"));
    if (next === undefined) return releases;
    url = new URL(next);
  }
}

function nextLink(header) {
  if (header === null) return undefined;
  for (const entry of header.split(",")) {
    const match = entry.match(/^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/u);
    if (match?.[2] === "next") return match[1];
  }
  return undefined;
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
