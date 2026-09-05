import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, FileJson } from "lucide-react";
import type { AgentRunEvent } from "../shared/contracts.ts";

const PAGE_CHARACTERS = 12_000;
export function RunOperationDetails({event}: {event?: AgentRunEvent}) {
  const [tab, setTab] = useState<"output" | "input">("output");
  const [page, setPage] = useState(0);
  useEffect(() => {setPage(0); setTab("output");}, [event?.id]);
  const audit = event?.payload;
  const text = useMemo(() => {
    const value = tab === "input" ? audit?.input : audit?.output ?? audit?.error;
    return value === undefined ? "No result has been recorded yet." : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }, [audit, tab]);
  if (!event?.tool || audit?.auditSchema !== "proto-workbench.tool-execution.v1") return null;
  const pages = Math.max(1, Math.ceil(text.length / PAGE_CHARACTERS));
  const visiblePage = Math.min(page, pages - 1);
  const digest = tab === "input" ? audit.inputSha256 : audit.outputSha256 ?? audit.errorSha256;
  return <section className="run-operation-details" aria-label="Selected operation data">
    <header><div><FileJson size={16}/><strong>{event.title.replace(/^proto_/, "").replaceAll("_", " ")}</strong><span>{event.status.replaceAll("-", " ")}</span></div><div className="operation-data-tabs" role="group" aria-label="Operation data view">{(["output", "input"] as const).map(value => <button key={value} type="button" aria-pressed={value === tab} onClick={() => {setTab(value); setPage(0);}}>{value === "output" ? "Result" : "Arguments"}</button>)}</div></header>
    <pre tabIndex={0} aria-label={`${tab === "output" ? "Recorded result" : "Recorded arguments"}, page ${visiblePage + 1} of ${pages}`}>{text.slice(visiblePage * PAGE_CHARACTERS, (visiblePage + 1) * PAGE_CHARACTERS)}</pre>
    <footer><span title={typeof digest === "string" ? digest : undefined}>{typeof digest === "string" ? `Recorded SHA-256 · ${digest.slice(0, 12)}` : "No digest recorded"}</span><div><button type="button" aria-label="Previous result page" disabled={visiblePage === 0} onClick={() => setPage(visiblePage - 1)}><ChevronLeft size={14}/></button><span>{visiblePage + 1} / {pages}</span><button type="button" aria-label="Next result page" disabled={visiblePage + 1 >= pages} onClick={() => setPage(visiblePage + 1)}><ChevronRight size={14}/></button></div></footer>
  </section>;
}
