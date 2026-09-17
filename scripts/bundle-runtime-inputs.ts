// ---
// relationships:
//   implements:
//     - github-binding-and-intake
//     - node-types
// ---
// Keep workspace clients inside the distributable while they are not published
// packages. Application modules import their public names normally; this build
// input also keeps the dependency closure present before those modules land.
import "@wyrd-company/github-work";
import "@wyrd-company/t3code-client";
