import test from 'node:test';
import assert from 'node:assert/strict';
import { reactionCsv, restoreSimulationInput, scientificNumber } from '../src/renderer/chem-reaction-view.ts';

test('kinetic CSV preserves sample times, all rates and undefined product conversion',()=>{
  const result={time_s:[0,.25,1],series:[{id:'A',concentration:[1,.9,.7],conversion:[0,.1,.3]},{id:'B',concentration:[0,.1,.3],conversion:[null,null,null]}],reaction_rates:[{id:'r1',rate:[.4,.36,.28]},{id:'r2',rate:[0,.01,.03]}]};
  const rows=reactionCsv(result).split('\r\n');
  assert.equal(rows[0],'"time_s","A_concentration_M","B_concentration_M","r1_rate_M_s","r2_rate_M_s","A_conversion","B_conversion"');
  assert.equal(rows[1],'0,1,0,0.4,0,0,');
  assert.equal(rows[2],'0.25,0.9,0.1,0.36,0.01,0.1,');
  assert.equal(rows[3],'1,0.7,0.3,0.28,0.03,0.3,');
});
test('missing values are visually distinct from a computed zero',()=>{
  assert.equal(scientificNumber(0),'0');
  assert.equal(scientificNumber(null),'—');
  assert.equal(scientificNumber(undefined),'—');
  assert.equal(scientificNumber(NaN),'—');
  assert.equal(scientificNumber(.00001234),'1.234e-5');
});
test('reopening a Chat example run restores its exact request and the saved resolved network',()=>{
  const network={label:'Historical reversible model',species:[{id:'A',initial_concentration:1},{id:'B',initial_concentration:0}],reactions:[{id:'forward',reactants:{A:1},products:{B:1},rate_constant:.12}]};
  const result={network,time_s:Array.from({length:51},(_,i)=>i*.4),temperature_k:303.15,series:[]};
  const restored=restoreSimulationInput({example:'reversible',duration_s:20,points:51,temperature_k:303.15},result);
  assert.equal(restored.example,'reversible');
  assert.equal(restored.duration_s,20);
  assert.equal(restored.points,51);
  assert.equal(restored.temperature_k,303.15);
  assert.deepEqual(restored.network,network);
  restored.network.species[0].initial_concentration=2;
  assert.equal(result.network.species[0].initial_concentration,1,'editing restored inputs must not change saved evidence');
});
test('omitted request parameters use the run result instead of current UI or current example defaults',()=>{
  const network={species:[{id:'X',initial_concentration:2}],reactions:[]};
  const restored=restoreSimulationInput({example:'consecutive'},{network,time_s:[0,1.25,2.5,3.75],temperature_k:310,series:[]});
  assert.equal(restored.duration_s,3.75);
  assert.equal(restored.points,4);
  assert.equal(restored.temperature_k,310);
  assert.deepEqual(restored.network,network);
});
test('a custom run restores its supplied network and cannot fall back to unrelated editor state',()=>{
  const network={species:[{id:'custom',initial_concentration:3}],reactions:[]};
  assert.deepEqual(restoreSimulationInput({network,duration_s:10,points:9},undefined),{network,duration_s:10,points:9,temperature_k:298.15});
  assert.throws(()=>restoreSimulationInput({example:'reversible'},undefined),/no saved reaction network/);
});
