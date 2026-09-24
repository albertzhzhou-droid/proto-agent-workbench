import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {execFile} from "node:child_process";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {join,relative,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {McpClient} from "../src/main/services/mcp-client.ts";

const repo=resolve(fileURLToPath(new URL("../../../",import.meta.url)));
const root=join(repo,"build","chat-runtime-qa",new Date().toISOString().replace(/[:.]/g,"-"));
await mkdir(root,{recursive:true});
const rel=path=>relative(repo,path).replaceAll("\\","/");
const mcp=new McpClient({packaged:false,resourcesPath:"",repoRoot:repo,workspacePath:repo,workspaceCapability:randomBytes(32).toString("hex"),pythonExecutable:join(repo,process.platform==="win32"?".venv/Scripts/python.exe":".venv/bin/python")});
const checks=[];
async function call(name,args,verify){
  const startedAt=new Date().toISOString();
  const result=await mcp.call(name,args);
  const artifact=result.stdout_path?await readFile(join(repo,result.stdout_path),"utf8"):"";
  await writeFile(join(root,`${checks.length+1}-${name}.json`),JSON.stringify(result,null,2));
  verify(result,artifact);
  checks.push({name,startedAt,ok:true,manifest_path:result.manifest_path,stdout:artifact});
  console.log(`${name}: verified ${result.manifest_path}`);
  return result;
}
try {
  const capabilities=await mcp.capabilities();
  assert.equal(capabilities.execution.mode,"oci");assert.equal(capabilities.execution.provider,"docker-wsl");
  const python=join(root,"analysis.py");
  await writeFile(python,`import json,os,socket\nfrom pathlib import Path\nimport numpy as np\nimport pandas as pd\nimport scipy.stats as stats\nassert os.geteuid() != 0\nx=np.array([2,4,6,8,10])\nassert float(np.mean(x)) == 6\nassert abs(float(np.std(x,ddof=1))-3.1622776601683795) < 1e-12\ntry:\n    Path('/workspace/blocked-write.txt').write_text('bad')\n    raise AssertionError('workspace was writable')\nexcept OSError:\n    pass\ntry:\n    socket.create_connection(('1.1.1.1',53),timeout=1)\n    raise AssertionError('network was available')\nexcept OSError:\n    pass\nlimits={name:Path('/sys/fs/cgroup/'+name).read_text().strip() for name in ['pids.max','memory.max','cpu.max']}\nassert limits['pids.max'] == '64', limits\nassert limits['memory.max'] == '536870912', limits\nassert limits['cpu.max'].split()[0] == limits['cpu.max'].split()[1], limits\nresult={'mean':float(np.mean(x)),'sample_sd':float(np.std(x,ddof=1)),'uid':os.geteuid(),'limits':limits,'versions':{'numpy':np.__version__,'pandas':pd.__version__}}\nPath(os.environ['PROTO_AGENT_RUN_DIR'],'statistics.json').write_text(json.dumps(result))\nprint(json.dumps(result))\n`);
  await call("proto_run_analysis",{script:rel(python),timeout:90},(result,stdout)=>{assert.equal(result.ok,true);assert.equal(result.sandboxed,true);assert.equal(JSON.parse(stdout).mean,6);});
  const r=join(root,"analysis.r");
  await writeFile(r,`x <- c(2,4,6,8,10)\nstopifnot(mean(x)==6,abs(sd(x)-sqrt(10))<1e-12)\nwrite.csv(data.frame(mean=mean(x),sample_sd=sd(x)), file.path(Sys.getenv("PROTO_AGENT_RUN_DIR"),"statistics.csv"),row.names=FALSE)\ncat("mean=",mean(x)," sample_sd=",sd(x),"\\n")\n`);
  await call("proto_run_r",{script:rel(r),timeout:90},(result,stdout)=>{assert.equal(result.ok,true);assert.match(stdout,/mean= 6/);});
  const notebook=(cells,kernel="python3")=>JSON.stringify({nbformat:4,nbformat_minor:5,metadata:{kernelspec:{name:kernel,display_name:kernel,language:kernel==="ir"?"R":"python"}},cells:cells.map((source,index)=>({id:`cell${index}`,cell_type:"code",metadata:{},source,execution_count:null,outputs:[]}))});
  const ipynb=join(root,"research.ipynb");
  await writeFile(ipynb,notebook(["import numpy as np\nx=np.array([2,4,6,8,10])\nprint('Notebook mean:', x.mean())","import matplotlib.pyplot as plt\nplt.plot(x)\nplt.title('Execution smoke fixture')\nplt.show()"]));
  const executed=await call("proto_run_notebook",{path:rel(ipynb),timeout:120},(result,stdout)=>{assert.equal(result.ok,true);assert.match(stdout,/Notebook mean: 6/);assert.ok(result.executed_notebook);assert.ok(result.html_path);});
  const content=JSON.parse(await readFile(join(repo,executed.executed_notebook),"utf8"));
  assert.equal(content.cells[0].execution_count,1);assert.equal(content.cells[1].execution_count,2);
  assert.ok(content.cells[1].outputs.some(output=>output.data?.["image/png"]),"Notebook contains a real rendered plot");
  const rnb=join(root,"research-r.ipynb");await writeFile(rnb,notebook(["x <- c(2,4,6,8,10)\ncat('R notebook mean:',mean(x))"],"ir"));
  await call("proto_run_notebook",{path:rel(rnb),timeout:120},(result,stdout)=>{assert.equal(result.ok,true);assert.match(stdout,/R notebook mean: 6/);});
  const errornb=join(root,"error.ipynb");await writeFile(errornb,notebook(["print('completed first cell')","raise ValueError('expected notebook failure')","print('must never execute')"]));
  const failed=await call("proto_run_notebook",{path:rel(errornb),timeout:120},(result,stdout)=>{assert.equal(result.ok,false);assert.equal(result.returncode,1);assert.match(stdout,/completed first cell/);assert.doesNotMatch(stdout,/must never execute/);});
  const failedContent=JSON.parse(await readFile(join(repo,failed.executed_notebook),"utf8"));
  assert.ok(failedContent.cells[1].outputs.some(output=>output.output_type==="error"));assert.equal(failedContent.cells[2].execution_count,null);
  const slow=join(root,"slow.py");await writeFile(slow,"import time\ntime.sleep(60)\n");
  const timed=await call("proto_run_analysis",{script:rel(slow),timeout:3},result=>{assert.equal(result.ok,false);assert.equal(result.timed_out,true);assert.equal(result.returncode,124);});
  const containerName=timed.command[timed.command.indexOf("--name")+1];
  const config=JSON.parse(await readFile(join(repo,".proto-agent/sandbox.json"),"utf8"));
  const check=await promisify(execFile)("wsl.exe",["--distribution",config.wslDistribution,"--user",config.wslUser,"--exec",config.wslDockerPath||"/usr/bin/docker","--host",config.wslSocket,"ps","--all","--filter",`name=^/${containerName}$`,"--format","{{.ID}}"],{windowsHide:true,timeout:10000});
  assert.equal(check.stdout.trim(),"","Timed out container was removed from the real Docker daemon");
  await writeFile(join(root,"verification.json"),JSON.stringify({ok:true,checks,capabilities},null,2));
  console.log(`PASS: ${checks.length} real sandbox executions; report ${rel(join(root,"verification.json"))}`);
} catch(error) {
  await writeFile(join(root,"verification.json"),JSON.stringify({ok:false,checks,error:String(error)},null,2));
  throw error;
} finally {await mcp.stop();}
