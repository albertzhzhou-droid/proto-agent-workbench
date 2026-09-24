import type { ChemScienceOperator } from '../shared/chem-science-api.ts';

export type ChemDataSection='analysis'|'statistics'|'chemical-data';
export const CHEM_SECTION_COPY={
  analysis:{title:'Analysis',description:'Explore spectra, calibrate measurements and inspect chemical models.'},
  statistics:{title:'Statistics',description:'Compare chemical measurements, quantify uncertainty and find patterns in your data.'},
  'chemical-data':{title:'Chemical data',description:'Prepare molecular datasets, inspect formulae and calculate chemical quantities.'},
  simulator:{title:'Reaction simulator',description:'Explore mechanisms, interfaces and reactors; inspect kinetics, sensitivity and uncertainty on saved trajectories.'},
  operators:{title:'All operators',description:'One chemistry catalog for your calculations and the shared Chat workspace.'},
  history:{title:'Run history',description:'Reopen the exact inputs, results and provenance of your calculations.'},
} as const;
export function operatorWorkspace(operator:Pick<ChemScienceOperator,'category'> & {workspace?:ChemDataSection}):ChemDataSection {
  if(operator.workspace)return operator.workspace;
  return ['kinetics','interfaces','analysis'].includes(operator.category)?'analysis':operator.category==='statistics'?'statistics':'chemical-data';
}
export function selectSectionOperators(operators:ChemScienceOperator[],section:string,search=''){
  const query=search.trim().toLowerCase();
  const preferred=['fit_calibration_curve','analyze_spectrum','chemical_pca','summarize_replicates','compare_assay_groups','prepare_molecular_dataset','search_substructures','cluster_molecules','formula_properties','balance_equation','solution_calculator'];
  const rank=(id:string)=>preferred.includes(id)?preferred.indexOf(id):preferred.length;
  return operators.filter(operator=>(section==='operators'||operatorWorkspace(operator)===section)&&(!query||`${operator.id} ${operator.title} ${operator.description} ${operator.category}`.toLowerCase().includes(query))).sort((a,b)=>rank(a.id)-rank(b.id));
}
export interface ParsedChemTable { columns:string[]; rows:string[][]; }
/** Parse pasted/file data without interpreting column names or silently dropping rows. */
export function parseChemTable(text:string,delimiter:','|'\t',hasHeader:boolean):ParsedChemTable {
  if(text.length>2_000_000)throw new Error('The table exceeds the 2 MB input limit.');
  const rows:string[][]=[];let row:string[]=[],field='',quoted=false,closed=false;
  const pushField=()=>{row.push(field.trim());field='';closed=false;};
  const pushRow=()=>{const explicit=row.length>0||closed||field.trim().length>0;pushField();if(explicit)rows.push(row);row=[];};
  const source=text.replace(/^\uFEFF/,'');
  for(let i=0;i<source.length;i++){
    const char=source[i];
    if(quoted){if(char==='"'){if(source[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=char;continue;}
    if(char==='"'){if(field||closed)throw new Error('A quote appears inside an unquoted value.');quoted=true;}
    else if(char===delimiter)pushField();
    else if(char==='\n'||char==='\r'){if(char==='\r'&&source[i+1]==='\n')i++;pushRow();}
    else if(closed&&!/\s/.test(char))throw new Error('Unexpected text after a quoted value.');
    else field+=char;
  }
  if(quoted)throw new Error('A quoted value is not closed.');
  if(field||row.length)pushRow();
  if(!rows.length)throw new Error('Paste at least one row of data.');
  const width=rows[0].length;
  for(let i=0;i<rows.length;i++)if(rows[i].length!==width)throw new Error(`Row ${i+1} has ${rows[i].length} columns; expected ${width}.`);
  const headers=hasHeader?rows.shift()!:Array.from({length:width},(_,i)=>`Column ${i+1}`);
  if(!rows.length)throw new Error('The table has a header but no data rows.');
  if(rows.length>10000||width>100)throw new Error('Use at most 10,000 rows and 100 columns.');
  return {columns:headers.map((label,i)=>`${i+1}. ${label||'Unnamed column'}`),rows};
}
export function numericColumn(table:ParsedChemTable,column:number):number[]{
  if(!Number.isInteger(column)||column<0||column>=table.columns.length)throw new Error('Choose a column for every required measurement.');
  return table.rows.map((row,i)=>{const raw=row[column];const value=Number(raw);if(!raw.trim()||!Number.isFinite(value))throw new Error(`Data row ${i+1}, ${table.columns[column]} is not a finite number.`);return value;});
}
export function numericValues(source:string):number[]{
  if(!source.trim())return [];
  if(/[,;]\s*[,;]|^[,;]|[,;]\s*$/.test(source.trim()))throw new Error('A numeric value is missing between separators.');
  return source.trim().split(/[\s,;]+/).map((raw,i)=>{const value=Number(raw);if(!raw||!Number.isFinite(value))throw new Error(`Value ${i+1} is not a finite number.`);return value;});
}
export function replicateValues(source:string):Array<number|null>{
  if(!source.trim())return [];
  if(/[,;]\s*[,;]|^[,;]|[,;]\s*$/.test(source.trim()))throw new Error('A measurement is missing between separators. Use null for an explicit missing replicate.');
  return source.trim().split(/[\s,;]+/).map((raw,i)=>{if(raw==='null')return null;const value=Number(raw);if(!raw||!Number.isFinite(value))throw new Error(`Value ${i+1} is not a finite number or null.`);return value;});
}
export type ChemImportField={key:string;title:string;kind:'number'|'text'|'matrix'|'records'};
export function mapChemTable(table:ParsedChemTable,fields:ChemImportField[],mappings:Record<string,string>,matrixColumns:number[]):Record<string,unknown>{
  const patch:Record<string,unknown>={};
  for(const field of fields){
    if(field.kind==='matrix'&&matrixColumns.length){
      const columns=matrixColumns.map(column=>numericColumn(table,column));
      if(field.key==='samples'){
        const idColumn=mappings.__sample_id;
        patch.samples=table.rows.map((row,i)=>({id:idColumn!==undefined&&idColumn!==''?row[Number(idColumn)]:`sample-${i+1}`,values:columns.map(column=>column[i])}));
        patch.columns=matrixColumns.map(column=>table.columns[column].replace(/^\d+\. /,''));
      }else if(field.key==='groups')patch.groups=matrixColumns.map((column,i)=>({label:table.columns[column].replace(/^\d+\. /,''),values:columns[i]}));
      else patch[field.key]=table.rows.map((_,row)=>columns.map(column=>column[row]));
      continue;
    }
    if(field.key==='__sample_id'||field.key==='__record_id')continue;
    const mapped=mappings[field.key];if(mapped===undefined||mapped==='')continue;
    const column=Number(mapped);
    if(!Number.isInteger(column)||column<0||column>=table.columns.length)throw new Error(`Choose a valid column for ${field.title}.`);
    patch[field.key]=field.kind==='number'?numericColumn(table,column):field.kind==='records'?table.rows.map((row,i)=>({id:mappings.__record_id!==undefined&&mappings.__record_id!==''?row[Number(mappings.__record_id)]:`molecule-${i+1}`,smiles:row[column]})):table.rows.map(row=>row[column]);
  }
  if(!Object.keys(patch).length)throw new Error('Choose at least one column to apply.');
  return patch;
}
export function molecularRecords(source:string):Array<{id:string;smiles:string}>{
  return source.split(/\r?\n/).filter(line=>line.trim()).map((line,i)=>{const pieces=line.split('\t');if(pieces.length>2)throw new Error(`Molecule ${i+1}: use SMILES, or ID and SMILES separated by one tab.`);const smiles=pieces.at(-1)!.trim();if(!smiles)throw new Error(`Molecule ${i+1} has no SMILES.`);return{id:pieces.length===2?pieces[0].trim()||`molecule-${i+1}`:`molecule-${i+1}`,smiles};});
}
export interface ChemDataVisualization {x_label:string;x_unit?:string;y_label:string;y_unit?:string;series:Array<{id:string;label?:string;x:number[];y:Array<number|null>;style?:'line'|'points'}>}
export function isChemDataVisualization(value:unknown):value is ChemDataVisualization {
  if(!value||typeof value!=='object')return false;const data=value as ChemDataVisualization;
  return typeof data.x_label==='string'&&typeof data.y_label==='string'&&Array.isArray(data.series)&&data.series.every(series=>Array.isArray(series.x)&&Array.isArray(series.y)&&series.x.length===series.y.length&&series.x.every(Number.isFinite)&&series.y.every(v=>v===null||typeof v==='number'&&Number.isFinite(v)));
}
export function dataVisualizationCsv(data:ChemDataVisualization):string{
  const quote=(value:unknown)=>`"${String(value??'').replaceAll('"','""')}"`;
  return [[quote('series'),quote(`${data.x_label}${data.x_unit?` / ${data.x_unit}`:''}`),quote(`${data.y_label}${data.y_unit?` / ${data.y_unit}`:''}`)].join(','),...data.series.flatMap(series=>series.x.map((x,i)=>[quote(series.label||series.id),String(x),series.y[i]===null?'':String(series.y[i])].join(',')))].join('\r\n');
}
export function chemicalTableCsv(rows:Record<string,unknown>[],columns:string[]):string {
  const quote=(value:unknown)=>value===null||value===undefined?'':`"${String(value).replaceAll('"','""')}"`;
  return [columns.map(quote).join(','),...rows.map(row=>columns.map(column=>quote(row[column])).join(','))].join('\r\n');
}
