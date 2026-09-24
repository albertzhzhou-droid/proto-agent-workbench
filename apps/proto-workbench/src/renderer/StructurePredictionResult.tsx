import {useEffect,useMemo,useRef,useState} from "react";
import {MAX_PREDICTION_RESIDUES,predictionPaeCell,predictionPaePixels,predictionResidueLabel,validateStructurePrediction,type StructurePrediction} from "./structure-prediction.ts";
import "./structure-prediction.css";

export interface StructurePredictionResultProps {result:unknown;requested:unknown;receipt:unknown}

/** The caller must first reopen and hash the full JSON with readVerifiedComputeResult. */
export function StructurePredictionResult({result,requested,receipt}:StructurePredictionResultProps) {
  const checked=useMemo(()=>{
    try {return {result:validateStructurePrediction(result,requested,receipt),error:""};}
    catch(error) {return {result:null,error:error instanceof Error?error.message:"Structure import validation failed."};}
  },[result,requested,receipt]);
  if(!checked.result)return <section className="structure-prediction-result" role="alert"><h3>Structure confidence unavailable</h3><p>{checked.error}</p><p>No confidence plot is displayed for an inconsistent result.</p></section>;
  const preview=typeof receipt==="object"&&receipt!==null&&"preview" in receipt&&receipt.preview===true;
  return <PredictionView result={checked.result} preview={preview}/>;
}

function IndexControl({label,value,count,onChange}:{label:string;value:number;count:number;onChange(value:number):void}) {
  const select=(text:string)=>{const next=Number(text);if(text!==""&&Number.isInteger(next)&&next>=0&&next<count)onChange(next);};
  return <div className="prediction-index-control"><label><span>{label} (0-based)</span><input type="number" aria-label={`${label} index`} min={0} max={count-1} step={1} value={value} onChange={event=>select(event.target.value)}/></label><input type="range" aria-label={`${label} slider`} min={0} max={count-1} step={1} value={value} onChange={event=>select(event.target.value)}/></div>;
}

function PredictionView({result,preview}:{result:StructurePrediction;preview:boolean}) {
  const n=result.structure.residue_count,[selected,setSelected]=useState(0),[row,setRow]=useState(0),[column,setColumn]=useState(0);
  const index=Math.min(selected,n-1),rowIndex=Math.min(row,n-1),columnIndex=Math.min(column,n-1);
  const residue=result.structure.residues[index],scores=result.confidence.plddt,pae=result.confidence.pae;
  const cell=predictionPaeCell(result,rowIndex,columnIndex),canvas=useRef<HTMLCanvasElement>(null),[paintError,setPaintError]=useState("");
  const pixels=useMemo(()=>predictionPaePixels(result),[result]);
  useEffect(()=>{
    setPaintError("");
    if(!pixels||!canvas.current)return;
    const context=canvas.current.getContext("2d");
    if(!context){setPaintError("Canvas unavailable. The row and column controls still expose the exact matrix values.");return;}
    const image=context.createImageData(n,n);image.data.set(pixels);context.putImageData(image,0,0);
  },[pixels,n]);
  const x=(i:number)=>44+(n===1?278:i/(n-1)*556),y=(score:number)=>18+(100-score)*1.4;
  const points=scores.values.map((score,i)=>`${x(i)},${y(score)}`).join(" ");
  return <section className="structure-prediction-result" aria-label="Imported structure confidence">
    <header><div><span className="prediction-overline">LOCAL RESULT IMPORT</span><h3>Structure confidence</h3></div><span>{n} residues · {result.structure.chain_count} chain{result.structure.chain_count===1?"":"s"} · model {result.structure.model}</span></header>
    <p className="prediction-scope">{preview?"Example replay — no workspace files verified":"Imported result · Source identities match the execution receipt"}</p>
    <p>Predictor confidence is not experimental accuracy. Importing these files did not execute a prediction.</p>
    <div className="prediction-summary"><span>Mean pLDDT<strong>{scores.mean.toFixed(2)} <small>/ 100</small></strong></span>{(["ptm","iptm"] as const).map(field=><span key={field}>{field==="ptm"?"pTM":"ipTM"}<strong>{result.confidence[field].status==="available"?String(result.confidence[field].value):"Unavailable"}</strong></span>)}</div>
    <section className="prediction-panel" aria-label="Per-residue pLDDT">
      <h4>pLDDT by residue</h4><p>Array indices are 0-based PDB encounter order; they are not PDB residue numbers. Summary mean is rounded to two decimal places.</p>
      <div className="prediction-plot-scroll"><svg className="prediction-plddt" viewBox="0 0 640 205" role="img" aria-label={`pLDDT for ${n} residues, scores from 0 to 100`}>
        <title>Per-residue pLDDT</title><desc>Use the residue slider or numeric index to inspect an exact value and its mapped PDB identity.</desc>
        {[0,25,50,75,100].map(value=><g key={value}><line x1={44} x2={600} y1={y(value)} y2={y(value)} className="prediction-grid"/><text x={34} y={y(value)+4} textAnchor="end">{value}</text></g>)}
        <polyline points={points} fill="none" stroke="#4b91bd" strokeWidth={2}/><line x1={x(index)} x2={x(index)} y1={18} y2={158} className="prediction-selection"/><circle cx={x(index)} cy={y(residue.plddt)} r={4} fill="#4b91bd"/>
        <text x={x(0)} y={177} textAnchor="middle">0</text>{n>1&&<text x={x(n-1)} y={177} textAnchor="middle">{n-1}</text>}<text x={322} y={198} textAnchor="middle">Residue array index (0-based)</text>
      </svg></div>
      <IndexControl label="Residue" value={index} count={n} onChange={setSelected}/>
      <div className="prediction-exact"><strong>pLDDT[{index}] = {String(residue.plddt)} / 100</strong><span>{predictionResidueLabel(residue)}</span><span>PDB CA B-factor pLDDT: {String(residue.pdb_ca_bfactor_plddt)} · Occupancy: {String(residue.identity.occupancy)}</span><span>CA (Å): [{residue.coordinates_angstrom.map(String).join(", ")}]</span></div>
    </section>
    <section className="prediction-panel" aria-label="PAE matrix">
      <h4>Predicted aligned error (PAE)</h4>
      {pae.status==="unavailable"?<div className="prediction-unavailable"><strong>PAE unavailable</strong><p>{pae.reason}. No matrix or inter-residue confidence was inferred.</p></div>:<>
        <p>Original matrix[row][column], in Å. Row order runs downward and column order runs rightward. No transposition, averaging or symmetry is applied; no additional physical row/column meaning is inferred.</p>
        <div className="prediction-matrix-layout"><div className="prediction-matrix-area"><div className="prediction-matrix-column">Column index: 0 → {n-1}</div><div className="prediction-matrix-square">
          <canvas ref={canvas} width={n} height={n} role="img" aria-label={`Original ${n} by ${n} PAE matrix; row and column indices are zero-based`} onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();if(rect.width>0&&rect.height>0){setColumn(Math.min(n-1,Math.max(0,Math.floor((event.clientX-rect.left)/rect.width*n))));setRow(Math.min(n-1,Math.max(0,Math.floor((event.clientY-rect.top)/rect.height*n))));}}}>
            Inspect exact values with the PAE row and column controls.
          </canvas>
          <svg viewBox={`0 0 ${n} ${n}`} aria-hidden="true"><rect x={columnIndex} y={rowIndex} width={1} height={1} fill="none" stroke="white" strokeWidth={0.25}/><rect x={columnIndex} y={rowIndex} width={1} height={1} fill="none" stroke="#111" strokeWidth={0.09}/></svg>
        </div><div className="prediction-matrix-row">Row index: 0 at top → {n-1} at bottom</div><div className="prediction-color-scale" aria-label={`Linear color scale from 0 to ${pae.observed_matrix_max} angstrom`}><span>0 Å</span><i/><span>{String(pae.observed_matrix_max)} Å</span></div><small>Scale uses the observed matrix maximum, not a theoretical error limit.</small></div>
          <div className="prediction-matrix-inspector"><IndexControl label="PAE row" value={rowIndex} count={n} onChange={setRow}/><IndexControl label="PAE column" value={columnIndex} count={n} onChange={setColumn}/>
            {cell&&<div className="prediction-exact" aria-live="polite"><strong>matrix[{rowIndex}][{columnIndex}] = {String(cell.value)} Å</strong><span>Row: {predictionResidueLabel(cell.rowResidue)}</span><span>Column: {predictionResidueLabel(cell.columnResidue)}</span></div>}
            <p>Producer max_pae: {pae.reported_max_pae===null?"Unavailable":`${String(pae.reported_max_pae)} Å`}</p>{paintError&&<p role="status">{paintError}</p>}
          </div></div>
      </>}
    </section>
    <details className="prediction-provenance"><summary>Source identities and mapping limits</summary>
      <p>{preview?"Paths and SHA256 values below belong to the recorded example. Current workspace files were not opened or checked.":"These source paths and SHA256 values match the saved execution receipt. They do not establish that the PDB and scores came from the same prediction run, or that current files remain unchanged."}</p>
      <dl>{(["structure_path","scores_path"] as const).map(field=><div key={field}><dt>{field==="structure_path"?"PDB source":"Scores source"}</dt><dd>{result.sources[field].path}</dd><dt>SHA256</dt><dd>{result.sources[field].sha256}</dd></div>)}</dl>
      <p>Expected sequence: {result.mapping.expected_sequence_status==="not-supplied"?"Not supplied; independent sequence identity is unestablished":"Exact match after ASCII uppercase normalization"}. CA B-factor/pLDDT agreement tolerance: {result.mapping.bfactor_plddt_tolerance}. Same-prediction provenance: unestablished.</p>
      <p>Profile limit: {MAX_PREDICTION_RESIDUES} residues; one model, canonical amino acids, consecutive chain numbering, no insertion codes or alternate locations.</p>
      <ul>{result.limitations.map((item,i)=><li key={i}>{item}</li>)}</ul>
      {result.diagnostics.length>0&&<ul>{result.diagnostics.map((item,i)=><li key={i}><code>{item.code}</code>: {item.message}</li>)}</ul>}
    </details>
  </section>;
}
