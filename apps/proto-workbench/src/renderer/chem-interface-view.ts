export interface ChemSurfaceCoverage {
  kind: 'surface-coverage';
  description: string;
  species: Array<{id:string;coverage:number[]}>;
}
export interface ChemInterfaceResult {
  kind:'interface-simulation'; model:string; title:string; time_s:number[];
  charts:Array<{id:string;title:string;unit:string;series:Array<{id:string;label:string;values:number[]}>}>;
  surface_scene?:ChemSurfaceCoverage;
  profiles?:{distance_m:number[];concentration_mol_m3:number[][];bulk_concentration_mol_m3:number};
}
export function isInterfaceResult(value:unknown):value is ChemInterfaceResult {
  if(!value||typeof value!=='object')return false;
  const result=value as ChemInterfaceResult;
  return result.kind==='interface-simulation'&&Array.isArray(result.time_s)&&result.time_s.length>=2&&result.time_s.every(Number.isFinite)&&Array.isArray(result.charts)&&result.charts.every(chart=>Array.isArray(chart.series)&&chart.series.every(series=>Array.isArray(series.values)&&series.values.length===result.time_s.length&&series.values.every(Number.isFinite)));
}
/** Largest-remainder rounding includes vacancies, so the display never invents extra sites. */
export function surfaceSiteOccupants(surface:ChemSurfaceCoverage,index:number):number[] {
  const fractions=surface.species.map(species=>Math.max(0,Math.min(1,species.coverage[index]||0)));
  fractions.push(Math.max(0,1-fractions.reduce((sum,value)=>sum+value,0)));
  const total=fractions.reduce((sum,value)=>sum+value,0)||1;
  const quotas=fractions.map(fraction=>fraction/total*100),counts=quotas.map(Math.floor);
  const rank=quotas.map((quota,i)=>({i,remainder:quota-counts[i]})).sort((a,b)=>b.remainder-a.remainder);
  const missing=100-counts.reduce((sum,count)=>sum+count,0);
  for(let i=0;i<missing;i++)counts[rank[i].i]++;
  const occupants=counts.flatMap((count,species)=>Array.from({length:count},()=>species===surface.species.length?-1:species));
  // A fixed permutation distributes occupied sites without implying a molecular trajectory.
  return Array.from({length:100},(_,site)=>occupants[(site*37)%100]);
}
