import {parseArgs} from "node:util";
import {resolve} from "node:path";
import {writeFile} from "node:fs/promises";
import {LmStudioProvider} from "../src/main/services/lm-studio-provider.ts";
import {loadFrozenPack, runFrozenEvaluation, readEvaluationReport} from "./harness-evaluation-core.mjs";

const {values,positionals}=parseArgs({allowPositionals:true,options:{out:{type:"string"},model:{type:"string"},instance:{type:"string"},load:{type:"boolean",default:false},iteration:{type:"string",default:"slice-b"},"attempt-ms":{type:"string",default:"60000"},"max-rounds":{type:"string",default:"6"},"max-tokens":{type:"string",default:"8192"},export:{type:"string"}}});
const command=positionals[0];
if(!["freeze","run","report"].includes(command))throw new Error("Usage: run-harness-evaluation.mjs freeze | run --out <new-dir> --model <model-id> --instance <loaded-instance-id> [--iteration slice-b] | report --out <campaign-dir> [--export <new-file>]");
if(command==="freeze"){
  const frozen=await loadFrozenPack();console.log(JSON.stringify({schema:frozen.pack.schema,sha256:frozen.sha256,tasks:frozen.pack.tasks.length,possible:frozen.pack.tasks.filter(t=>t.possible).length,impossible:frozen.pack.tasks.filter(t=>!t.possible).length},null,2));
}else if(command==="report"){
  if(!values.out)throw new Error("--out is required");const report=await readEvaluationReport(values.out);if(values.export)await writeFile(resolve(values.export),JSON.stringify(report,null,2)+"\n",{flag:"wx"});console.log(JSON.stringify(report,null,2));
}else{
  if(!values.out||!values.model||(!values.instance&&!values.load)||(values.instance&&values.load))throw new Error("--out, --model and exactly one of --instance or --load are required; model loading is explicit.");
  const provider=new LmStudioProvider(),models=await provider.scan(""),model=models.find(m=>m.id===values.model||m.providerModelId===values.model);
  if(!model)throw new Error("Requested exact model is absent from the native catalog.");
  if(values.load&&model.loadedInstances?.length)throw new Error("--load requires no loaded instances for the selected model; attach an explicit --instance instead.");
  if(!values.load&&!model.loadedInstances?.some(i=>i.id===values.instance))throw new Error("Requested exact model instance is not already loaded.");
  // Explicit instance selection takes only the production attach-existing path;
  // performLoad rejects a vanished requested instance rather than loading anew.
  const controller=new AbortController(),cancel=()=>controller.abort(Object.assign(new Error("Evaluation cancelled by operator."),{code:"EVALUATION_CANCELLED"}));process.on("SIGINT",cancel);process.on("SIGTERM",cancel);
  try{
    await provider.load(model,values.load?{contextLength:32768}:{instanceId:values.instance},controller.signal);
    const binding=await provider.getExecutionBinding(model.id,controller.signal);
    if(values.load&&(!binding.ownedByWorkbench||binding.contextLength!==32768))throw new Error("Owned 32,768-token evaluation instance was not established.");
    const report=await runFrozenEvaluation({out:values.out,provider,model,instanceId:binding.instanceId,iteration:values.iteration,attemptMs:Number(values["attempt-ms"]),maxRounds:Number(values["max-rounds"]),maxTokens:Number(values["max-tokens"]),signal:controller.signal,onProgress:event=>console.log(JSON.stringify(event))});console.log(JSON.stringify(report,null,2));}
  finally{process.off("SIGINT",cancel);process.off("SIGTERM",cancel);await provider.unload(model.id);}
}
