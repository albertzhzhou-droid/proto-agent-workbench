import { CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ChemWorkbenchIcon } from "./workbench-icons.ts";
import type { ChemWorkbenchStatus } from "../shared/chem-workbench.ts";
import type { ChemDesignTarget } from './ChemNavigation.tsx';

function checkedFrameUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash || !/^\/[a-f0-9]{32,128}\/$/.test(url.pathname)) throw new Error("Chem returned an invalid local workspace address.");
  return url.href;
}

export function ChemWorkspace({active, theme, sidebarExpanded, workspacePath, target, onTitle}: {active: boolean; theme: "light" | "dark"; sidebarExpanded:boolean; workspacePath: string; target:ChemDesignTarget; onTitle(title: string): void}) {
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState<ChemWorkbenchStatus>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {if (active) setStarted(true);}, [active]);
  useEffect(() => {
    if (!started) return;
    let disposed = false;
    setStatus(undefined); setError(undefined);
    void (async () => {
      const response = window.workbench?.chem ? await window.workbench.chem.open() : await fetch("/__proto/chem", {cache:"no-store"}).then(async result => {
        const payload = await result.json();
        if (!result.ok) throw new Error(payload.error || "Chem could not start.");
        return payload as ChemWorkbenchStatus;
      });
      if (disposed) return;
      if (!response.available || !response.url) throw new Error(response.error || "The configured Chem environment is unavailable.");
      setStatus({...response,url:checkedFrameUrl(response.url)});
    })().catch(reason => {if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));});
    return () => {disposed = true;};
  }, [started, workspacePath, revision]);
  const sendTheme = () => {if (status?.url) frame.current?.contentWindow?.postMessage({type:"proto:chem-theme",theme,sidebarExpanded,hostNavigation:true}, new URL(status.url).origin);};
  const sendNavigation = () => {if(status?.url) frame.current?.contentWindow?.postMessage({type:'proto:chem-navigate',target},new URL(status.url).origin);};
  useEffect(()=>{if(active)sendNavigation();},[status?.url,target,active]);
  useEffect(() => {sendTheme();}, [status?.url, theme, sidebarExpanded]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!status?.url || event.source !== frame.current?.contentWindow || event.origin !== new URL(status.url).origin || !event.data || typeof event.data !== "object") return;
      if (event.data.type === "chem:ready") {sendTheme();sendNavigation();}
      if (event.data.type === "chem:navigation" && typeof event.data.title === "string") onTitle(event.data.title.slice(0,80));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [status?.url, theme, sidebarExpanded, target, onTitle]);
  return <section id="chem-design-workspace" className="chem-workspace-frame" hidden={!active} role="tabpanel" aria-labelledby="mode-design" aria-label="Chem CLI workspace">
    {status?.url ? <iframe key={status.url} ref={frame} src={status.url} title="Chem CLI scientific workspace" sandbox="allow-scripts allow-same-origin allow-downloads allow-modals" onLoad={sendTheme}/> : <div className="chem-startup"><div className="chem-startup-symbol">{error ? <CircleAlert size={25}/> : <ChemWorkbenchIcon size={25}/>}</div><p className="eyebrow">CHEM CLI · LOCAL WORKSPACE</p><h1>{error ? "The chemistry workspace needs attention." : "Opening your chemistry workspace."}</h1><p>{error || "Connecting the chemical design, structure and calculation tools."}</p>{error ? <button className="secondary-button" onClick={() => setRevision(value => value + 1)}><RefreshCw size={15}/>Retry connection</button> : <LoaderCircle className="spin" size={20}/>}</div>}
  </section>;
}
