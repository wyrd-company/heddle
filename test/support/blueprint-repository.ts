// ---
// relationships:
//   verifies: blueprint-authoring
// ---
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function fixtureGit(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
export function commitFixture(root: string): string {
  fixtureGit(root, "init", "-q");
  fixtureGit(root, "add", ".");
  fixtureGit(
    root,
    "-c",
    "user.name=Example",
    "-c",
    "user.email=example@example.invalid",
    "commit",
    "-qm",
    "Update sample",
  );
  return fixtureGit(root, "rev-parse", "HEAD");
}
export function writeSample(root: string, edition: string, prefix = ""): void {
  writeFileSync(
    join(root, "sample-process.yml"),
    `# Keep this authored comment.\nid: sample-process\nkind: process\nnodes:\n  inspect:\n    uses: pass\n    params:\n      prompt: { inline: Open the parcel. }\n      handoff:\n        type: object\n        description: Submit the result.\n        properties:\n          accepted: { type: boolean }\n        required: [accepted]\n  measure:\n    uses: pass\n    params:\n      prompt: ${prefix}parcel.njk\n      handoff: ${prefix}receipt.yml\n  choose:\n    uses: policy\n    params:\n      rules: ${prefix}routing.yml\n      input: { from: stages }\n  finish:\n    uses: terminal-result\n    params:\n      value: ${edition}-graph\nedges:\n${["inspect", "measure"].flatMap((node) => ["handoff", "escalate", "timeout", "idle", "turnEnded", "overridden"].map((result) => `  - from: ${node}\n    to: ${node === "inspect" ? "measure" : "choose"}\n    when: result.output.${result}\n`)).join("")}  - from: choose\n    to: finish\n`,
  );
  writeFileSync(join(root, "parcel.njk"), `Inspect the ${edition} parcel.\r\n`);
  writeFileSync(
    join(root, "receipt.yml"),
    `type: object\ndescription: Record the ${edition} receipt.\nproperties:\n  ${edition}: { type: boolean }\nrequired: [${edition}]\nadditionalProperties: false\n`,
  );
  writeFileSync(
    join(root, "routing.yml"),
    `rules:\n  - id: ${edition}\n    blueprint: sample-process\n    inputs: {}\n`,
  );
}
