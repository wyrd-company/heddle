// ---
// relationships:
//   enforces: github-client
// ---
import config from "../codegen.ts";

const hookLocations = [];

if (Object.hasOwn(config, "hooks")) {
  hookLocations.push("hooks");
}

for (const [outputPath, outputConfig] of Object.entries(config.generates)) {
  if (
    !Array.isArray(outputConfig) &&
    typeof outputConfig === "object" &&
    outputConfig !== null &&
    Object.hasOwn(outputConfig, "hooks")
  ) {
    hookLocations.push(`generates[${JSON.stringify(outputPath)}].hooks`);
  }
}

if (hookLocations.length > 0) {
  console.error(
    `GraphQL Code Generator lifecycle hooks are prohibited: ${hookLocations.join(", ")}`,
  );
  process.exitCode = 1;
}
