import { useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { CHEM_SERIES_COLORS, downloadChemFile, scientificNumber } from './chem-reaction-view.ts';
import { dataVisualizationCsv, type ChemDataVisualization } from './chem-analysis-input.ts';

export function ChemDataChart({data,title,index}:{data:ChemDataVisualization;title:string;index?:number}){
  const svg=useRef<SVGSVGElement>(null),[selected,setSelected]=useState<{series:number;point:number}>();
  const pairs=data.series.flatMap((series,si)=>series.x.flatMap((x,i)=>series.y[i]===null?[]:[{x,y:series.y[i]!,series:si,point:i}]));
  if(!pairs.length)return <p className="chem-result-note">This result has no finite points to plot.</p>;
  const width=690,height=290,left=76,right=23,top=19,bottom=55;
  const bounds=pairs.reduce((b,p)=>({xMin:Math.min(b.xMin,p.x),xMax:Math.max(b.xMax,p.x),yMin:Math.min(b.yMin,p.y),yMax:Math.max(b.yMax,p.y)}),{xMin:Infinity,xMax:-Infinity,yMin:Infinity,yMax:-Infinity});
  const {xMin,xMax,yMin,yMax}=bounds;
  const xPad=xMin===xMax?Math.abs(xMin)*.1||1:0,yPad=(yMax-yMin)*.07||Math.abs(yMin)*.1||1;
  const xLow=xMin-xPad,xHigh=xMax+xPad,yLow=yMin-yPad,yHigh=yMax+yPad;
  const x=(value:number)=>left+(value-xLow)/(xHigh-xLow)*(width-left-right),y=(value:number)=>top+(yHigh-value)/(yHigh-yLow)*(height-top-bottom);
  const axis=(label:string,unit?:string)=>`${label}${unit?` / ${unit}`:''}`;
  const candidate=index===undefined?selected:{series:0,point:index};
  const chosen=candidate&&typeof data.series[candidate.series]?.y[candidate.point]==='number'?candidate:undefined;
  return <section className="chem-chart-card chem-data-chart" aria-label={`${title} chart`}><header><h3>{title}</h3><div className="chem-data-chart-actions"><button title="Export plotted data as CSV" onClick={()=>downloadChemFile('chem-analysis-plot.csv',dataVisualizationCsv(data),'text/csv;charset=utf-8')}><Download size={12}/>CSV</button><button title="Export chart as SVG" onClick={()=>{if(!svg.current)return;const copy=svg.current.cloneNode(true) as SVGSVGElement;copy.setAttribute('xmlns','http://www.w3.org/2000/svg');copy.querySelectorAll('text').forEach(node=>{node.setAttribute('fill','#625e57');node.setAttribute('font-family','monospace');node.setAttribute('font-size','11');});copy.querySelectorAll('.chem-chart-grid').forEach(node=>node.setAttribute('stroke','#ddd9d0'));downloadChemFile('chem-analysis-plot.svg',copy.outerHTML,'image/svg+xml');}}>SVG</button></div></header>
    <svg ref={svg} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}: ${axis(data.y_label,data.y_unit)} against ${axis(data.x_label,data.x_unit)}`} onPointerMove={event=>{const rect=event.currentTarget.getBoundingClientRect(),px=(event.clientX-rect.left)/rect.width*width,py=(event.clientY-rect.top)/rect.height*height;let nearest=pairs[0],distance=Infinity;for(const pair of pairs){const d=(x(pair.x)-px)**2+(y(pair.y)-py)**2;if(d<distance){distance=d;nearest=pair;}}setSelected({series:nearest.series,point:nearest.point});}}>
      {[0,.25,.5,.75,1].map(f=><g key={f}><line className="chem-chart-grid" x1={left} y1={y(yLow+(yHigh-yLow)*f)} x2={width-right} y2={y(yLow+(yHigh-yLow)*f)}/><text x={left-9} y={y(yLow+(yHigh-yLow)*f)+4} textAnchor="end">{scientificNumber(yLow+(yHigh-yLow)*f)}</text><text x={x(xLow+(xHigh-xLow)*f)} y={height-bottom+22} textAnchor="middle">{scientificNumber(xLow+(xHigh-xLow)*f)}</text></g>)}
      <text x={(width+left-right)/2} y={height-6} textAnchor="middle">{axis(data.x_label,data.x_unit)}</text><text transform={`translate(14 ${(height+top-bottom)/2}) rotate(-90)`} textAnchor="middle">{axis(data.y_label,data.y_unit)}</text>
      {data.series.map((series,si)=>{const color=CHEM_SERIES_COLORS[si%CHEM_SERIES_COLORS.length];let previous=false;const path=series.y.map((v,i)=>{if(v===null){previous=false;return '';}const start=previous?'L':'M';previous=true;return`${start}${x(series.x[i])},${y(v)}`;}).join(' ');return <g key={series.id}>{(series.style==='points'||series.y.filter(v=>v!==null).length===1)?series.y.map((v,i)=>v===null?null:<circle key={i} cx={x(series.x[i])} cy={y(v)} r="3.5" fill={color}/>):<path d={path} stroke={color} strokeWidth="2" fill="none"/>}</g>;})}
      {chosen&&<circle cx={x(data.series[chosen.series].x[chosen.point])} cy={y(data.series[chosen.series].y[chosen.point]!)} r="5.5" fill="none" stroke={CHEM_SERIES_COLORS[chosen.series%CHEM_SERIES_COLORS.length]} strokeWidth="2"/>}
    </svg><div className="chem-chart-legend">{data.series.map((series,i)=><span key={series.id}><i style={{background:CHEM_SERIES_COLORS[i%CHEM_SERIES_COLORS.length]}}/>{series.label||series.id}</span>)}</div><p className="chem-chart-reading" aria-live="off">{chosen?`${data.series[chosen.series].label||data.series[chosen.series].id} · ${data.x_label}: ${scientificNumber(data.series[chosen.series].x[chosen.point])} ${data.x_unit||''} · ${data.y_label}: ${scientificNumber(data.series[chosen.series].y[chosen.point])} ${data.y_unit||''}`:'Move across the chart to inspect measured or calculated values.'}</p>
  </section>;
}
