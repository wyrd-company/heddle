// ---
// relationships:
//   implements:
//     - github-client
//     - github-binding-and-intake
// ---
// Refreshes src/github/schema/github.graphql from the live GitHub GraphQL API.
// Requires GITHUB_TOKEN in the environment. Any token with read access works.
import { writeFile } from "node:fs/promises";
import { buildClientSchema, getIntrospectionQuery, printSchema } from "graphql";

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN is not set");
  process.exit(1);
}

const response = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: getIntrospectionQuery({ descriptions: true }) }),
});
const payload = await response.json();
if (!response.ok || payload.errors) {
  console.error(JSON.stringify(payload.errors ?? payload, null, 2));
  process.exit(1);
}

const target = new URL("../schema/github.graphql", import.meta.url);
await writeFile(target, printSchema(buildClientSchema(payload.data)));
console.log(`wrote ${target.pathname}`);
