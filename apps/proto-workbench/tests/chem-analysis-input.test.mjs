import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChemTable,numericColumn,numericValues,replicateValues,molecularRecords,mapChemTable,selectSectionOperators,dataVisualizationCsv,isChemDataVisualization,chemicalTableCsv } from '../src/renderer/chem-analysis-input.ts';

test('CSV import retains quoted chemistry names, escaped quotes, BOM and scientific notation',()=>{
  const table=parseChemTable('\uFEFFname,concentration,response\r\n"compound, A",1e-3,0.05\r\n"compound ""B""",2e-3,0.09',',',true);
  assert.deepEqual(table.columns,['1. name','2. concentration','3. response']);
  assert.equal(table.rows[0][0],'compound, A');assert.equal(table.rows[1][0],'compound "B"');
  assert.deepEqual(numericColumn(table,1),[.001,.002]);
});
test('missing measurements and malformed rows cannot silently become zero or disappear',()=>{
  assert.throws(()=>parseChemTable('x,y\n1,2,3',',',true),/Row 2/);
  assert.throws(()=>parseChemTable('x,y\n"1,2',',',true),/not closed/);
  const table=parseChemTable('x,y\n1,\n2,3',',',true);
  assert.throws(()=>numericColumn(table,1),/Data row 1/);
  const paired=parseChemTable('x,y\n1,2\n,\n3,4',',',true);
  assert.equal(paired.rows.length,3);assert.deepEqual(paired.rows[1],['','']);
  assert.throws(()=>numericColumn(paired,0),/Data row 2/);
  assert.equal(parseChemTable('signal\n""\n1',',',true).rows.length,2);
  assert.throws(()=>numericValues('1,,3'),/missing/);assert.throws(()=>numericValues('1,'),/missing/);
  assert.deepEqual(replicateValues('1, null, 3'),[1,null,3]);assert.throws(()=>replicateValues('1,NA,3'),/Value 2/);
});
test('headerless TSV preserves the first measurement and requires explicit mapping',()=>{
  const table=parseChemTable('0\t.1\n1\t.6','\t',false);
  assert.deepEqual(table.columns,['1. Column 1','2. Column 2']);
  const fields=[{key:'x',title:'X',kind:'number'},{key:'y',title:'Y',kind:'number'}];
  assert.throws(()=>mapChemTable(table,fields,{},[]),/Choose at least one/);
  assert.deepEqual(mapChemTable(table,fields,{x:'1',y:'0'},[]),{x:[.1,.6],y:[0,1]},'column names never override the selected mapping');
});
test('PCA import binds selected feature order and sample identifiers in one request',()=>{
  const table=parseChemTable('sample,MW,LogP,notes\nA,46.07,-.3,ethanol\nB,78.11,2.1,benzene',',',true);
  const fields=[{key:'samples',title:'Features',kind:'matrix'},{key:'__sample_id',title:'Sample',kind:'text'}];
  assert.deepEqual(mapChemTable(table,fields,{__sample_id:'0'},[1,2]),{samples:[{id:'A',values:[46.07,-.3]},{id:'B',values:[78.11,2.1]}],columns:['MW','LogP']});
  assert.throws(()=>mapChemTable(table,fields,{__sample_id:'0'},[1,3]),/not a finite number/);
});
test('replicate wide tables preserve separate groups and molecular IDs survive line input',()=>{
  const table=parseChemTable('Assay A,Assay B\n10,11\n10.1,11.2',',',true);
  assert.deepEqual(mapChemTable(table,[{key:'groups',title:'Groups',kind:'matrix'}],{},[0,1]),{groups:[{label:'Assay A',values:[10,10.1]},{label:'Assay B',values:[11,11.2]}]});
  assert.deepEqual(molecularRecords('ethanol\tCCO\nOc1ccccc1\n'),[{id:'ethanol',smiles:'CCO'},{id:'molecule-2',smiles:'Oc1ccccc1'}]);
  assert.throws(()=>molecularRecords('id\tCCO\textra'),/one tab/);
  const molecules=parseChemTable('registry,structure\nCHEM-0042,CCO\nCHEM-0156,Oc1ccccc1',',',true);
  const fields=[{key:'records',title:'SMILES',kind:'records'},{key:'__record_id',title:'ID',kind:'text'}];
  assert.deepEqual(mapChemTable(molecules,fields,{records:'1',__record_id:'0'},[]),{records:[{id:'CHEM-0042',smiles:'CCO'},{id:'CHEM-0156',smiles:'Oc1ccccc1'}]});
});
test('section filtering makes chemical analyses primary while every legacy tool remains discoverable',()=>{
  const tool=(id,category,workspace)=>({id,title:id,description:'',category,workspace});
  const catalog=[tool('simulate_reaction_network','kinetics'),tool('analyze_molecule','molecules'),tool('fit_calibration_curve','analysis','analysis'),tool('prepare_molecular_dataset','chemical-data','chemical-data'),tool('summarize_replicates','statistics','statistics'),tool('parse_xyz_trajectory','trajectories')];
  assert.equal(selectSectionOperators(catalog,'analysis')[0].id,'fit_calibration_curve');
  assert.equal(selectSectionOperators(catalog,'chemical-data')[0].id,'prepare_molecular_dataset');
  assert.deepEqual(selectSectionOperators(catalog,'statistics').map(tool=>tool.id),['summarize_replicates']);
  assert.equal(selectSectionOperators(catalog,'operators').length,catalog.length);
  assert.equal(selectSectionOperators(catalog,'chemical-data','xyz')[0].id,'parse_xyz_trajectory');
});
test('generic chart validation and export retain chemistry units and missing values',()=>{
  const data={x_label:'Wavenumber',x_unit:'cm⁻¹',y_label:'Absorbance',y_unit:'AU',series:[{id:'raw',x:[100,200,300],y:[.1,null,.4],style:'line'}]};
  assert.ok(isChemDataVisualization(data));
  assert.equal(isChemDataVisualization({...data,series:[{id:'bad',x:[1],y:[1,2]}]}),false);
  const csv=dataVisualizationCsv(data);assert.match(csv,/Wavenumber \/ cm⁻¹/);assert.match(csv,/"raw",200,\r\n/);assert.doesNotMatch(csv,/Time|seconds/);
});
test('result-table CSV exports every row and distinguishes missing measurements from zero',()=>{
  const rows=Array.from({length:150},(_,i)=>({sample:`sample ${i}`,result:i===0?null:i===1?0:i,note:i===149?'last, "quoted"':''}));
  const csv=chemicalTableCsv(rows,['sample','result','note']);
  assert.equal(csv.split('\r\n').length,151);
  assert.match(csv,/"sample 0",,""/);assert.match(csv,/"sample 1","0",""/);
  assert.ok(csv.endsWith('"sample 149","149","last, ""quoted"""'));
});
