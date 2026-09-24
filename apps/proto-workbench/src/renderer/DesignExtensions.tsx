import { useEffect, useState } from "react";
import { BookOpen, Boxes, Check, Search, ShieldCheck } from "lucide-react";
import { DESIGN_SKILLS } from "../shared/design-skills.ts";
import { CORE_MODULES, OPTIONAL_MODULES, type OptionalModuleId } from "../shared/modules.ts";
import { useWorkbenchStore } from "./store.ts";
import { workbenchDataMode } from "./mock-api.ts";

const sameSelection = (left: string[], right: string[]) => [...left].sort().join("\0") === [...right].sort().join("\0");

export function DesignExtensions() {
  const settings = useWorkbenchStore(state => state.settings);
  const integrity = useWorkbenchStore(state => state.moduleIntegrity);
  const updateSettings = useWorkbenchStore(state => state.updateSettings);
  const running = useWorkbenchStore(state => state.isAgentRunning);
  const [plugins, setPlugins] = useState(settings.modules.enabledOptional);
  const [skills, setSkills] = useState(settings.modules.enabledSkills ?? []);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { setPlugins(settings.modules.enabledOptional); setSkills(settings.modules.enabledSkills ?? []); }, [settings.modules]);
  const dirty = !sameSelection(plugins, settings.modules.enabledOptional) || !sameSelection(skills, settings.modules.enabledSkills ?? []);
  const preview = workbenchDataMode() === "preview";
  const matches = (name: string, description: string) => `${name} ${description}`.toLowerCase().includes(query.toLowerCase());
  const visiblePlugins = OPTIONAL_MODULES.filter(item => matches(item.label, item.description));
  const visibleSkills = DESIGN_SKILLS.filter(item => matches(item.name, item.description));
  const availability = (id: string) => integrity.modules.find(module => module.moduleId === id);
  const canEnable = (id: string) => ["verified", "not-audited"].includes(availability(id)?.status ?? "missing");
  const togglePlugin = (id: OptionalModuleId, checked: boolean) => setPlugins(current => checked ? [...new Set([...current, id])] : current.filter(item => item !== id));
  const toggleSkill = (id: string, checked: boolean) => setSkills(current => checked ? [...new Set([...current, id])] : current.filter(item => item !== id));
  const apply = async () => {
    setSaving(true);
    try { await updateSettings({ modules: { profile: "custom", enabledOptional: plugins.filter(canEnable), enabledSkills: skills } }); }
    finally { setSaving(false); }
  };
  return <div className="extensions-page operational-page">
    <header className="extensions-heading"><div><span className="eyebrow">DESIGN WORKSPACE</span><h1>Plugins & Skills</h1><p>Choose the tools and workflow guidance available to your next task.</p></div>
      <div className="extension-count"><strong>{settings.modules.enabledOptional.length + (settings.modules.enabledSkills?.length ?? 0)}</strong><span>enabled</span></div>
    </header>
    <div className="extensions-toolbar"><label className="extensions-search"><Search size={15}/><input aria-label="Search plugins and skills" placeholder="Search plugins and skills" value={query} onChange={event => setQuery(event.target.value)}/></label><span>{OPTIONAL_MODULES.length} plugins · {DESIGN_SKILLS.length} skills</span></div>
    {visiblePlugins.length > 0 && <section className="extension-section" aria-labelledby="plugins-title"><div className="extension-section-heading"><Boxes size={18}/><div><h2 id="plugins-title">Plugins</h2><p>Enable the tools your design and analysis workflow needs.</p></div></div>
      <div className="extension-grid">{visiblePlugins.map(item => {
        const available = canEnable(item.id);
        const enabled = settings.modules.enabledOptional.includes(item.id as OptionalModuleId);
        return <label key={item.id} className={`extension-card ${plugins.includes(item.id as OptionalModuleId) ? "is-selected" : ""}`}>
          <div className="extension-card-heading"><Boxes size={17}/><strong>{item.label}</strong><input type="checkbox" aria-label={`Enable ${item.label}`} checked={plugins.includes(item.id as OptionalModuleId)} disabled={!available || running || saving} onChange={event => togglePlugin(item.id as OptionalModuleId, event.target.checked)}/></div>
          <p>{item.description}</p><div className="extension-card-meta"><span>{!available ? "Unavailable" : plugins.includes(item.id as OptionalModuleId) !== enabled ? (plugins.includes(item.id as OptionalModuleId) ? "Will enable" : "Will disable") : enabled ? "Enabled" : "Disabled"}</span><code>v{item.version}</code></div>
          <small>{preview ? "Preview registry" : availability(item.id)?.status === "verified" ? "Installed · integrity verified" : "Development module"} · {item.tools.length} tool{item.tools.length === 1 ? "" : "s"}</small>
        </label>;
      })}</div>
    </section>}
    {visibleSkills.length > 0 && <section className="extension-section" aria-labelledby="skills-title"><div className="extension-section-heading"><BookOpen size={18}/><div><h2 id="skills-title">Workflow skills</h2><p>Bundled Proto skills. Enabled instructions are included in new desktop missions.</p></div></div>
      <div className="extension-grid">{visibleSkills.map(item => <label key={item.id} className={`extension-card ${skills.includes(item.id) ? "is-selected" : ""}`}>
        <div className="extension-card-heading"><BookOpen size={17}/><strong>{item.name}</strong><input type="checkbox" aria-label={`Enable ${item.name}`} checked={skills.includes(item.id)} disabled={running || saving} onChange={event => toggleSkill(item.id, event.target.checked)}/></div>
        <p>{item.description}</p><div className="extension-card-meta"><span>{skills.includes(item.id) !== Boolean(settings.modules.enabledSkills?.includes(item.id)) ? (skills.includes(item.id) ? "Will enable" : "Will disable") : settings.modules.enabledSkills?.includes(item.id) ? "Enabled" : "Disabled"}</span><code>v{item.version}</code></div>
        <small title={`${item.sourcePath} · SHA-256 ${item.sourceSha256}`}>Installed · bundled from repository</small>
      </label>)}</div>
    </section>}
    {visiblePlugins.length === 0 && visibleSkills.length === 0 && <p className="extension-empty">No plugins or skills match this search.</p>}
    <details className="extension-core"><summary><ShieldCheck size={16}/> Core modules <span>{CORE_MODULES.length} required</span></summary><div>{CORE_MODULES.map(item => <p key={item.id}><strong>{item.label}</strong><span>{item.description}</span><small>{availability(item.id)?.status ?? "Not checked"}</small></p>)}</div></details>
    <footer className="extension-apply-bar"><div><strong>{dirty ? `${plugins.length + skills.length} selected` : "Selection saved"}</strong><span>{running ? "A task is running. Change the selection after it finishes." : preview ? "Preview preferences apply to this session. Desktop settings persist for future tasks." : "Applies to new tasks. Core validation and review remain required."}</span></div>
      <button className="secondary-button" type="button" disabled={!dirty || saving} onClick={() => {setPlugins(settings.modules.enabledOptional);setSkills(settings.modules.enabledSkills ?? []);}}>Reset</button>
      <button className="primary-button" type="button" disabled={!dirty || saving || running} onClick={() => void apply()}><Check size={15}/>{saving ? "Applying…" : "Apply selection"}</button>
    </footer>
  </div>;
}
