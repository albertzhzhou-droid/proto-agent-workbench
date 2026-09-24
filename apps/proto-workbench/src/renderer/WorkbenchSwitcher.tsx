import { Check, ChevronDown, Dna } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ChemWorkbenchIcon } from "./workbench-icons.ts";

export type WorkbenchEdition = "proto" | "chem";

/** Product-level navigation; changing edition does not dispose either workspace. */
export function WorkbenchSwitcher({ edition, onChange }: {edition: WorkbenchEdition; onChange(value: WorkbenchEdition): void}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {if (!container.current?.contains(event.target as Node)) setOpen(false);};
    document.addEventListener("pointerdown", outside);
    container.current?.querySelector<HTMLButtonElement>(`[data-edition="${edition}"]`)?.focus();
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, edition]);
  const choose = (value: WorkbenchEdition) => {onChange(value); setOpen(false); trigger.current?.focus();};
  const Icon = edition === "chem" ? ChemWorkbenchIcon : Dna;
  return <div ref={container} className="workbench-switcher" onKeyDown={event => {
    if (event.key === "Escape") {setOpen(false); trigger.current?.focus();}
    if (open && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = [...container.current!.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
  }}>
    <button ref={trigger} type="button" className="topbar-control workbench-switcher-trigger" aria-label={`Switch workbench: ${edition === "chem" ? "Chem CLI" : "Proto CLI"}`} aria-haspopup="menu" aria-expanded={open} aria-controls="workbench-editions" onClick={() => setOpen(!open)}><Icon size={16}/><span>{edition === "chem" ? "Chem CLI" : "Proto CLI"}</span><ChevronDown size={13}/></button>
    {open && <div id="workbench-editions" className="workbench-editions" role="menu" aria-label="Choose workbench">
      <p className="workbench-switcher-caption">YOUR WORKBENCHES</p>
      {([{id:"proto",title:"Proto CLI",detail:"Biological design & research",icon:Dna},{id:"chem",title:"Chem CLI",detail:"Chemical design & structure",icon:ChemWorkbenchIcon}] as const).map(item => <button key={item.id} data-edition={item.id} type="button" role="menuitemradio" aria-checked={edition === item.id} onClick={() => choose(item.id)}><item.icon size={19}/><span><strong>{item.title}</strong><small>{item.detail}</small></span>{edition === item.id && <Check size={15}/>}</button>)}
    </div>}
  </div>;
}
