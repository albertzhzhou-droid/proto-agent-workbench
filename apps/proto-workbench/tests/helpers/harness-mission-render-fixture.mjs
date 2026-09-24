import {readFile, mkdir, writeFile} from "node:fs/promises";
import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve, join} from "node:path";
import {randomUUID} from "node:crypto";
import ts from "typescript";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";

const app = fileURLToPath(new URL("../../", import.meta.url));
export const FIXTURE_NOTICE = "Synthetic software acceptance fixture only. No model, scientific tool, or real task is executed.";
export function projection(overrides = {}) {
  return {
    runId: "synthetic/diagnostics:fixture", threadId: "synthetic-thread", state: "needs-human", revision: 5, round: 3,
    generatedTokens: 222, activeTimeMs: 6000, contextTokens: 32768, contextUsed: 1200, tokenCountMethod: "exact", resultCount: 2,
    deliveredPaths: [], resumable: false, hostRecovered: false,
    repairBudget: {outputRepairs: 1, progressRepairs: 1, verifyRepairs: 0},
    abstention: {reason: "The synthetic exporter cannot establish this required receipt.", unmetRequirements: ["build/fixture.png needs a verified renderer receipt"], declaredAt: "2026-09-23T12:00:00.000Z"},
    verdicts: [{callId: "synthetic-finish", round: 3, recordedAt: "2026-09-23T12:00:00.000Z", action: "needs-human", passed: [], diagnostics: [
      {code: "RENDERER_RECEIPT_UNAVAILABLE", blockingClass: "unsupported", subject: "build/fixture.png", message: "No trusted renderer receipt exists for this synthetic fixture.", evidenceRefs: ["synthetic-receipt-1"]},
    ]}],
    diagnosticCounts: {unsupported: 1}, toolCallCounts: {workspace_read: 2},
    budgets: {activeTimeMs: 7200000, maxRounds: 128, maxGeneratedTokens: 65536},
    ...overrides,
  };
}
export const fixtureState = checkpoint => ({selectedRunId: checkpoint.runId, events: [{runId: checkpoint.runId, summary: "Synthetic verification fixture", payload: {harness: checkpoint}}], isAgentRunning: false, thread: {id: checkpoint.threadId}, openEvidenceArtifact() {}});
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

/** Render the unchanged production component with real React. Only app state
 * and IPC boundaries are fixture supplied; JSX handlers remain production
 * closures so the download action can be invoked without a fake export. */
export async function loadMissionPanelFixture() {
  const key = `__protoMissionFixture_${randomUUID().replaceAll("-", "")}`;
  const fixture = {state: fixtureState(projection()), elements: []};
  globalThis[key] = fixture;
  const stateModule = moduleUrl(`const fixture=globalThis[${JSON.stringify(key)}]; export const useWorkbenchStore=selector=>selector(fixture.state); useWorkbenchStore.setState=update=>Object.assign(fixture.state,update);`);
  const apiModule = moduleUrl("export const workbenchApi=()=>({harness:{listExecutions:async()=>[],resumeExecution:async()=>{},pauseExecution:async()=>{}}});");
  const jsxModule = moduleUrl(`import {jsx as realJsx,jsxs as realJsxs,Fragment} from ${JSON.stringify(import.meta.resolve("react/jsx-runtime"))}; export {Fragment}; const record=(factory,type,props,key)=>{globalThis[${JSON.stringify(key)}].elements.push({type,props});return factory(type,props,key)}; export const jsx=(...args)=>record(realJsx,...args); export const jsxs=(...args)=>record(realJsxs,...args);`);
  const imports = new Map([
    ["react", import.meta.resolve("react")], ["react/jsx-runtime", jsxModule], ["lucide-react", import.meta.resolve("lucide-react")],
    ["../shared/harness.ts", pathToFileURL(join(app, "src/shared/harness.ts")).href],
    ["./harness-projection.ts", pathToFileURL(join(app, "src/renderer/harness-projection.ts")).href],
    ["./store.ts", stateModule], ["./mock-api.ts", apiModule],
  ]);
  const source = await readFile(join(app, "src/renderer/HarnessMissionPanel.tsx"), "utf8");
  const compiled = ts.transpileModule(source, {fileName: "HarnessMissionPanel.tsx", compilerOptions: {jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext},
    transformers: {after: [context => node => ts.visitNode(node, function visit(child) {
      if (ts.isImportDeclaration(child)) {
        const replacement = imports.get(child.moduleSpecifier.text);
        if (!replacement) throw new Error(`New renderer dependency needs an explicit fixture boundary: ${child.moduleSpecifier.text}`);
        return ts.factory.updateImportDeclaration(child, child.modifiers, child.importClause, ts.factory.createStringLiteral(replacement), child.attributes);
      }
      return ts.visitEachChild(child, visit, context);
    })]},
  });
  const {HarnessMissionPanel} = await import(moduleUrl(compiled.outputText));
  return {
    render(checkpoint) {fixture.state = fixtureState(checkpoint); fixture.elements = []; return renderToStaticMarkup(React.createElement(HarnessMissionPanel));},
    elements: () => fixture.elements,
    dispose() {delete globalThis[key];},
  };
}

export async function writeBrowserFixture() {
  const output = resolve(app, "../../build/harness-iteration-ui");
  await mkdir(output, {recursive: true});
  const fsUrl = path => `/@fs/${path.replaceAll("\\", "/")}`;
  const source = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {HarnessMissionPanel} from ${JSON.stringify(fsUrl(join(app, "src/renderer/HarnessMissionPanel.tsx")))};
import {useWorkbenchStore} from ${JSON.stringify(fsUrl(join(app, "src/renderer/store.ts")))};
import ${JSON.stringify(fsUrl(join(app, "src/renderer/styles.css")))};
import ${JSON.stringify(fsUrl(join(app, "src/renderer/workbench-theme.css")))};
import ${JSON.stringify(fsUrl(join(app, "src/renderer/paper-workbench.css")))};
const base=${JSON.stringify(projection())};
let current=base;
window.workbench={harness:{listExecutions:async()=>[current],pauseExecution:async()=>{throw new Error('Synthetic fixture does not execute or pause real tasks')},resumeExecution:async()=>{throw new Error('Synthetic fixture does not execute or resume real tasks')}}};
const scenarios={
 'Human review':base,
 'Model abstention':{...base,state:'abstained',verdicts:[],diagnosticCounts:{},abstention:{...base.abstention,reason:'Synthetic model declared insufficient evidence.',unmetRequirements:['A required software fixture is unavailable.']}},
 'Repaired completion':{...base,state:'completed',abstention:undefined,verdicts:[{...base.verdicts[0],action:'repair',diagnostics:[{code:'SYNTHETIC_REPORT_MISSING',blockingClass:'repairable',subject:'build/report.txt',message:'A report is required.',evidenceRefs:['synthetic-read'],remedy:{tool:'workspace_propose_patch',reason:'Create the authorized synthetic report.'}}]},{...base.verdicts[0],callId:'synthetic-final',round:4,action:'completed',diagnostics:[],passed:['build/report.txt']}],diagnosticCounts:{repairable:1}},
 'Legacy counters':{...base,repairBudget:{outputRepairs:0,progressRepairs:0},contextUsed:undefined,tokenCountMethod:undefined},
};
const render=name=>{current=structuredClone(scenarios[name]);useWorkbenchStore.setState({selectedRunId:current.runId,events:[{runId:current.runId,summary:'Synthetic verification fixture',payload:{harness:current}}],isAgentRunning:false,thread:{id:current.threadId},openEvidenceArtifact:async()=>{}});};
render('Human review');
createRoot(document.getElementById('root')).render(<><header style={{padding:16}}><strong>${FIXTURE_NOTICE}</strong><nav style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:12}}>{Object.keys(scenarios).map(name=><button key={name} onClick={()=>render(name)}>{name}</button>)}</nav></header><HarnessMissionPanel/></>);
`;
  await writeFile(join(output, "fixture.tsx"), source);
  await writeFile(join(output, "index.html"), `<!doctype html><html lang="en" data-theme="light"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic Harness diagnostics acceptance</title><body style="margin:0;overflow:auto"><div id="root"></div><script type="module" src=${JSON.stringify(fsUrl(join(output, "fixture.tsx")))}></script></body></html>`);
  const server = `import {createServer} from ${JSON.stringify(import.meta.resolve("vite"))};
import react from ${JSON.stringify(import.meta.resolve("@vitejs/plugin-react"))};
import {readFile} from 'node:fs/promises';
const root=${JSON.stringify(app)}, fixture=${JSON.stringify(join(output, "index.html"))};
const server=await createServer({configFile:false,root,resolve:{dedupe:['react','react-dom']},plugins:[react(),{name:'synthetic-harness-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url!=='/'&&req.url!=='/fixture.html')return next();try{const html=await server.transformIndexHtml('/fixture.html',await readFile(fixture,'utf8'));res.statusCode=200;res.setHeader('Content-Type','text/html');res.end(html)}catch(error){next(error)}})}}],server:{host:'127.0.0.1',port:5201,strictPort:true,fs:{allow:[${JSON.stringify(resolve(app, "../.."))}]}},optimizeDeps:{include:['react','react-dom/client']}});
await server.listen();server.printUrls();
`;
  await writeFile(join(output, "serve.mjs"), server);
  return output;
}
if (process.argv.includes("--write-browser-fixture")) console.log(await writeBrowserFixture());
