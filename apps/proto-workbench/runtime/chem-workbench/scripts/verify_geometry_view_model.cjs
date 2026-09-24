'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const model=require('../src/chem_workbench/web_assets/geometry-view-model.js');
// Numerical/renderer contract fixtures, never model or scientific acceptance evidence.
const geometry={units:'angstrom',atoms:[
  {id:'site-1',element:'Ba',position:[1000000.000000001,0,0],oxidation_state:2,sublattice:'A'},
  {id:'site-2',element:'Sc',position:[1000000.000000017,2.0925,2.0925],oxidation_state:3,sublattice:'B'},
  {id:'site-3',element:'Nb',position:[4.185,4.185,4.185],oxidation_state:5,sublattice:'Bprime'},
  {id:'site-4',element:'O',position:[2.0925,0,0],oxidation_state:-2,sublattice:'O'}
],cell:[[8.37,0,0],[0,8.37,0],[0,0,8.37]],bonds:[]};
test('inspection preserves every stored coordinate and site property without rounding',()=>{
  const original=JSON.stringify(geometry),rows=model.rows(geometry);
  assert.deepEqual(rows.map(row=>row.position),geometry.atoms.map(atom=>atom.position));
  assert.equal(rows[2].sublattice,'Bprime');assert.equal(rows[2].oxidation_state,5);
  assert.equal(JSON.stringify(geometry),original);
});
test('CSV round-trips stored and transformed numeric values independently',()=>{
  const csv=model.csv(geometry,1.02),lines=csv.trim().split('\r\n');
  const cells=lines[1].split(',').map(text=>text.slice(1,-1));
  assert.equal(Number(cells[2]),geometry.atoms[0].position[0]);
  assert.equal(Number(cells[5]),geometry.atoms[0].position[0]*1.02);
  assert.equal(lines.length,geometry.atoms.length+1);
});
test('distance is computed from stored numbers, without float32 conversion or minimum images',()=>{
  const input=structuredClone(geometry);input.atoms[1].position=[1000000.000000017,0,0];
  const expected=input.atoms[1].position[0]-input.atoms[0].position[0];
  assert.ok(expected>0);assert.equal(model.distance(input,0,1),expected);
  input.atoms[0].position=[0,0,0];input.atoms[1].position=[8.36,0,0];
  assert.equal(model.distance(input,0,1),8.36);
});
test('display scaling changes only the derived coordinates',()=>{
  const rows=model.rows(geometry,0.98);assert.equal(rows[1].displayed_position[1],2.0925*0.98);
  assert.equal(geometry.atoms[1].position[1],2.0925);
});
test('invalid units, nonfinite coordinates and out-of-range bonds fail visibly',()=>{
  for(const mutate of [g=>g.units='bohr',g=>g.atoms[0].position[0]=Infinity,g=>g.cell[1]=[0,1],g=>g.bonds=[{a:0,b:9,order:1}]]){
    const bad=structuredClone(geometry);mutate(bad);assert.throws(()=>model.rows(bad));
  }
  assert.throws(()=>model.rows(geometry,-1));assert.throws(()=>model.rows(geometry,Infinity));
  assert.throws(()=>model.distance(geometry,0,100));
});
test('an input-record geometry requires no invented display-geometry hash',()=>{
  const input={...geometry,geometry_hash:null,input_record_hash:'sha256:input'};
  assert.equal(model.rows(input).length,4);assert.equal(input.geometry_hash,null);
});
test('coordinate CSV and JSON preserve signed zero and escaped atom labels',()=>{
  const input=structuredClone(geometry);input.atoms[0].position[2]=-0;input.atoms[0].id='atom-"quoted"';
  assert.ok(model.csv(input).includes('"-0"'));
  const reopened=JSON.parse(model.stringify(input));assert.ok(Object.is(reopened.atoms[0].position[2],-0));
  assert.equal(reopened.atoms[0].id,input.atoms[0].id);assert.deepEqual(reopened,input);
});
test('CSV neutralizes spreadsheet expressions in labels without changing signed numeric coordinates',()=>{
  const input=structuredClone(geometry);input.atoms[0].id='=1+1';input.atoms[0].position[0]=-1.25;
  assert.ok(model.csv(input).includes('"\'=1+1"'));assert.ok(model.csv(input).includes('"-1.25"'));
  assert.equal(JSON.parse(model.stringify(input)).atoms[0].id,'=1+1');
});
test('imported rendering bounds are checked before viewer loops',()=>{
  for(const repeats of [0,-1,1.5,3,1000000,Infinity,'2'])assert.throws(()=>model.validate({...geometry,display_repeats:repeats}));
  assert.equal(model.validate({...geometry,display_repeats:2}).atoms.length,4);
  assert.throws(()=>model.validate({...geometry,atoms:Array(257).fill(geometry.atoms[0])}));
  assert.throws(()=>model.validate({...geometry,bonds:Array(1025).fill({a:0,b:1,order:1})}));
});
