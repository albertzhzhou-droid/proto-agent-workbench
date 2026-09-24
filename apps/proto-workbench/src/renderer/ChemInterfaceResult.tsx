import {Pause,Play,SkipBack,SkipForward} from 'lucide-react';
import {useEffect,useState} from 'react';
import {ChemKineticsChart} from './ChemKineticsChart.tsx';
import {ChemDataChart} from './ChemDataChart.tsx';
import {ChemReactionScene} from './ChemReactionScene.tsx';
import {CHEM_SERIES_COLORS,scientificNumber} from './chem-reaction-view.ts';
import type {ChemInterfaceResult as InterfaceResult} from './chem-interface-view.ts';

export function ChemInterfaceResult({result,active=true}:{result:InterfaceResult;active?:boolean}){
  const [index,setIndex]=useState(0),[playing,setPlaying]=useState(false);
  useEffect(()=>{if(!active)setPlaying(false);},[active]);
  useEffect(()=>{setIndex(0);setPlaying(false);},[result]);
  useEffect(()=>{if(!playing||!active)return;const timer=window.setInterval(()=>setIndex(previous=>{if(previous>=result.time_s.length-1){setPlaying(false);return previous;}return previous+1;}),70);return()=>window.clearInterval(timer);},[playing,active,result]);
  const select=(value:number)=>{setPlaying(false);setIndex(value);};
  return <section className="chem-interface-result" aria-label="Interface simulation result">
    <div className="chem-saved-result-context"><span>Calculated trajectory · {result.time_s.length} samples · {scientificNumber(result.time_s.at(-1))} s</span></div>
    {result.surface_scene&&<ChemReactionScene surface={result.surface_scene} index={index} active={active}/>}
    {result.surface_scene&&<div className="chem-live-species">{result.surface_scene.species.map((species,i)=><div key={species.id}><i style={{background:CHEM_SERIES_COLORS[i%CHEM_SERIES_COLORS.length]}}/><span>{species.id.replaceAll('_',' ')}</span><strong>{scientificNumber(species.coverage[index]*100)}<small>% of sites</small></strong></div>)}<div><span>Vacant</span><strong>{scientificNumber((1-result.surface_scene.species.reduce((sum,species)=>sum+species.coverage[index],0))*100)}<small>% of sites</small></strong></div></div>}
    <div className="chem-playback"><button type="button" aria-label="First interface frame" onClick={()=>select(0)}><SkipBack size={15}/></button><button type="button" aria-label={playing?'Pause interface playback':'Play interface playback'} onClick={()=>{if(index===result.time_s.length-1)setIndex(0);setPlaying(value=>!value);}}>{playing?<Pause size={15}/>:<Play size={15}/>}</button><button type="button" aria-label="Next interface frame" disabled={index===result.time_s.length-1} onClick={()=>select(Math.min(index+1,result.time_s.length-1))}><SkipForward size={15}/></button><input type="range" aria-label="Interface simulation timeline" min="0" max={result.time_s.length-1} value={index} onChange={event=>select(Number(event.target.value))}/><output>{scientificNumber(result.time_s[index])} s</output><span className="chem-result-note">Sample playback</span></div>
    {result.profiles&&<ChemDataChart title={`Film concentration profile · ${scientificNumber(result.time_s[index])} s`} data={{x_label:'Distance from surface',x_unit:'m',y_label:'Concentration',y_unit:'mol m⁻³',series:[{id:'film',label:'Film',x:result.profiles.distance_m,y:result.profiles.concentration_mol_m3[index]}]}}/>}
    <div className="chem-kinetic-charts">{result.charts.map(chart=><ChemKineticsChart key={chart.id} title={chart.title} unit={chart.unit} time={result.time_s} series={chart.series} index={index} onIndex={select}/>)}</div>
  </section>;
}
