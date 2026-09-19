// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLUEPRINT_AUTHORING_SKILL,
  BLUEPRINT_AUTHOR_REFERENCE,
} from "./generated/blueprint-authoring.js";

const embeddedSkills = {
  "blueprint-authoring": {
    document: BLUEPRINT_AUTHORING_SKILL,
    references: {
      "blueprint-author-reference.md": BLUEPRINT_AUTHOR_REFERENCE,
    },
  },
} as const;

export type EmbeddedSkillName = keyof typeof embeddedSkills;

export const listEmbeddedSkills = (): readonly EmbeddedSkillName[] =>
  Object.keys(embeddedSkills) as EmbeddedSkillName[];

export function exportEmbeddedSkill(name: string, directory: string): void {
  if (!Object.hasOwn(embeddedSkills, name))
    throw new Error(`Unknown embedded skill: ${name}`);
  const skill = embeddedSkills[name as EmbeddedSkillName];
  const target = join(directory, name);
  mkdirSync(join(target, "references"), { recursive: true });
  writeFileSync(join(target, "SKILL.md"), skill.document);
  for (const [file, content] of Object.entries(skill.references))
    writeFileSync(join(target, "references", file), content);
}
