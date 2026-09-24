let activeWorkflow=null, workflowTimer=null, savedRevision=false, savedProjects=[], executionGeneration=0, historyRequest=0, restoringWorkflowGeometry=false, lastExecutionView=viewportBindingFingerprint();
const finalStates=new Set(['succeeded','failed','cancelled','interrupted']);
function executionError(error){$('execution-message').textContent=error.message;}
function advanceExecution(){executionGeneration++;clearTimeout(workflowTimer);workflowTimer=null;}
function executionSnapshot(){return {generation:executionGeneration,reference:activeWorkflow?.reference||null,source:canonicalJSON(sourcePayload()),view:$('structure-select').value,geometry:viewportBindingFingerprint(),profile:$('compute-profile').value,explicitGeometry:$('water-geometry').value};}
function executionCurrent(token){return token.generation===executionGeneration&&token.reference===(activeWorkflow?.reference||null)&&token.source===canonicalJSON(sourcePayload())&&token.view===$('structure-select').value&&token.geometry===viewportBindingFingerprint()&&token.profile===$('compute-profile').value&&token.explicitGeometry===$('water-geometry').value;}
function clearExecution(message,state){
 advanceExecution();activeWorkflow=null;
 $('approve-compute').disabled=$('run-compute').disabled=$('cancel-compute').disabled=$('download-evidence').disabled=true;
 $('resolved-plan').textContent='';drawEnergy(null);$('job-history').value='';
 $('execution-message').textContent=message;$('run-state').textContent=state;
}
function resetExecution(){
 clearExecution('Source or geometry changed. Prepare a new plan to review current inputs.','SOURCE CHANGED');
 savedRevision=false;$('save-state').textContent='Unsaved changes';
}
document.addEventListener('workspace-changed',resetExecution);
document.addEventListener('structure-selection-changed',()=>clearExecution('Structure selection changed. Prepare a new plan for the displayed subject.','STRUCTURE CHANGED'));
document.addEventListener('geometry-display-changed',()=>{
 const fingerprint=viewportBindingFingerprint(),changed=fingerprint!==lastExecutionView;lastExecutionView=fingerprint;
 if(changed&&!restoringWorkflowGeometry)clearExecution('Displayed coordinates changed. Prepare a plan for these exact inputs before approving or running.','GEOMETRY CHANGED');
});
window.addEventListener('beforeunload',event=>{if(!savedRevision&&$('source').value){event.preventDefault();event.returnValue='';}});
$('compute-profile').onchange=()=>{$('water-input').hidden=$('compute-profile').value!=='water';if($('molecular-profile-note'))$('molecular-profile-note').hidden=$('compute-profile').value!=='molecular';resetExecution();};
$('water-geometry').oninput=resetExecution;
function appendResultRecord(record){const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='Exact execution result and provenance';pre.textContent=JSON.stringify(record,null,2);details.append(summary,pre);$('computed-results').append(details);}
function appendRecordedCandidateControl(row,parent){
 const workflow=activeWorkflow,candidate=workflow?.plan?.candidates?.find(item=>item.candidate_hash===row.candidate_hash);if(!candidate)return;
 const button=document.createElement('button');button.textContent='View '+candidate.scale+'× input';button.onclick=()=>{if(activeWorkflow?.reference!==workflow.reference)return;advanceExecution();if(withRecordedGeometry(inputGeometry(workflow.plan,candidate)))showWorkflow(workflow);};parent.append(button);
}
function drawEnergy(resultRecord){
 $('energy-chart').replaceChildren();$('computed-results').replaceChildren();
 if(!resultRecord){$('computed-results').textContent='No computed evidence yet.';return;}
 if(!resultRecord.evidence_eligible){$('computed-results').textContent=resultRecord.summary||'This run did not produce validated evidence.';appendResultRecord(resultRecord);return;}
 if(resultRecord.energy_hartree!==undefined){
  $('computed-results').textContent=`HF/STO-3G single-point energy · ${resultRecord.energy_hartree} hartree`;
  const metrics=document.createElement('dl');metrics.className='result-metrics';
  const values=[['Energy / hartree',resultRecord.energy_hartree],['Convergence',resultRecord.convergence||'Validated successful result; iteration trace unavailable'],['Method',activeWorkflow?.plan?.method||'hf'],['Basis',activeWorkflow?.plan?.basis||'sto-3g'],['Worker duration / ms',resultRecord.execution?.duration_ms??'Unavailable'],['Geometry treatment','Fixed recorded input; no optimization'],['Input SHA-256',resultRecord.input_sha256||'Unavailable'],['Output SHA-256',resultRecord.output_sha256||'Unavailable']];
  for(const [label,value] of values){const term=document.createElement('dt'),description=document.createElement('dd');term.textContent=label;description.textContent=String(value);metrics.append(term,description);}$('computed-results').append(metrics);
  const scope=document.createElement('p');scope.textContent=resultRecord.scientific_scope||'Single-point energy with the recorded geometry and method. No reaction trajectory or physical accuracy estimate is available.';$('computed-results').append(scope);appendResultRecord(resultRecord);return;
 }
 const ranking=resultRecord.ranking||[];
 const table=document.createElement('table');table.innerHTML='<caption>Lowest computed energy among the evaluated candidates</caption><thead><tr><th>Rank</th><th>Scale</th><th>Energy / eV per atom</th><th>Status</th><th>Coordinates</th></tr></thead>';
 const tbody=document.createElement('tbody');for(const row of ranking){const tr=document.createElement('tr');for(const key of ['rank','scale','energy_eV_per_atom']){const td=document.createElement('td');td.textContent=row[key];tr.append(td);}const status=document.createElement('td');status.textContent='Validated';tr.append(status);const view=document.createElement('td');appendRecordedCandidateControl(row,view);tr.append(view);tbody.append(tr);}for(const row of resultRecord.excluded||[]){const tr=document.createElement('tr');for(const value of ['Excluded',row.scale??'Unavailable',row.energy_eV_per_atom??'Unavailable',[row.reason,row.error].filter(Boolean).join(' · ')||'Validation failed']){const td=document.createElement('td');td.textContent=String(value);tr.append(td);}const view=document.createElement('td');appendRecordedCandidateControl(row,view);tr.append(view);tbody.append(tr);}table.append(tbody);$('computed-results').append(table);appendResultRecord(resultRecord);
 const values=[...ranking].sort((a,b)=>Number(a.scale)-Number(b.scale));if(values.length<2)return;
 const xs=values.map(v=>Number(v.scale)),ys=values.map(v=>Number(v.energy_eV_per_atom));const xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(...ys),ymax=Math.max(...ys);
 const point=(x,y)=>[50+340*(x-xmin)/(xmax-xmin||1),180-130*(y-ymin)/(ymax-ymin||1)];
 const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 440 230');svg.setAttribute('role','img');svg.setAttribute('aria-label','Computed EMT energy per atom versus cell scale');
 const line=document.createElementNS(ns,'polyline');line.setAttribute('points',values.map(v=>point(Number(v.scale),Number(v.energy_eV_per_atom)).join(',')).join(' '));line.setAttribute('fill','none');line.setAttribute('stroke','#087f73');line.setAttribute('stroke-width','3');svg.append(line);
 values.forEach(v=>{const [x,y]=point(Number(v.scale),Number(v.energy_eV_per_atom));const circle=document.createElementNS(ns,'circle');circle.setAttribute('cx',x);circle.setAttribute('cy',y);circle.setAttribute('r','5');circle.setAttribute('fill','#087f73');const title=document.createElementNS(ns,'title');title.textContent=`${v.scale} ×: ${v.energy_eV_per_atom} eV/atom`;circle.append(title);svg.append(circle);const label=document.createElementNS(ns,'text');label.setAttribute('x',x);label.setAttribute('y','207');label.setAttribute('text-anchor','middle');label.textContent=v.scale+'×';svg.append(label);});
 const label=document.createElementNS(ns,'text');label.setAttribute('x','24');label.setAttribute('y','24');label.textContent=`EMT · eV/atom · ${ymin.toFixed(5)} to ${ymax.toFixed(5)}`;svg.append(label);$('energy-chart').append(svg);
 const excluded=document.createElement('p');excluded.textContent=`${resultRecord.excluded?.length||0} excluded candidates. This comparison does not establish phase stability or catalytic activity.`;$('computed-results').append(excluded);
}
const historicalMismatch='Historical calculation: its source or attachments differ from the current workspace. Evidence remains available for review. Open the matching source or prepare a new plan before approving or running.';
function workflowMatchesWorkspace(value){return typeof value?.source==='string'&&canonicalJSON({source:value.source,attachments:value.attachments||{}})===canonicalJSON(sourcePayload());}
function coordinateRows(geometry,scale=1){
 if(!geometry?.atoms?.length||!Number.isFinite(scale))return null;
 const rows=geometry.atoms.map(atom=>Array.isArray(atom)?[atom[0],...atom.slice(1).map(Number)]:[atom.element,...(atom.position||[]).map(value=>Number(value)*scale)]);
 return rows.every(row=>row.length===4&&typeof row[0]==='string'&&row.slice(1).every(Number.isFinite))?rows:null;
}
function inputGeometry(plan,candidate=null){
 const subject=plan?.subject||{},proposal=subject.proposal;
 const input=proposal?.geometry||subject.geometry;
 const target=subject.subject_ref||plan?.object_id||proposal?.object_id||'recorded_input';
 if(input){
  const rows=coordinateRows(input);if(!rows||input.units&&input.units!=='angstrom')return null;
  const original=result?.scene?.structures?.find(item=>item.object_id===target&&canonicalJSON(coordinateRows(item))===canonicalJSON(rows));
  if(original)return original;
  return {version:'display-geometry/v1',object_id:target,kind:'Molecule',units:'angstrom',atoms:rows.map((row,index)=>({id:`input-${index+1}`,element:row[0],position:row.slice(1)})),bonds:[],cell:null,unit_cell_atoms:rows.length,
   geometry_hash:null,input_record_hash:subject.geometry_hash||subject.content_hash||plan.prepared_input_hash||null,provenance:'calculation_input',method:'Exact recorded single-point input',description:'Exact recorded input coordinates in angstrom. Atom-only display; bonds are not inferred. This fixed geometry is not a computed trajectory.'};
 }
 candidate=candidate||plan?.candidates?.[0];
 if(!candidate?.fractional_sites?.length||candidate.lattice_angstrom?.length!==3)return null;
 const cell=candidate.lattice_angstrom.map(row=>row.map(Number));
 if(cell.some(row=>row.length!==3||!row.every(Number.isFinite)))return null;
 const atoms=candidate.fractional_sites.map((site,index)=>({id:site.id||`site-${index+1}`,element:site.element,position:[0,1,2].map(axis=>site.coordinates.reduce((sum,fraction,k)=>sum+Number(fraction)*cell[k][axis],0))}));
 if(!coordinateRows({atoms}))return null;
 return {version:'display-geometry/v1',object_id:target,kind:'PeriodicStructure',units:'angstrom',atoms,bonds:[],cell,unit_cell_atoms:atoms.length,display_repeats:1,
  geometry_hash:null,input_record_hash:candidate.candidate_hash||null,provenance:'calculation_input',method:'Exact recorded candidate cell',description:`Recorded ${candidate.scale}× candidate: one input unit cell. Fractional sites are projected through its recorded lattice. No relaxation or reaction trajectory is inferred.`};
}
function withRecordedGeometry(geometry){
 if(!geometry)return false;
 restoringWorkflowGeometry=true;
 try{const selector=$('structure-select');if(!Array.from(selector.children).some(option=>option.value===geometry.object_id))selector.append(new Option(geometry.object_id+' · recorded input',geometry.object_id));selector.value=geometry.object_id;displayGeometry(geometry);}
 finally{restoringWorkflowGeometry=false;lastExecutionView=viewportBindingFingerprint();}
 return !!displayedGeometryState();
}
function displayPlanCandidate(proposal,candidate){
 const plan={subject:{subject_ref:proposal.subject_ref},candidates:proposal.candidates},geometry=inputGeometry(plan,candidate);
 if(geometry)displayGeometry(geometry);else clearGeometry('This candidate has no complete recorded coordinates.');
}
function workflowBindingIssue(value){
 if(!workflowMatchesWorkspace(value))return historicalMismatch;
 const target=value.plan?.subject?.subject_ref||value.plan?.object_id,displayed=displayedGeometryState();
 if(target&&target!==$('structure-select').value)return `Historical calculation for ${target}: the viewport shows a different subject or has no matching geometry. Evidence is for the recorded calculation. Show its recorded input before approving or running.`;
 if(!displayed?.geometry||displayed.geometry.units!=='angstrom')return 'The calculation has no matching displayed input coordinates. Show the recorded input before approving or running.';
 const plan=value.plan,choices=plan?.candidates?.length?plan.candidates.map(candidate=>inputGeometry(plan,candidate)):[inputGeometry(plan)];
 const actual=coordinateRows(displayed.geometry,displayed.scale),actualCell=displayed.geometry.cell?.map(row=>row.map(number=>number*displayed.scale))||null;
 if(!actual||!choices.some(expected=>expected&&canonicalJSON(coordinateRows(expected))===canonicalJSON(actual)&&canonicalJSON(expected.cell||null)===canonicalJSON(actualCell)))return 'Historical geometry mismatch: the displayed coordinates, cell or scale differ from the recorded calculation input. Its evidence remains reviewable. Show the recorded input before approving or running.';
 return '';
}
function showWorkflow(value){
 activeWorkflow=value;const issue=workflowBindingIssue(value),matches=!issue;
 $('run-state').textContent=value.state.toUpperCase();$('resolved-plan').textContent=JSON.stringify(value.plan,null,2);
 $('approve-compute').disabled=!matches||['queued','running'].includes(value.state);$('run-compute').disabled=!matches||value.state!=='approved';$('cancel-compute').disabled=value.state!=='running';$('download-evidence').disabled=!value.result;
 $('execution-message').textContent=matches?(value.failure||value.job?.failure||`Plan ${value.reference.slice(0,23)}… · ${value.state} · Viewport shows recorded input coordinates`):issue;drawEnergy(value.result);
 if(issue){const button=document.createElement('button');button.textContent='Show recorded input';button.onclick=()=>{advanceExecution();if(withRecordedGeometry(inputGeometry(value.plan))){showWorkflow(value);if(['running','queued'].includes(value.state))pollWorkflow(value.reference,executionSnapshot());}else executionError(Error('Complete input coordinates are unavailable in this record. Approval and execution remain disabled.'));};$('execution-message').append(button);}
 if(value.result&&issue){const notice=document.createElement('p');notice.textContent='HISTORICAL RESULT · '+issue;$('computed-results').append(notice);}
}
function currentExecutableWorkflow(){
 if(!activeWorkflow)return null;
 const issue=workflowBindingIssue(activeWorkflow);if(issue){$('approve-compute').disabled=$('run-compute').disabled=true;throw Error(issue);}
 return activeWorkflow;
}
function beginWorkflowRequest(){advanceExecution();$('approve-compute').disabled=$('run-compute').disabled=$('cancel-compute').disabled=true;return executionSnapshot();}
function workflowResponseCurrent(token,value,reference){return executionCurrent(token)&&value?.reference===reference;}
function workflowRequestError(token,error){if(executionCurrent(token)){if(activeWorkflow)showWorkflow(activeWorkflow);executionError(error);}}
async function refreshHistory(){
 const request=++historyRequest,records=await api('/api/workflows');
 // Saved history belongs to the workspace store, independent of the current source or geometry.
 if(request!==historyRequest)return;
 const selected=$('job-history').value;$('job-history').replaceChildren(new Option('Select a calculation',''));
 for(const item of records.filter(item=>item.plan.kind!=='molecular_refinement'))$('job-history').append(new Option(`${item.plan.kind} · ${item.state} · ${item.reference.slice(-8)}`,item.reference));
 $('job-history').value=selected;
}
async function pollWorkflow(reference,token=executionSnapshot()){
 if(!executionCurrent(token)||activeWorkflow?.reference!==reference)return;
 clearTimeout(workflowTimer);workflowTimer=null;
 try{
  const value=await api('/api/workflow/read',{reference});
  if(!workflowResponseCurrent(token,value,reference))return;
  showWorkflow(value);
  if(!finalStates.has(value.state)&&['running','queued'].includes(value.state))workflowTimer=setTimeout(()=>pollWorkflow(reference,token),800);
  else await refreshHistory();
 }catch(error){workflowRequestError(token,error);}
}
function canonicalJSON(value){
 if(Array.isArray(value))return '['+value.map(canonicalJSON).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalJSON(value[key])).join(',')+'}';
 return JSON.stringify(value);
}
function matchingPlanner(profile){
 const name={water:'plan_water_single_point',copper:'plan_cu_lattice_scan',molecular:'plan_molecular_single_point'}[profile];
 if(agentRecord?.state!=='REPORTED'||agentRecord.execution_authorized!==false||!/^sha256:[0-9a-f]{64}$/.test(agentRecord.record_hash||'')||agentRecord.trace?.length!==1)return null;
 if(agentRecord.source_hash!==result.source_sha256||agentRecord.source_semantic_hash!==result.semantic_hash)return null;
 const entry=agentRecord.trace[0],output=entry.output,data=output?.data;
 const version={water:'water-proposal/v1',copper:'cu-scan-proposal/v1',molecular:'molecular-proposal/v1'}[profile];
 if(entry.action?.action!==name||output?.tool_name!==name||output.status!=='succeeded'||output.authority!=='host_read_and_derive_only'||output.source_hash!==result.source_sha256||data?.version!==version||data.execution_authorized!==false)return null;
 const target=profile==='water'?data.object_id:data.subject_ref;
 return entry.action.object_id===target?entry:null;
}
$('prepare-compute').onclick=async()=>{
 clearExecution('Preparing a new plan. Previous approval is no longer selected.','PREPARING');
 const token=executionSnapshot();
 try{
  if(!result?.success)throw Error('Compile the current source first.');
  const profile=$('compute-profile').value,kind=profile==='copper'?'PeriodicStructure':'Molecule';
  const planner=matchingPlanner(profile),plan=profile==='copper'?currentPlan:null;
  const target=plan?.subject_ref||planner?.action.object_id;
  const objects=result.document.objects.filter(object=>object.kind===kind);
  const object=target?objects.find(object=>object.id===target):objects.find(object=>object.id===$('structure-select').value)||objects[0];
  if(!object)throw Error('No matching structure in the current source.');
  const displayed=displayedGeometryState(),compiled=result.scene?.structures?.find(item=>item.object_id===object.id);
  if(profile!=='water'&&(!displayed||displayed.geometry.provenance==='user_edited'||displayed.geometry.parent_geometry_hash||$('structure-select').value.startsWith('geometry-revision:')))throw Error('The viewport shows a Structure Lab revision. This calculation profile uses compiled source coordinates. Select the compiled structure explicitly before preparing; edited revisions are not substituted.');
  if(profile!=='water'&&displayed.geometry.provenance!=='calculation_input'&&(!compiled||displayed.geometry.geometry_hash!==compiled.geometry_hash))throw Error('The displayed geometry is not the compiled calculation subject. Select its compiled structure before preparing.');
  const source=JSON.parse(token.source),plannerReference=agentRecord?.record_hash;
  const request={...source,profile,object_id:object.id};
  if(profile==='molecular'){request.proposal=planner?.output.data||(await api('/api/tool',{...source,tool:'plan_molecular_single_point',arguments:{object_id:object.id}})).data;if(!executionCurrent(token))return;}
  else if(profile==='water')request.geometry=JSON.parse($('water-geometry').value);
  else if(plan){request.proposal=plan;request.scales=plan.candidates.map(candidate=>Number(candidate.scale));}
  const matches=planner?.action.object_id===object.id&&(profile==='molecular'?canonicalJSON(request.proposal)===canonicalJSON(planner.output.data):profile==='water'?canonicalJSON(request.geometry)===canonicalJSON(planner.output.data.geometry):!!plan&&canonicalJSON(plan)===canonicalJSON(planner.output.data));
  if(matches)request.orchestration_ref=plannerReference;
  const value=await api('/api/workflow/prepare',request);
  if(!executionCurrent(token))return;
  withRecordedGeometry(inputGeometry(value.plan));
  showWorkflow(value);
  const origin=matches?'Matching model proposal attached.':'Direct preparation. No model proposal attached.';
  $('execution-message').textContent=origin+' '+$('execution-message').textContent;
  await refreshHistory();
 }catch(error){if(executionCurrent(token)){$('run-state').textContent='PREPARATION FAILED';executionError(error);}}
};
$('approve-compute').onclick=async()=>{
 let token=executionSnapshot();try{
  const workflow=currentExecutableWorkflow();if(!workflow||['queued','running'].includes(workflow.state))return;
  token=beginWorkflowRequest();const value=await api('/api/workflow/approve',{reference:workflow.reference,...JSON.parse(token.source)});
  if(workflowResponseCurrent(token,value,workflow.reference))showWorkflow(value);
 }catch(error){workflowRequestError(token,error);}
};
$('run-compute').onclick=async()=>{
 let token=executionSnapshot();try{
  const workflow=currentExecutableWorkflow();if(!workflow||workflow.state!=='approved')return;
  token=beginWorkflowRequest();const value=await api('/api/workflow/submit',{reference:workflow.reference});
  if(!workflowResponseCurrent(token,value,workflow.reference))return;showWorkflow(value);pollWorkflow(value.reference,token);
 }catch(error){workflowRequestError(token,error);}
};
$('cancel-compute').onclick=async()=>{
 let token=executionSnapshot();try{
  if(activeWorkflow?.state!=='running')return;const reference=activeWorkflow.reference;
  token=beginWorkflowRequest();await api('/api/workflow/cancel',{reference});
  if(!executionCurrent(token))return;$('execution-message').textContent='Cancellation requested. Waiting for process-tree teardown.';pollWorkflow(reference,token);
 }catch(error){workflowRequestError(token,error);}
};
$('job-history').onchange=async()=>{
 const reference=$('job-history').value;clearExecution(reference?'Loading the selected calculation…':'Select a calculation to review.','HISTORY');
 if(!reference)return;$('job-history').value=reference;const token=executionSnapshot();
 try{
  const value=await api('/api/workflow/read',{reference});
  if(!workflowResponseCurrent(token,value,reference)||$('job-history').value!==reference)return;
  showWorkflow(value);if(['running','queued'].includes(value.state))pollWorkflow(reference,executionSnapshot());
 }catch(error){workflowRequestError(token,error);}
};
$('download-evidence').onclick=()=>{if(activeWorkflow?.result)download(activeWorkflow,'workbench.execution-evidence.json');};
async function refreshProjects(){savedProjects=await api('/api/projects');$('project-history').replaceChildren(new Option('Select a revision',''));for(const item of savedProjects)$('project-history').append(new Option(`${item.name} · ${item.revision.slice(-8)}`,item.revision));}
$('save-project').onclick=async()=>{try{const record=await api('/api/project/save',{name:$('project-name').value,...sourcePayload(),orchestration:agentRecord});savedRevision=true;$('save-state').textContent=`Saved · ${record.revision.slice(-8)}`;await refreshProjects();}catch(error){$('save-state').textContent=error.message;}};
$('project-history').onchange=async()=>{const record=savedProjects.find(p=>p.revision===$('project-history').value);if(!record)return;if(!savedRevision&&!confirm('Discard unsaved changes and open this revision?'))return;$('source').value=record.source;attachments={...record.attachments};invalidate();agentRecord=record.orchestration;$('project-name').value=record.name;await compile();savedRevision=true;$('save-state').textContent=`Opened · ${record.revision.slice(-8)}`;};
async function initializeExecution(){const token=executionSnapshot(),geometry=$('water-geometry').value;try{const profiles=await api('/api/profiles');if(executionCurrent(token)&&$('water-geometry').value===geometry)$('water-geometry').value=JSON.stringify(profiles.water_geometry,null,2);await refreshHistory();await refreshProjects();}catch(error){if(executionCurrent(token))executionError(error);}}
initializeExecution();

function alignProposalGeometry(proposal){
 const target=proposal?.object_id||proposal?.subject_ref;
 const geometry=proposal?.geometry?inputGeometry({object_id:target,subject:{subject_ref:target,geometry:proposal.geometry,geometry_hash:proposal.geometry_hash}}):proposal?.candidates?inputGeometry({subject:{subject_ref:target},candidates:proposal.candidates}):null;
 if(geometry&&result?.scene?.structures?.some(item=>item.object_id===target)){$('structure-select').value=target;displayGeometry(geometry);$('unavailable-geometry').textContent=(result.scene.unavailable||[]).map(item=>`${item.object_id}: ${item.reason}`).join(' · ');return '';}
 $('structure-select').value='';const message=`Complete input geometry for the proposed subject ${target||'(unspecified)'} is unavailable in the current workspace. No other structure is substituted.`;
 clearGeometry(message);$('unavailable-geometry').textContent=message;return ' '+message;
}
document.addEventListener('water-proposed',event=>{resetExecution();$('compute-profile').value='water';$('water-input').hidden=false;if($('molecular-profile-note'))$('molecular-profile-note').hidden=true;$('water-geometry').value=JSON.stringify(event.detail.geometry,null,2);const geometryNotice=alignProposalGeometry(event.detail);$('execution-message').textContent='Water installation fixture proposed. Review the coordinates, then prepare and approve.'+geometryNotice;});

window.confirmWorkspaceReplacement=()=>savedRevision||!$('source').value||confirm('Discard unsaved changes and replace this workspace?');

document.addEventListener('molecular-proposed',event=>{resetExecution();$('compute-profile').value='molecular';$('water-input').hidden=true;if($('molecular-profile-note'))$('molecular-profile-note').hidden=false;const geometryNotice=alignProposalGeometry(event.detail);$('execution-message').textContent='Source-generated molecular conformer proposed. Review the structure and exact inputs, then prepare and approve the single-point calculation.'+geometryNotice;});

document.addEventListener('copper-proposed',event=>{resetExecution();$('compute-profile').value='copper';$('water-input').hidden=true;if($('molecular-profile-note'))$('molecular-profile-note').hidden=true;const geometryNotice=alignProposalGeometry(event.detail||currentPlan);$('execution-message').textContent='Copper lattice scan proposed. Review the candidate scales, then prepare and approve.'+geometryNotice;});
