import {Pause,Play,SkipBack,SkipForward} from 'lucide-react';
import {useEffect,useMemo,useState} from 'react';
import {ChemKineticsChart} from './ChemKineticsChart.tsx';
import {ChemDataChart} from './ChemDataChart.tsx';
import {ChemReactionScene,type ChemPopulationScene} from './ChemReactionScene.tsx';
import {scientificNumber} from './chem-reaction-view.ts';
import {reactionStudyFamily,type ReactionStudyResult} from './chem-reaction-studies.ts';

const terms=(side:Record<string,number>)=>Object.entries(side).map(([id,n])=>`${n===1?'':`${n} `}${id}`).join(' + ');
export function ChemReactionStudyResult({result,active=true}:{result:ReactionStudyResult;active?:boolean}){
  const [index,setIndex]=useState(0),[playing,setPlaying]=useState(false);
  useEffect(()=>{setIndex(0);setPlaying(false);},[result]);
  useEffect(()=>{if(!active)setPlaying(false);},[active]);
  useEffect(()=>{if(!playing||!active)return;const timer=window.setInterval(()=>setIndex(previous=>{if(previous>=result.time_s.length-1){setPlaying(false);return previous;}return previous+1;}),70);return()=>window.clearInterval(timer);},[playing,active,result]);
  const select=(value:number)=>{setPlaying(false);setIndex(value);};
  const scene=useMemo<ChemPopulationScene|undefined>(()=>{
    if(reactionStudyFamily({id:result.model,category:'kinetics'})!=='mechanisms')return;
    const concentrations=result.charts.find(chart=>chart.id==='concentration')?.series;
    if(!concentrations)return;
    return {series:concentrations.map(series=>({id:series.id,label:series.label,concentration:series.values,conversion:series.values.map(()=>null)})),
      scene:{kind:'population-based',description:'Concentration population schematic; no atomic geometry or reaction trajectories.',frames:result.time_s.map((time,i)=>({time_s:time,populations:Object.fromEntries(concentrations.map(series=>[series.id,Math.max(0,series.values[i])]))}))}};
  },[result]);
  return <section className="chem-reaction-study" aria-label="Reaction study result">
    <details className="chem-code-details"><summary>Resolved reaction steps · {result.network.reactions.length}</summary><div className="chem-study-steps">{result.network.reactions.map(reaction=><p key={reaction.id}><code>{reaction.id}</code><span>{terms(reaction.reactants)} → {terms(reaction.products)}</span></p>)}</div></details>
    {scene&&<ChemReactionScene result={scene} index={index} active={active}/>}
    <p className="chem-saved-result-context">{result.time_s.length} calculated samples · {result.axis_label} / s{result.model==='propagate_reaction_uncertainty'?' · Concentration and rate curves use the declared median parameters; uncertainty curves show empirical quantiles.':''}</p>
    <div className="chem-playback"><button aria-label="First reaction study sample" onClick={()=>select(0)}><SkipBack size={15}/></button><button aria-label={playing?'Pause reaction study playback':'Play reaction study playback'} onClick={()=>{if(index===result.time_s.length-1)setIndex(0);setPlaying(value=>!value);}}>{playing?<Pause size={15}/>:<Play size={15}/>}</button><button aria-label="Next reaction study sample" disabled={index===result.time_s.length-1} onClick={()=>select(index+1)}><SkipForward size={15}/></button><input type="range" aria-label="Reaction study timeline" min="0" max={result.time_s.length-1} value={index} onChange={event=>select(Number(event.target.value))}/><output>{scientificNumber(result.time_s[index])} s</output><span className="chem-result-note">Sample playback</span></div>
    <div className="chem-kinetic-charts">{result.phase_plot&&<ChemDataChart title={result.phase_plot.title} data={result.phase_plot} index={index}/>} {result.spatial_profile&&<ChemDataChart title={result.spatial_profile.title} data={{...result.spatial_profile,series:[{id:'profile',label:`${scientificNumber(result.time_s[index])} s`,x:result.spatial_profile.x,y:result.spatial_profile.values[index]}]}}/>}{result.charts.map(chart=><ChemKineticsChart key={chart.id} title={chart.title} unit={chart.unit} time={result.time_s} axisLabel={result.axis_label} series={chart.series} index={index} onIndex={select}/>)}</div>
  </section>;
}
