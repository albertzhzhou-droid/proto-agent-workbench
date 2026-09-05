/** Private copied runtime sources, shared dependency bytes measured by the
 * matrix before/after every task. This is not a release packaging snapshot. */
import {randomUUID} from "node:crypto";
import {mkdir,symlink,writeFile} from "node:fs/promises";
import {resolve,join} from "node:path";
import {fileURLToPath} from "node:url";
import {createBuildInputSnapshot} from "./build-input-snapshot.mjs";

const sourceRoot=fileURLToPath(new URL("../../../",import.meta.url));
const directory=resolve(sourceRoot,"build/upgrade-20260904/model-snapshots",`matrix-${new Date().toISOString().replace(/[:.]/g,"-")}-${randomUUID().slice(0,8)}`);
const destinationRoot=join(directory,"repository");
await mkdir(directory,{recursive:true});
const roots=["src/proto_agent","schemas",".codex/skills","AGENTS.md","connectors","workflows","literature","pyproject.toml","uv.lock","scripts/prepare_harness_inputs.py",
  ...["src","scripts","package.json","pnpm-lock.yaml","tsconfig.json"].map(path=>`apps/proto-workbench/${path}`)];
const manifest=await createBuildInputSnapshot({sourceRoot,destinationRoot,roots});
await symlink(join(sourceRoot,"apps/proto-workbench/node_modules"),join(destinationRoot,"apps/proto-workbench/node_modules"),process.platform==="win32"?"junction":"dir");
const launch={schema:"proto-workbench.frozen-matrix-launch.v1",destinationRoot,workingDirectory:join(destinationRoot,"apps/proto-workbench"),node:process.execPath,
  args:["--experimental-strip-types","scripts/verify-autonomous-harness.mjs","--run-matrix"],
  environment:{PROTO_AGENT_PYTHON:resolve(process.env.PROTO_AGENT_PYTHON||join(sourceRoot,process.platform==="win32"?".venv/Scripts/python.exe":".venv/bin/python")),
    PROTO_AGENT_MATERIALS_ROOT:resolve(process.env.PROTO_AGENT_MATERIALS_ROOT||join(sourceRoot,"../Proto CLI Materials")),
    PROTO_HARNESS_EVIDENCE_ROOT:join(sourceRoot,"build/upgrade-20260904/model-runs")},
  sourceTreeSha256:manifest.treeSha256,dependencyIsolation:"Shared installed dependency tree; every resolved runtime dependency file is measured before/after every task. Any drift invalidates the matrix. Sources are independent copied bytes.",
  inferenceStarted:false};
await writeFile(join(directory,"source-inputs.json"),JSON.stringify(manifest,null,2));
await writeFile(join(directory,"launch.json"),JSON.stringify(launch,null,2));
console.log(JSON.stringify({directory,sourceTreeSha256:manifest.treeSha256,fileCount:manifest.fileCount,inferenceStarted:false}));
