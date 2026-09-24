/* The structure viewport uses only explicit server-produced coordinates. */
let chemViewer, shownGeometry, selectedAtoms = [], showCell = true, spinning = false;
let coordinatePage = 0;
let geometryContextLost = false;
let initialGeometryCamera;
const geometryNode = id => document.getElementById(id);
window.getDisplayedGeometry = () => shownGeometry;
function announceGeometry() {
  document.dispatchEvent(new CustomEvent('geometry-display-changed', {detail: shownGeometry}));
}
function elementColor(element) {
  const accent = {C:'#8ea7b4',H:'#eff5f8',O:'#ee7166',N:'#819eff',Cu:'#dfa572',Si:'#b8cbe8',S:'#edce6f'};
  const native = window.$3Dmol?.elementColors?.Jmol?.[element];
  return accent[element] || (typeof native === 'number' ? '#'+native.toString(16).padStart(6,'0') : native) || '#b6c6cf';
}
function geometryText(tag, text, className) {
  const node=document.createElement(tag);node.textContent=text;if(className)node.className=className;return node;
}
function recordedGeometryRows(geometry, scale = 1) {
  if(geometry.coordinate_table===undefined)return ChemGeometryView.rows(geometry,scale);
  if(!window.ChemRefinementLab)throw Error('The exact coordinate-table viewer is unavailable.');
  return window.ChemRefinementLab.coordinateRows(geometry,scale);
}
function recordedGeometryCSV(geometry, scale = 1) {
  if(geometry.coordinate_table===undefined)return ChemGeometryView.csv(geometry,scale);
  if(!window.ChemRefinementLab)throw Error('The exact coordinate-table exporter is unavailable.');
  return window.ChemRefinementLab.coordinateCSV(geometry,scale);
}
function setupGeometryInspector() {
  const tools = document.createElement('div');tools.className='viewer-detail-controls';
  tools.innerHTML='<label>Projection<select id="viewer-projection"><option value="perspective">Perspective</option><option value="orthographic">Orthographic</option></select></label><label>Lighting<select id="viewer-lighting"><option value="ambientOcclusion">Depth shading</option><option value="none">Standard</option><option value="outline">Outline</option></select></label><label>PNG resolution<select id="viewer-resolution"><option value="2048">2048 px wide</option><option value="viewport">Viewport pixels</option></select></label>';
  document.querySelector('.viewer-controls').after(tools);
  const expand=geometryText('button','Expand 3D');expand.id='expand-geometry';expand.setAttribute('aria-pressed','false');tools.append(expand);
  expand.onclick=()=>{const expanded=document.querySelector('.viewport-panel').classList.toggle('viewport-expanded');expand.setAttribute('aria-pressed',String(expanded));expand.textContent=expanded?'Compact 3D':'Expand 3D';if(chemViewer){chemViewer.resize();if(shownGeometry){chemViewer.zoomTo();chemViewer.zoom(0.9);}chemViewer.render();}};
  const legend=document.createElement('div');legend.id='element-legend';legend.className='element-legend';legend.setAttribute('aria-label','Element colors and atom counts');tools.after(legend);
  const inspector=document.createElement('details');inspector.className='coordinate-inspector';inspector.id='coordinate-inspector';
  inspector.innerHTML='<summary>Coordinates, sites & measurement</summary><p>Stored Cartesian coordinates in angstrom. Full stored numeric values appear below and in exports. Sphere radii and element colors are visual conventions. Rendered pixels do not add physical precision.</p><div class="coordinate-measure"><label>First atom<select id="measure-first"></select></label><label>Second atom<select id="measure-second"></select></label><button id="measure-atoms">Measure selected atoms</button><button id="export-coordinate-csv">↓ Coordinate CSV</button><button id="export-view-record">↓ View record</button></div><div id="coordinate-cell"></div><div class="coordinate-table-wrap"><table><caption>Recorded atom and site coordinates</caption><thead><tr><th>Atom</th><th>Element</th><th>x / Å</th><th>y / Å</th><th>z / Å</th><th>Oxidation state</th><th>Sublattice</th></tr></thead><tbody id="coordinate-rows"></tbody></table></div><div class="coordinate-pages"><button id="coordinate-previous">Previous atoms</button><span id="coordinate-page" role="status"></span><button id="coordinate-next">Next atoms</button></div>';
  geometryNode('atom-inspector').after(inspector);
  geometryNode('viewer-projection').onchange=()=>{if(chemViewer){chemViewer.setProjection(geometryNode('viewer-projection').value);chemViewer.render();}};
  geometryNode('viewer-lighting').onchange=()=>{if(chemViewer){setViewerLighting();chemViewer.render();}};
  geometryNode('measure-atoms').onclick=()=>{if(!shownGeometry)return;selectedAtoms=[];for(const id of ['measure-first','measure-second'])pickRecordedAtom(Number(geometryNode(id).value));};
  geometryNode('coordinate-previous').onclick=()=>{coordinatePage=Math.max(0,coordinatePage-1);renderCoordinateRows();};
  geometryNode('coordinate-next').onclick=()=>{coordinatePage++;renderCoordinateRows();};
  geometryNode('export-coordinate-csv').onclick=()=>{if(shownGeometry)saveGeometryText(recordedGeometryCSV(shownGeometry.geometry,shownGeometry.scale),'text/csv',shownGeometry.geometry.object_id+'.coordinates.csv');};
  geometryNode('export-view-record').onclick=()=>{if(!shownGeometry)return;saveGeometryText(ChemGeometryView.stringify({version:'geometry-view-record/v1',base_geometry:shownGeometry.geometry,display_scale:shownGeometry.scale,camera:chemViewer.getView(),projection:geometryNode('viewer-projection').value,lighting:geometryNode('viewer-lighting').value,display_only:true,scope:'Stored coordinates and display settings; no material appearance or computed trajectory is inferred.'})+'\n','application/json',shownGeometry.geometry.object_id+'.view.json');};
}
function saveGeometryText(text,type,name){const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function setViewerLighting(){chemViewer.setViewStyle({style:geometryNode('viewer-lighting').value,radius:3,strength:0.65,color:'#09202a',width:0.018});}
function updateGeometryInspector(){
  geometryNode('element-legend').replaceChildren();geometryNode('coordinate-cell').replaceChildren();
  for(const id of ['measure-first','measure-second'])geometryNode(id).replaceChildren();
  coordinatePage=0;
  for(const id of ['measure-atoms','export-coordinate-csv','export-view-record'])geometryNode(id).disabled=!shownGeometry;
  if(!shownGeometry){renderCoordinateRows();return;}
  const {geometry,scale}=shownGeometry,counts=new Map();
  for(const atom of geometry.atoms)counts.set(atom.element,(counts.get(atom.element)||0)+1);
  for(const [element,count] of counts){const chip=geometryText('span',`${element} · ${count}`,'element-chip'),dot=document.createElement('i');dot.style.backgroundColor=elementColor(element);chip.prepend(dot);geometryNode('element-legend').append(chip);}
  for(const atom of recordedGeometryRows(geometry,scale))for(const id of ['measure-first','measure-second'])geometryNode(id).append(new Option(`${atom.index+1} · ${atom.element} · ${atom.id}`,String(atom.index)));
  geometryNode('measure-second').value=String(Math.min(1,geometry.atoms.length-1));
  if(geometry.cell){const table=document.createElement('table');table.append(geometryText('caption','Recorded cell vectors / Å'));for(const [index,vector] of geometry.cell.entries()){const row=document.createElement('tr');row.append(geometryText('th',['a','b','c'][index]));for(const value of vector)row.append(geometryText('td',String(value)));table.append(row);}geometryNode('coordinate-cell').append(table);}
  if(scale!==1)geometryNode('coordinate-cell').append(geometryText('p',`Table: unscaled recorded coordinates. Current display scale: ${scale}. CSV includes both base and displayed coordinates.`));
  if(geometry.coordinate_table!==undefined)geometryNode('coordinate-cell').append(geometryText('p','Table and CSV base coordinates retain exact recorded decimal strings. Displayed coordinates and Cartesian distances use a binary64 projection. CSV also contains exact recorded Cartesian gradients.'));
  renderCoordinateRows();
}
function renderCoordinateRows(){
  const body=geometryNode('coordinate-rows');body.replaceChildren();const rows=shownGeometry?recordedGeometryRows(shownGeometry.geometry,shownGeometry.scale):[],pages=Math.max(1,Math.ceil(rows.length/20));coordinatePage=Math.min(coordinatePage,pages-1);
  for(const atom of rows.slice(coordinatePage*20,(coordinatePage+1)*20)){const tr=document.createElement('tr'),td=document.createElement('td'),button=geometryText('button',atom.id);button.onclick=()=>pickRecordedAtom(atom.index);td.append(button);tr.append(td);for(const value of [atom.element,...atom.position,atom.oxidation_state??'Unspecified',atom.sublattice??'Unspecified'])tr.append(geometryText('td',ChemGeometryView.numericText(value)));body.append(tr);}
  geometryNode('coordinate-page').textContent=rows.length?`${coordinatePage*20+1}–${Math.min(rows.length,(coordinatePage+1)*20)} of ${rows.length} atoms`:'No recorded atoms';geometryNode('coordinate-previous').disabled=coordinatePage===0;geometryNode('coordinate-next').disabled=coordinatePage>=pages-1;
}
function pickRecordedAtom(index){if(!shownGeometry||!shownGeometry.geometry.atoms[index])return;const atom=shownGeometry.geometry.atoms[index],p=atom.position.map(value=>value*shownGeometry.scale);pickAtom({serial:index,elem:atom.element,atom:atom.id,x:p[0],y:p[1],z:p[2]});}
function initViewer() {
  if(geometryContextLost)throw Error('WebGL context was lost. Reload to restore the viewport.');
  if (chemViewer) return chemViewer;
  if (!window.$3Dmol) throw Error('The local 3Dmol.js bundle is unavailable.');
  chemViewer = $3Dmol.createViewer(document.getElementById('molecule-viewer'), {
    backgroundColor: '#14252d', antialias: true, cartoonQuality: 6,
    defaultcolors: $3Dmol.elementColors.Jmol, projection: 'perspective'
  });
  chemViewer.setProjection(geometryNode('viewer-projection').value);setViewerLighting();
  initialGeometryCamera = chemViewer.getView().slice();
  const host = document.getElementById('molecule-viewer');
  new ResizeObserver(() => { chemViewer.resize(); chemViewer.render(); }).observe(host);
  host.querySelector('canvas')?.addEventListener('webglcontextlost', e => {
    e.preventDefault();geometryContextLost=true;
    clearGeometry('WebGL context lost. Reload to restore the viewport.');
  });
  return chemViewer;
}
function resetGeometryCamera(){
  if(!shownGeometry||!chemViewer)return;
  chemViewer.setView(initialGeometryCamera.slice());
  chemViewer.rotate(22,'x');chemViewer.rotate(32,'y');
  chemViewer.zoomTo();chemViewer.zoom(0.9);chemViewer.render();
}
function clearGeometry(message = 'Compile the current source to inspect its coordinates.') {
  shownGeometry = null; selectedAtoms = [];
  if (chemViewer) { chemViewer.spin(false); chemViewer.clear(); if(!geometryContextLost)chemViewer.render(); }
  spinning = false; document.getElementById('spin').setAttribute('aria-pressed','false');
  document.getElementById('viewer-empty').textContent = message;
  document.getElementById('viewer-empty').hidden = false;
  ['atom-count','cell-size','geometry-kind'].forEach(id=>document.getElementById(id).textContent='—');
  document.getElementById('geometry-status').textContent = 'NO GEOMETRY';
  document.getElementById('viewer-method').textContent = '3Dmol.js · Local WebGL';
  document.getElementById('cell-label').textContent = 'UNIT CELL / Å';
  document.getElementById('geometry-description').textContent = message;
  document.getElementById('geometry-hash').textContent = '';
  document.getElementById('structure-title').textContent = 'Structure viewport';
  document.getElementById('atom-inspector').textContent = 'No current coordinates.';
  document.getElementById('export-png').disabled = document.getElementById('export-geometry').disabled = true;
  updateGeometryInspector();announceGeometry();
}
function displayGeometry(geometry, scale = 1) {
  try {
    ChemGeometryView.validate(geometry,scale);
    // A present exact table must bind before the viewport replaces its current model.
    recordedGeometryRows(geometry,scale);
    const viewer = initViewer(); viewer.spin(false); viewer.clear(); selectedAtoms = [];
    spinning = false; document.getElementById('spin').setAttribute('aria-pressed','false');
    shownGeometry = {geometry, scale};
    const positions = geometry.atoms.map((atom,index)=>({elem:atom.element, serial:index,
      x:atom.position[0]*scale,y:atom.position[1]*scale,z:atom.position[2]*scale,
      bonds:[],bondOrder:[],atom:atom.id}));
    for (const bond of geometry.bonds) {positions[bond.a].bonds.push(bond.b);positions[bond.a].bondOrder.push(bond.order);positions[bond.b].bonds.push(bond.a);positions[bond.b].bondOrder.push(bond.order);}
    viewer.addModel().addAtoms(positions);
    restyle();
    viewer.setClickable({},true,atom=>pickAtom(atom));
    resetGeometryCamera();
    document.getElementById('viewer-empty').hidden = true;
    document.getElementById('structure-title').textContent = geometry.object_id.replaceAll('_',' ');
    document.getElementById('geometry-status').textContent = scale === 1 ? geometry.provenance.replaceAll('_',' ').toUpperCase() : `PROPOSED SCALE ${scale.toFixed(2)}×`;
    document.getElementById('atom-count').textContent = geometry.atoms.length;
    document.getElementById('cell-size').textContent = geometry.cell ? geometry.cell.map(v=>(Math.hypot(...v)*scale).toFixed(3)).join(' × ') : 'Å';
    document.getElementById('cell-label').textContent = geometry.cell ? 'UNIT CELL / Å' : 'CARTESIAN COORDINATES';
    document.getElementById('geometry-kind').textContent = geometry.provenance === 'source_imported' ? 'Imported coordinates' : geometry.provenance === 'tool_constructed' ? 'Constructed geometry' : geometry.provenance === 'user_edited' ? 'Edited coordinates' : 'ETKDG conformer';
    document.getElementById('geometry-description').textContent = geometry.description + (scale!==1 ? ` Display coordinates scaled by ${scale}; proposed, not simulated.` : '');
    document.getElementById('geometry-hash').textContent = geometry.geometry_hash?'BASE GEOMETRY '+geometry.geometry_hash:geometry.input_record_hash?'INPUT RECORD '+geometry.input_record_hash:'Recorded input coordinates · no display-geometry hash';
    if(geometry.provenance==='calculation_input')document.getElementById('geometry-kind').textContent='Calculation input';
    if(geometry.provenance==='evaluated_geometry')document.getElementById('geometry-kind').textContent='Evaluated geometry';
    document.getElementById('viewer-method').textContent = geometry.method;
    document.getElementById('atom-inspector').textContent = 'Select an atom to inspect coordinates. Select a second to measure a Cartesian distance.';
    document.getElementById('export-png').disabled = document.getElementById('export-geometry').disabled = false;
    updateGeometryInspector();announceGeometry();
  } catch(error) {clearGeometry('3D unavailable: '+error.message);}
}
function restyle() {
  if (!shownGeometry || !chemViewer) return;
  const {geometry,scale}=shownGeometry;
  const mode=document.getElementById('representation').value;
  chemViewer.setStyle({},{});
  const elements=[...new Set(geometry.atoms.map(a=>a.element))];
  for(const element of elements){const color=elementColor(element);
    const sphere = geometry.cell ? {radius:mode==='space'?1.15:mode==='wire'?0.16:0.78,color} : {scale:mode==='space'?1:mode==='wire'?0.12:0.3,color};
    const atomOnlyEvaluation=geometry.provenance==='evaluated_geometry'&&geometry.bonds.length===0;
    chemViewer.setStyle({elem:element},mode==='wire'&&!geometry.cell&&!atomOnlyEvaluation?{line:{color}}:{sphere,...(!geometry.cell&&mode==='ball'?{stick:{radius:0.13,color}}:{})});
  }
  chemViewer.removeAllShapes();
  if(geometry.cell&&showCell){const vectors=geometry.cell.map(v=>v.map(x=>x*scale));
    // Draw all eight repeated unit cells. Their edges are geometric, not bonds.
    const repeats=geometry.display_repeats||2;
    for(let i=0;i<repeats;i++)for(let j=0;j<repeats;j++)for(let k=0;k<repeats;k++){
      const point=(a,b,c)=>({x:a*vectors[0][0]+b*vectors[1][0]+c*vectors[2][0],y:a*vectors[0][1]+b*vectors[1][1]+c*vectors[2][1],z:a*vectors[0][2]+b*vectors[1][2]+c*vectors[2][2]});
      for(let axis=0;axis<3;axis++)for(let u=0;u<2;u++)for(let v=0;v<2;v++){
        const a=[i,j,k];a[(axis+1)%3]+=u;a[(axis+2)%3]+=v;const b=[...a];b[axis]++;
        chemViewer.addLine({start:point(...a),end:point(...b),color:'#7fa8a9',opacity:0.65,linewidth:1});
      }
    }
  }
  chemViewer.render();
}
function pickAtom(atom){
  if(selectedAtoms.length===2)selectedAtoms=[];
  selectedAtoms.push(atom); chemViewer.removeAllLabels();
  for(const a of selectedAtoms)chemViewer.addLabel(a.atom,{position:{x:a.x,y:a.y,z:a.z},backgroundColor:'#213b43',fontColor:'#e9f2f1',fontSize:12,backgroundOpacity:.85});
  const recorded=shownGeometry.geometry.atoms[atom.serial];
  let text=`${atom.elem} · ${atom.atom} · x ${atom.x} / y ${atom.y} / z ${atom.z} Å`;
  if(shownGeometry.geometry.coordinate_table!==undefined){const exact=recordedGeometryRows(shownGeometry.geometry,shownGeometry.scale)[atom.serial];text=`${atom.elem} · ${atom.atom} · recorded x ${exact.position[0]} / y ${exact.position[1]} / z ${exact.position[2]} Å`;if(shownGeometry.scale!==1)text+=` · display scale ${shownGeometry.scale}`;}
  if(recorded?.oxidation_state!=null)text+=` · Oxidation state ${recorded.oxidation_state}`;
  if(recorded?.sublattice)text+=` · Sublattice ${recorded.sublattice}`;
  if(selectedAtoms.length===2){const [a,b]=selectedAtoms;const distance=ChemGeometryView.distance(shownGeometry.geometry,a.serial,b.serial,shownGeometry.scale);text+=` · Distance ${distance} Å (${shownGeometry.geometry.coordinate_table!==undefined?'approximate binary64 projection; ':''}Cartesian; periodic images are not considered)`;}
  document.getElementById('atom-inspector').textContent=text;chemViewer.render();
}
document.getElementById('representation').onchange=restyle;
document.getElementById('cell-toggle').onclick=()=>{showCell=!showCell;document.getElementById('cell-toggle').setAttribute('aria-pressed',String(showCell));restyle();};
document.getElementById('spin').onclick=()=>{if(!shownGeometry)return;spinning=!spinning;chemViewer.spin(spinning?'y':false,0.35);document.getElementById('spin').setAttribute('aria-pressed',String(spinning));};
document.getElementById('reset-view').onclick=resetGeometryCamera;
document.getElementById('export-png').onclick=async()=>{
  if(!shownGeometry)return;const button=geometryNode('export-png'),bound=shownGeometry;button.disabled=true;
  try{
    const host=geometryNode('molecule-viewer'),width=Number(geometryNode('viewer-resolution').value),view=chemViewer.getView();
    let png,pixels;
    try{if(Number.isFinite(width)){if(!host.clientWidth||!host.clientHeight)throw Error('Open the visible viewport before exporting.');const ratio=(host.querySelector('canvas')?.width||host.clientWidth)/host.clientWidth;chemViewer.setWidth(Math.round(width/ratio));chemViewer.setHeight(Math.max(1,Math.round(width*host.clientHeight/host.clientWidth/ratio)));}chemViewer.setView(view);chemViewer.render();png=chemViewer.pngURI();const canvas=host.querySelector('canvas');pixels=canvas?`${canvas.width} × ${canvas.height}`:'recorded viewport';}
    finally{chemViewer.resize();chemViewer.setView(view);chemViewer.render();}
    const exported=await api('/api/export/png',{png});const a=document.createElement('a');a.download=bound.geometry.object_id+'.viewport.png';a.href=exported.url;a.click();
    if(shownGeometry===bound)geometryNode('atom-inspector').textContent=`PNG saved at ${pixels} pixels. `+exported.url;
  }catch(error){if(shownGeometry===bound)geometryNode('atom-inspector').textContent='Export failed: '+error.message;}
  finally{button.disabled=!shownGeometry;}
};
document.getElementById('export-geometry').onclick=()=>{if(!shownGeometry)return;const {geometry,scale}=shownGeometry;saveGeometryText(ChemGeometryView.stringify({base_geometry:geometry,display_scale:scale,display_only:true})+'\n','application/json',`${geometry.object_id}.geometry.json`);};
setupGeometryInspector();updateGeometryInspector();
document.addEventListener('visibilitychange',()=>{if(document.hidden&&chemViewer){chemViewer.spin(false);spinning=false;geometryNode('spin').setAttribute('aria-pressed','false');}});


