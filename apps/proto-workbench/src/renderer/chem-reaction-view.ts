/** Presentation data only. All concentrations and rates come from a saved backend run. */
export type { ChemMolecule } from '../shared/chem-science.ts';
import type { ChemSimulationInput, ChemReactionNetwork, ChemSimulationResult } from '../shared/chem-science.ts';
export type ChemReactionResult = ChemSimulationResult;
export const CHEM_SERIES_COLORS = ['#688dba','#c28b58','#789773','#ac7eac','#77a3a3','#b3a269','#a78383','#858db7'];
export function isReactionResult(value:unknown):value is ChemReactionResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<ChemReactionResult>;
  return Array.isArray(result.time_s) && result.time_s.length > 0 && Array.isArray(result.series) && !!result.network;
}
/** Restore the saved request together with its resolved example network, never the current editor. */
export function restoreSimulationInput(input:Record<string,unknown>,value:unknown):ChemSimulationInput {
  const result=isReactionResult(value)?value:undefined;
  const network=input.network??result?.network;
  if(!network||typeof network!=='object'||!Array.isArray((network as ChemReactionNetwork).species)||!Array.isArray((network as ChemReactionNetwork).reactions))throw new Error('This run has no saved reaction network to restore. Its original input remains available in the run evidence.');
  const numberOr=(requested:unknown,effective:number|undefined,fallback:number)=>typeof requested==='number'&&Number.isFinite(requested)?requested:effective??fallback;
  const example=typeof input.example==='string'&&['reversible','consecutive','parallel','catalytic','interface'].includes(input.example)?input.example as ChemSimulationInput['example']:undefined;
  return {
    ...(example?{example}:{}),
    network:structuredClone(network as ChemReactionNetwork),
    duration_s:numberOr(input.duration_s,result?.time_s.at(-1),30),
    points:numberOr(input.points,result?.time_s.length,121),
    temperature_k:numberOr(input.temperature_k,result?.temperature_k,298.15),
  };
}
export function scientificNumber(value:number|null|undefined):string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  return value === 0 ? '0' : Math.abs(value) < 0.001 || Math.abs(value) >= 10000 ? value.toExponential(3) : Number(value.toPrecision(5)).toString();
}
export function reactionCsv(result:ChemReactionResult):string {
  const quote = (value:string) => `"${value.replaceAll('"','""')}"`;
  const headings = ['time_s', ...result.series.map(s=>`${s.id}_concentration_M`), ...result.reaction_rates.map(s=>`${s.id}_rate_M_s`), ...result.series.filter(s=>s.conversion).map(s=>`${s.id}_conversion`)];
  return [headings.map(quote).join(','), ...result.time_s.map((time,index)=>[time,...result.series.map(s=>s.concentration[index]),...result.reaction_rates.map(s=>s.rate[index]),...result.series.filter(s=>s.conversion).map(s=>s.conversion![index])].map(value=>Number.isFinite(value)?String(value):'').join(','))].join('\r\n');
}
export function downloadChemFile(name:string, content:string, type='application/json'):void {
  const url=URL.createObjectURL(new Blob([content],{type}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
