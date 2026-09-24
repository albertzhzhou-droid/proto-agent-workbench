import catalog from "./design-skills.json" with { type: "json" };
import type { ModuleSettings } from "./modules.ts";

export const DESIGN_SKILLS = catalog;
export function normalizeDesignSkills(ids: string[] = []): string[] {
  return [...new Set(ids)].filter(id => DESIGN_SKILLS.some(skill => skill.id === id));
}

/** Only the reviewed, bundled registry can contribute workflow instructions. */
export function designSkillInstructions(settings: ModuleSettings): string {
  const selected = new Set(normalizeDesignSkills(settings.enabledSkills));
  return DESIGN_SKILLS.filter(skill => selected.has(skill.id)).map(skill =>
    `Enabled workflow skill: ${skill.name} (${skill.id}@${skill.version}; source SHA-256 ${skill.sourceSha256})\n${skill.instructions}`,
  ).join("\n\n");
}
