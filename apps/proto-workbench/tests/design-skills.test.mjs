import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { DESIGN_SKILLS, designSkillInstructions } from "../src/shared/design-skills.ts";
import { normalizeModuleSettings, isToolEnabledForModules } from "../src/shared/modules.ts";

test("bundled skill instructions match all seven actual repository skills and their references", () => {
  assert.equal(DESIGN_SKILLS.length, 7);
  for (const skill of DESIGN_SKILLS) {
    const file = resolve("../..", skill.sourcePath);
    const bytes = readFileSync(file);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), skill.sourceSha256);
    assert.ok(skill.instructions.startsWith(bytes.toString("utf8").replaceAll("\r\n", "\n")));
    for (const reference of skill.references) {
      assert.equal(createHash("sha256").update(readFileSync(resolve("../..", reference.path))).digest("hex"), reference.sha256);
    }
  }
});

test("selecting and disabling a skill changes mission guidance without enabling additional tools", () => {
  const settings = normalizeModuleSettings({profile: "custom", enabledOptional: [], enabledSkills: ["research-provenance", "research-provenance", "unknown-injected-skill"]});
  assert.deepEqual(settings.enabledSkills, ["research-provenance"]);
  const prompt = designSkillInstructions(settings);
  assert.match(prompt, /Enabled workflow skill:.*research-provenance/);
  assert.ok(prompt.includes(DESIGN_SKILLS.find(skill => skill.id === "research-provenance").instructions));
  assert.ok(!prompt.includes("Enabled workflow skill: Proto Science Workflow"));
  assert.equal(isToolEnabledForModules("proto_pubmed_search", settings), false);
  assert.equal(designSkillInstructions({...settings, enabledSkills: []}), "");
});
