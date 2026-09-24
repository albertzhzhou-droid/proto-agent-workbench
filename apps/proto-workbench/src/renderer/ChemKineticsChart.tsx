import { CHEM_SERIES_COLORS, scientificNumber } from './chem-reaction-view.ts';

export interface ChemChartSeries { id:string; label?:string; values:Array<number|null>; color?:string; pointsOnly?:boolean }
export function ChemKineticsChart({title,unit,time,series,index,onIndex,axisLabel='Time'}:{title:string;unit:string;time:number[];series:ChemChartSeries[];index:number;onIndex?:(index:number)=>void;axisLabel?:string}){
  const width=640,height=240,left=62,top=20,right=20,bottom=43;
  const available=series.filter(s=>s.values.some(v=>v!==null&&Number.isFinite(v)));
  const values=available.flatMap(s=>s.values.filter((v):v is number=>v!==null&&Number.isFinite(v)));
  const low=Math.min(0,...values),high=Math.max(0,...values),range=high-low||1;
  const t0=time[0]||0,tMax=time.at(-1)||1;
  const x=(t:number)=>left+(t-t0)/(tMax-t0||1)*(width-left-right);
  const y=(value:number)=>top+(1-(value-low)/range)*(height-top-bottom);
  const ticks=[0,.25,.5,.75,1];
  return <section className="chem-chart-card" aria-label={`${title} chart`}>
    <header><h3>{title}</h3><span>{unit}</span></header>
    {available.length?<><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} over ${axisLabel.toLowerCase()}. Selected ${axisLabel.toLowerCase()} ${scientificNumber(time[index])} seconds.`} onPointerDown={event=>{if(!onIndex)return;const rect=event.currentTarget.getBoundingClientRect();const position=Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width));const target=t0+Math.max(0,Math.min(1,(position*width-left)/(width-left-right)))*(tMax-t0);let best=0;for(let i=1;i<time.length;i++)if(Math.abs(time[i]-target)<Math.abs(time[best]-target))best=i;onIndex(best);}}>
      {ticks.map(f=><g key={f}><line className="chem-chart-grid" x1={left} y1={y(low+range*f)} x2={width-right} y2={y(low+range*f)}/><text x={left-9} y={y(low+range*f)+4} textAnchor="end">{scientificNumber(low+range*f)}</text><text x={x(t0+(tMax-t0)*f)} y={height-22} textAnchor="middle">{scientificNumber(t0+(tMax-t0)*f)}</text></g>)}
      <text className="chem-chart-axis-title" x={(width+left-right)/2} y={height-4} textAnchor="middle">{axisLabel} / s</text>
      {available.map((s,si)=>{let previous=false;const path=s.values.map((value,i)=>{if(value===null||!Number.isFinite(value)){previous=false;return '';}const command=previous?'L':'M';previous=true;return `${command}${x(time[i]??0).toFixed(2)},${y(value).toFixed(2)}`;}).join(' ');const color=s.color||CHEM_SERIES_COLORS[si%CHEM_SERIES_COLORS.length];return <g key={s.id}>{s.pointsOnly?s.values.map((v,i)=>v!==null&&Number.isFinite(v)?<circle key={i} cx={x(time[i]??0)} cy={y(v)} r="4" fill={color}/>:null):<path d={path} stroke={color} fill="none" strokeWidth="2.2" vectorEffect="non-scaling-stroke"/>}{s.values[index]!==null&&s.values[index]!==undefined&&<circle cx={x(time[index]||0)} cy={y(s.values[index]!)} r="4" fill={color}/>}</g>;})}
      <line className="chem-chart-cursor" x1={x(time[index]||0)} x2={x(time[index]||0)} y1={top} y2={height-bottom}/>
    </svg><div className="chem-chart-legend">{available.map((s,si)=><span key={s.id}><i style={{background:s.color||CHEM_SERIES_COLORS[si%CHEM_SERIES_COLORS.length]}}/>{s.label||s.id}<b>{scientificNumber(s.values[index])}</b></span>)}</div></>:<p className="chem-result-note">No values are defined for this metric. Conversion requires a nonzero initial concentration.</p>}
  </section>;
}
