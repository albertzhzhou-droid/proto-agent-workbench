import { useEffect, useRef, useState } from "react";
import { Download, GitCompareArrows, LoaderCircle, Play } from "lucide-react";
import type { ComputeRun } from "../shared/compute.ts";
import type { ProteinViewModel } from "./design-visualization.ts";
import { workbenchApi } from "./mock-api.ts";
import { readLocalComputeArtifact } from "./compute-preview.ts";
import { readVerifiedComputeResult } from "./compute-result-reader.ts";
import { linkedProteinPosition, parseProteinAlignment, proteinStudy, proteinTreeLayout, type ProteinStudy } from "./protein-comparison.ts";
import "./protein-comparison.css";

export function ProteinComparisonPanel({proteins, activeProteinId, sourceKey, onSelect}: {
  proteins: ProteinViewModel[]; activeProteinId: string; sourceKey: string;
  onSelect(proteinId: string, position: number): void;
}) {
  const [text,setText]=useState("");
  const [savedText,setSavedText]=useState("");
  const [result,setResult]=useState<{study:ProteinStudy;receipt:ComputeRun}>();
  const [busy,setBusy]=useState(false), [error,setError]=useState("");
  const revision=useRef(0);
  useEffect(()=>{revision.current++;setText("");setSavedText("");setResult(undefined);setBusy(false);setError("");
    return()=>{revision.current++;};},[sourceKey]);
  const run=async()=>{
    const version=revision.current;
    try {
      setError("");
      const records=parseProteinAlignment(text);
      for(const row of records) {
        const matching=proteins.filter(protein=>protein.id===row.name&&protein.sequence===row.sequence.replaceAll("-",""));
        if(matching.length!==1) throw new Error(`${row.name}: the name and ungapped sequence must exactly match one record in this protein artifact.`);
      }
      setBusy(true);
      const receipt=await workbenchApi().compute.run({tool:"analyze_protein_comparison",arguments:{aligned_sequences:records}});
      if(!receipt.ok) throw new Error(receipt.diagnostics?.map(item=>item.message).join(" · ")||"The study did not complete.");
      const read=import.meta.env?.DEV ? readLocalComputeArtifact : workbenchApi().files.read;
      const study=proteinStudy(await readVerifiedComputeResult(receipt,read,"analyze_protein_comparison"),records);
      if(version===revision.current){setResult({study,receipt});setSavedText(text);}
    } catch(e) {if(version===revision.current)setError(e instanceof Error?e.message:String(e));}
    finally {if(version===revision.current)setBusy(false);}
  };
  return <section className="protein-comparison" aria-label="Protein comparative study">
    <header><div><span className="eyebrow">COMPARATIVE RESEARCH</span><h3><GitCompareArrows size={17}/> Compare this collection</h3></div>
      <span>{proteins.length} source {proteins.length===1?"record":"records"}</span></header>
    {proteins.length>=2&&<details open={!result}><summary>Named alignment input</summary>
      <p>Paste an aligned FASTA with the exact protein IDs below. Residues must match their source records after removing gaps. Equal lengths alone do not establish homology.</p>
      <p className="protein-comparison-ids">{proteins.map(protein=><code key={protein.id}>{protein.id}</code>)}</p>
      <label htmlFor="protein-alignment-input">Aligned FASTA</label>
      <textarea id="protein-alignment-input" value={text} maxLength={18000} spellCheck={false} placeholder={">exact-protein-id\nALIGNED-SEQUENCE"} onChange={e=>setText(e.target.value)} disabled={busy}/>
      <div className="protein-comparison-actions"><button type="button" className="quiet-button" disabled={busy||proteins.length<2} onClick={()=>{
        setText(proteins.slice(0,50).map(protein=>`>${protein.id}\n${protein.sequence}`).join("\n"));setError("");
      }}>Insert source sequences</button><button type="button" className="primary-button" disabled={busy||proteins.length<2||!text.trim()} onClick={()=>void run()}>{busy?<LoaderCircle className="spin" size={14}/>:<Play size={14}/>} {busy?"Running study…":"Run comparison"}</button></div>
      <p className="protein-comparison-note">Source sequences are not automatically aligned. Supply a reviewed alignment before running. This study uses the enabled local Compute module.</p>
    </details>}
    {proteins.length<2&&<p role="status">This artifact contains one protein. Open a multi-protein artifact to compare its records.</p>}
    {error&&<p className="analysis-error" role="alert">{error}</p>}
    {result&&<>{text!==savedText&&<p role="status">Input draft changed. The view below still shows the last saved study.</p>}
      <ProteinComparisonResults study={result.study} proteins={proteins} activeProteinId={activeProteinId} onSelect={onSelect}/>
      <p className="protein-comparison-note">{result.receipt.preview?"Recorded example":`Saved study ${result.receipt.run_id}`} · <code>{result.receipt.manifest_path}</code></p>
    </>}
  </section>;
}

export function ProteinComparisonResults({study,proteins=[],activeProteinId,onSelect}: {
  study:ProteinStudy; proteins?:Array<{id:string;sequence:string;sequenceSha256:string}>;
  activeProteinId?:string; onSelect?(id:string,position:number):void;
}) {
  const [column,setColumn]=useState(0),[message,setMessage]=useState("");
  useEffect(()=>{setColumn(0);setMessage("");},[study]);
  const page=Math.floor(column/50)*50, end=Math.min(page+50,study.alignment_length);
  const tree=study.phylogeny?proteinTreeLayout(study.phylogeny.tree_graph,study.alignment.map(row=>row.name)):undefined;
  const select=(name:string,index:number)=>{
    setColumn(index);
    const row=study.alignment.find(item=>item.name===name)!;
    const linked=linkedProteinPosition(row,index,proteins);
    if(linked&&onSelect){onSelect(linked.proteinId,linked.start);setMessage(`${name}: alignment column ${index+1} → sequence residue ${linked.start+1}. Structure selection follows its validated residue mapping.`);}
    else setMessage(`${name}: alignment column ${index+1}${row.alignment_to_sequence[index]===null?" is a gap; no structure residue was selected.":`. Sequence residue ${row.alignment_to_sequence[index]!+1}; no matching design structure is bound in this view.`}`);
  };
  return <div className="protein-study-results">
    <div className="protein-comparison-actions"><label>Alignment column <input aria-label="Alignment column" type="number" min={1} max={study.alignment_length} value={column+1} onChange={e=>{const next=Number(e.target.value)-1;if(Number.isInteger(next)&&next>=0&&next<study.alignment_length){setColumn(next);setMessage("");}}}/></label><span>{study.sequence_count} sequences · {study.alignment_length} columns</span>
      <button type="button" className="quiet-button" onClick={()=>{
        const url=URL.createObjectURL(new Blob([JSON.stringify(study,null,2)],{type:"application/json"}));
        const link=document.createElement("a");link.href=url;link.download="protein-comparison.json";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      }}><Download size={14}/> Study JSON</button></div>
    <p>Columns {page+1}–{end} · Select a residue to inspect its source position.</p>
    <div className="protein-alignment-scroll" tabIndex={0} role="region" aria-label="Linked protein alignment"><table><thead><tr><th scope="col">Protein</th>{study.conservation.columns.slice(page,end).map(item=><th key={item.position} scope="col">{item.position}</th>)}</tr></thead><tbody>
      {study.alignment.map(row=><tr key={row.name} aria-current={row.name===activeProteinId?"true":undefined}><th scope="row">{row.name}</th>{[...row.sequence.slice(page,end)].map((letter,i)=><td key={i}><button type="button" aria-label={`${row.name}, alignment ${page+i+1}, ${letter==="-"?"gap":`${letter}, residue ${row.alignment_to_sequence[page+i]!+1}`}`} aria-pressed={page+i===column} onClick={()=>select(row.name,page+i)}>{letter}</button></td>)}</tr>)}
      <tr><th scope="row">Conservation</th>{study.conservation.columns.slice(page,end).map(item=><td key={item.position}><button type="button" title={`${Math.round(item.conservation_fraction*100)}% of sequences share the consensus; occupancy ${Math.round(item.occupancy_fraction*100)}%`} aria-label={`Column ${item.position}, conservation ${Math.round(item.conservation_fraction*100)} percent`} onClick={()=>{setColumn(item.position-1);setMessage("");}}><span className="conservation-bar" style={{height:`${Math.round(item.conservation_fraction*24)}px`}}/></button></td>)}</tr>
    </tbody></table></div>
    <p role="status" aria-live="polite">{message||`Column ${column+1}: consensus ${study.conservation.columns[column].consensus??"gap"}, conservation ${Math.round(study.conservation.columns[column].conservation_fraction*100)}%.`}</p>
    {study.phylogeny&&tree?<details open><summary>Identity-distance tree</summary><p>{study.phylogeny.method}. Root placement is for display only. {tree.scale==="branch-length"?"Horizontal distances represent branch lengths.":"All branch lengths are zero; horizontal spacing shows topology only."}</p>
      <div className="protein-tree-scroll"><svg viewBox={`0 0 600 ${tree.height}`} role="img" aria-label="Protein comparison tree; tip controls select their sequence at the active alignment column.">
        {tree.nodes.filter(node=>node.parent!==null).map(node=>{const parent=tree.nodes.find(item=>item.id===node.parent)!;return <path key={node.id} d={`M${parent.x} ${parent.y} V${node.y} H${node.x}`} fill="none" stroke="currentColor" strokeWidth="1.2"/>;})}
        {tree.nodes.filter(node=>node.name!==null).map(node=><g key={node.id}><title>{node.name}</title><circle cx={node.x} cy={node.y} r={2}/><text x={node.x+7} y={node.y+4}>{[...node.name!].length>24?[...node.name!].slice(0,21).join("")+"…":node.name}</text></g>)}
      </svg></div><div className="protein-tree-tips" aria-label="Tree tip selection">{study.alignment.map(row=><button type="button" className="quiet-button" key={row.name} onClick={()=>select(row.name,column)}>{row.name}</button>)}</div>
      <details><summary>Newick and branch lengths</summary><pre className="protein-tree-newick">{study.phylogeny.newick_tree}</pre></details><p>Branch lengths are estimates; this tree has no bootstrap support.</p></details>:<p>Two sequences: tree inference requires at least three.</p>}
    <details><summary>Method and interpretation</summary><ul>{study.limitations.map((note,i)=><li key={i}>{note}</li>)}</ul></details>
  </div>;
}
