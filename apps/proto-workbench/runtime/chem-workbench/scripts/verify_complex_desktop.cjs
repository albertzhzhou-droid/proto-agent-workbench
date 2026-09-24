'use strict';
// Actual native functional acceptance on development molecules, separate from held-out scoring.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {_electron}=require(process.env.CHEM_PLAYWRIGHT_PATH);
const root=path.resolve(__dirname,'..');
const output=path.resolve(process.env.CHEM_ACCEPTANCE_DIR||path.join(root,'build','complex-desktop-'+Date.now()));
assert.ok(output.startsWith(path.join(root,'build')+path.sep));
fs.mkdirSync(output,{recursive:false});
const info=JSON.parse(fs.readFileSync(path.join(root,'build','desktop-latest.json'),'utf8'));
(async()=>{
 const app=await _electron.launch({executablePath:info.executable,args:[],timeout:60000});
 const page=await app.firstWindow({timeout:60000});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.locator('#status').getByText('Passed',{exact:true}).waitFor({timeout:30000});
  await page.locator('#model-status').getByText(/Connected/).waitFor({timeout:30000});
  assert.equal(await page.locator('#atom-count').innerText(),'24');
  assert.equal(await page.locator('#viewer-empty').isHidden(),true);
  assert.equal(await page.locator('#molecule-viewer canvas').count(),1);
  const model=await page.locator('#model-name').innerText();
  await page.locator('#objective').fill('Prepare a source-generated caffeine conformer for a neutral singlet HF/STO-3G gas-phase 0 K single-point energy proposal. Do not execute.');
  await page.locator('#orchestrate').click();
  await page.locator('#agent-progress').getByText(/REPORTED.*1 tool call/).waitFor({timeout:120000});
  assert.equal(await page.locator('#compute-profile').inputValue(),'molecular');
  await page.locator('#prepare-compute').click();
  await page.locator('#run-state').getByText(/^PREPARED$/).waitFor({timeout:60000});
  await page.locator('#execution-message').getByText(/Matching model proposal attached/).waitFor();
  assert.equal(await page.locator('#run-compute').isDisabled(),true);
  await page.locator('#approve-compute').click();
  await page.locator('#run-state').getByText('APPROVED',{exact:true}).waitFor({timeout:60000});
  await page.locator('#run-compute').click();
  await page.locator('#run-state').getByText('SUCCEEDED',{exact:true}).waitFor({timeout:360000});
  await page.locator('#computed-results').getByText(/HF\/STO-3G.*hartree.*SCF converged/).waitFor();
  await page.locator('#project-name').fill('Complex molecule acceptance');
  await page.locator('#save-project').click();
  await page.locator('#save-state').getByText(/Saved/).waitFor();
  await page.screenshot({path:path.join(output,'complex-calculation.png'),fullPage:true});

  const exports=path.join(info.directory,'workspace','build','exports');
  const prior=new Set(fs.existsSync(exports)?fs.readdirSync(exports):[]);
  await page.locator('#download-evidence').click();
  let name;
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){
   name=fs.existsSync(exports)&&fs.readdirSync(exports).find(item=>!prior.has(item)&&item.endsWith('-workbench.execution-evidence.json'));
   if(name)break;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(name,'A new evidence export must be saved');
  fs.copyFileSync(path.join(exports,name),path.join(output,'complex-evidence.json'));
  const evidence=JSON.parse(fs.readFileSync(path.join(output,'complex-evidence.json'),'utf8'));
  assert.equal(evidence.state,'succeeded');assert.equal(evidence.result.evidence_eligible,true);
  assert.equal(evidence.plan.kind,'molecular_hf_sto3g');
  assert.ok(evidence.orchestration_ref);
  assert.equal(evidence.plan.subject.proposal.geometry_provenance.measured,false);
  assert.ok(evidence.plan.subject.proposal.complexity.heavy_atoms>=8);

  // A new source invalidates the prior energy and approval before another proposal.
  await page.getByRole('button',{name:'◇  aspirin.chem',exact:true}).click();
  assert.equal(await page.locator('#run-compute').isDisabled(),true);
  assert.equal(await page.locator('#download-evidence').isDisabled(),true);
  await page.locator('#computed-results').getByText('No computed evidence yet.',{exact:true}).waitFor();
  await page.locator('#compile').click();
  await page.locator('#status').getByText('Passed',{exact:true}).waitFor();
  assert.equal(await page.locator('#atom-count').innerText(),'21');
  await page.locator('#objective').fill('Prepare aspirin with measured Cartesian coordinates that I have not uploaded. Do not generate replacement positions.');
  await page.locator('#orchestrate').click();
  await page.locator('#agent-progress').getByText(/NEEDS_INPUT.*0 tool call/).waitFor({timeout:120000});
  assert.equal(await page.locator('#run-compute').isDisabled(),true);
  await page.locator('#save-project').click();
  await page.locator('#save-state').getByText(/Saved/).waitFor();
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:path.join(output,'complex-viewport.png'),fullPage:false});
  const security=await app.evaluate(({BrowserWindow})=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration};});
  assert.deepEqual(security,{sandbox:true,contextIsolation:true,nodeIntegration:false});
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'desktop-acceptance.json'),JSON.stringify({passed:true,model,package:info.directory,security,errors,checks:['Complex source-derived WebGL geometry','Actual model proposal with exact provenance','Separate explicit host approval','Actual complex HF/STO-3G computation','Evidence export independently reopened','Source change clears previous evidence and approval','Model clarifies missing measured coordinates'],scope:'Native functional acceptance on known development molecules; not held-out model scoring'},null,2));
  console.log(output);
 }finally{
  await page.locator('#save-project').click().catch(()=>{});
  await page.locator('#save-state').getByText(/Saved/).waitFor({timeout:5000}).catch(()=>{});
  await app.close();
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
