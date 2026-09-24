import type {ChemReactionNetwork} from '../shared/chem-science.ts';
import type {ChemInterfaceResult} from './chem-interface-view.ts';
import {isChemDataVisualization,type ChemDataVisualization} from './chem-analysis-input.ts';

export type ReactionFamily='network'|'interfaces'|'mechanisms'|'reactors'|'reaction-analysis';
export const REACTION_FAMILIES:Array<{id:ReactionFamily;label:string}>=[
  {id:'network',label:'Reaction networks'},{id:'interfaces',label:'Interface reactions'},
  {id:'mechanisms',label:'Mechanisms'},{id:'reactors',label:'Reactors'},{id:'reaction-analysis',label:'Kinetic analysis'},
];
const STUDY_FAMILIES:Record<string,ReactionFamily>={
  simulate_reversible_chain:'mechanisms',simulate_catalytic_cycle:'mechanisms',
  simulate_cstr:'reactors',simulate_pfr:'reactors',simulate_semibatch:'reactors',
  simulate_nonisothermal_batch:'reactors',simulate_nonisothermal_cstr:'reactors',simulate_tanks_in_series:'reactors',
  simulate_catalyst_deactivation:'mechanisms',simulate_gas_liquid_reaction:'interfaces',simulate_catalyst_pellet:'interfaces',
  simulate_photochemical_isomerization:'mechanisms',simulate_excited_state_quenching:'mechanisms',
  simulate_cyclic_voltammetry:'interfaces',simulate_chronoamperometry:'interfaces',
  fit_arrhenius_eyring:'reaction-analysis',compare_integrated_rate_laws:'reaction-analysis',
  simulate_stochastic_network:'mechanisms',simulate_axial_dispersion:'reactors',simulate_rtd_segregation:'reactors',
  analyze_tracer_rtd:'reaction-analysis',analyze_network_structure:'reaction-analysis',scan_cstr_steady_states:'reactors',
  analyze_reaction_sensitivity:'reaction-analysis',analyze_reaction_flux:'reaction-analysis',propagate_reaction_uncertainty:'reaction-analysis',
  scan_reaction_temperature:'reaction-analysis',fit_reaction_rates:'reaction-analysis',
};
export function reactionStudyFamily(operator:{id:string;category:string}):ReactionFamily|undefined {
  return operator.id==='simulate_reaction_network'?'network':operator.category==='interfaces'?'interfaces':STUDY_FAMILIES[operator.id];
}
/** Explicitly copy the network editor into a study; never mutate either draft. */
export function reactionStudyInputFromNetwork(operator:string,network:ChemReactionNetwork,input:Record<string,unknown>,settings:{duration_s:number;points:number;temperature_k:number}):Record<string,unknown>{
  const result:Record<string,unknown>={...structuredClone(input),network:structuredClone(network),points:Math.min(settings.points,501),temperature_k:settings.temperature_k};
  delete result.example;
  if(operator==='simulate_pfr'){delete result.duration_s;result.residence_time_s=settings.duration_s;}
  else result.duration_s=settings.duration_s;
  if('reaction_ids' in result)result.reaction_ids=network.reactions.filter(reaction=>reaction.rate_constant>0).slice(0,8).map(reaction=>reaction.id);
  if('target_species' in result&&!network.species.some(species=>species.id===result.target_species))result.target_species=network.species[0]?.id;
  if('feed_mol_l' in result)result.feed_mol_l=Object.fromEntries(network.species.map(species=>[species.id,species.initial_concentration]));
  if(operator.startsWith('simulate_nonisothermal_')){
    delete result.temperature_k;result.initial_temperature_k=settings.temperature_k;
    // Heat values belong to a specific stoichiometric reaction, not just its ID.
    // A changed network requires explicit review rather than silently inheriting example heats.
    result.reaction_enthalpy_j_mol=Object.fromEntries(network.reactions.map(reaction=>[reaction.id,null]));
  }
  if(operator==='simulate_rtd_segregation')delete result.duration_s;
  if(operator==='scan_cstr_steady_states'){delete result.duration_s;delete result.points;}
  if(operator==='analyze_network_structure'){delete result.duration_s;delete result.points;delete result.temperature_k;}
  return result;
}
export interface ReactionStudyResult {
  kind:'reaction-study';model:string;title:string;time_s:number[];axis_label:'Time'|'Residence time';
  charts:ChemInterfaceResult['charts'];network:ChemReactionNetwork;
  spatial_profile?:{title:string;x_label:string;x_unit:string;y_label:string;y_unit:string;x:number[];values:number[][]};
  phase_plot?:ChemDataVisualization & {title:string};
}
export function isReactionStudy(value:unknown):value is ReactionStudyResult {
  if(!value||typeof value!=='object')return false;
  const result=value as ReactionStudyResult;
  return result.kind==='reaction-study'&&['Time','Residence time'].includes(result.axis_label)&&Array.isArray(result.time_s)&&result.time_s.length>=2&&
    result.time_s.every((time,index)=>Number.isFinite(time)&&(index===0||time>result.time_s[index-1]))&&
    Array.isArray(result.charts)&&result.charts.length>0&&result.charts.every(chart=>Array.isArray(chart.series)&&chart.series.every(series=>Array.isArray(series.values)&&series.values.length===result.time_s.length&&series.values.every(Number.isFinite)))&&
    Array.isArray(result.network?.species)&&Array.isArray(result.network?.reactions)&&
    (result.spatial_profile===undefined||isSpatialProfile(result.spatial_profile,result.time_s.length))&&
    (result.phase_plot===undefined||isChemDataVisualization(result.phase_plot)&&typeof result.phase_plot.title==='string'&&result.phase_plot.series.length>0&&
      result.phase_plot.series.every(series=>series.x.length===result.time_s.length&&series.y.every(value=>value!==null)));
}

function isSpatialProfile(profile:NonNullable<ReactionStudyResult['spatial_profile']>,samples:number):boolean {
  return !!profile&&typeof profile==='object'&&['title','x_label','x_unit','y_label','y_unit'].every(key=>typeof profile[key as keyof typeof profile]==='string')&&
    Array.isArray(profile.x)&&profile.x.length>0&&profile.x.every((x,i)=>Number.isFinite(x)&&(i===0||x>profile.x[i-1]))&&
    Array.isArray(profile.values)&&profile.values.length===samples&&profile.values.every(row=>Array.isArray(row)&&row.length===profile.x.length&&row.every(Number.isFinite));
}
