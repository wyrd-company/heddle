// ---
// relationships:
//   implements: heddle
// ---

const artifactIdPattern = /^[a-z]+(?:-[a-z]+)*$/;

export const isBlueprintArtifactId = (value: string): boolean =>
  artifactIdPattern.test(value);
