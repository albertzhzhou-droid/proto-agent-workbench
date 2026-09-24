import {createHash} from "node:crypto";
import {lstat, mkdir, open, realpath, writeFile} from "node:fs/promises";
import {dirname, isAbsolute, join, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {BUILD_INPUT_ROOTS, captureBuildInputs} from "./build-input-snapshot.mjs";

const APP="apps/proto-workbench";
const compare=(a,b)=>a<b?-1:a>b?1:0;
const hash=value=>createHash("sha256").update(typeof value==="string"?value:JSON.stringify(value)).digest("hex");
// Reuse the maintained release source allowlist and its generated-file rules.
// Installed dependencies are intentionally excluded from this development ID.
export const IDENTITY_INPUT_ROOTS=Object.freeze(BUILD_INPUT_ROOTS.filter(path=>path!==`${APP}/node_modules`).sort(compare));
export const IDENTITY_LOCK_PATHS=Object.freeze(["uv.lock",`${APP}/pnpm-lock.yaml`].sort(compare));
const profiles=Object.freeze({
  renderer:{outputs:[`${APP}/dist`],required:[`${APP}/dist/index.html`]},
  desktop:{outputs:[`${APP}/out`],required:[`${APP}/out/main/index.js`,`${APP}/out/preload/index.cjs`,`${APP}/out/renderer/index.html`,`${APP}/out/module-manifest.json`]},
});
const SCOPE="Working-tree source and generated output content identity; not dependency installation, reproducibility, packaged integrity, native execution, or clean-machine acceptance.";

function profileFor(name) {if(!Object.hasOwn(profiles,name))throw Error("Unknown content identity profile.");return profiles[name];}
function same(left,right,label) {if(JSON.stringify(left)!==JSON.stringify(right))throw Error(`${label} changed or does not match the recorded content identity.`);}
function canonicalSnapshot(snapshot) {
  // Avoid locale-dependent ordering from the older release snapshot format.
  const records=[...snapshot.records].sort((a,b)=>compare(a.path,b.path));
  return {...snapshot,roots:[...snapshot.roots].sort(compare),records,treeSha256:hash(records)};
}
async function snapshot(root,roots,includeIgnored=false) {return canonicalSnapshot(await captureBuildInputs(await realpath(root),roots,{includeIgnored}));}
function lockRecords(source) {
  return IDENTITY_LOCK_PATHS.map(path=>{
    const record=source.records.find(item=>item.path===path&&item.kind==="file");
    if(!record)throw Error(`Required dependency lock is absent: ${path}`);
    return {path,sizeBytes:record.sizeBytes,sha256:record.sha256};
  });
}
function captureMaterial(capture) {
  return {schemaVersion:capture.schemaVersion,profile:capture.profile,source:capture.source,dependencyLocks:capture.dependencyLocks,
    dependencyLocksSha256:capture.dependencyLocksSha256,sourceAuthority:capture.sourceAuthority,installedDependencies:capture.installedDependencies};
}
function validateCapture(capture) {
  profileFor(capture?.profile);
  if(capture.schemaVersion!=="proto-workbench.content-inputs.v1")throw Error("Unsupported content input schema.");
  same(capture.source?.roots,IDENTITY_INPUT_ROOTS,"Source allowlist");
  same(capture.dependencyLocks,lockRecords(capture.source),"Dependency lock records");
  if(capture.dependencyLocksSha256!==hash(capture.dependencyLocks)||capture.inputSha256!==hash(captureMaterial(capture)))throw Error("Content input digest mismatch.");
}

export async function captureIdentityInputs(repoRoot,profile) {
  profileFor(profile);
  const source=await snapshot(repoRoot,IDENTITY_INPUT_ROOTS), dependencyLocks=lockRecords(source);
  const capture={schemaVersion:"proto-workbench.content-inputs.v1",profile,source,dependencyLocks,
    dependencyLocksSha256:hash(dependencyLocks),sourceAuthority:"Allowlisted working-tree bytes, including uncommitted and untracked files; Git cleanliness is not assumed.",
    installedDependencies:"Not hashed by this profile; lockfile content does not prove installed dependency integrity."};
  return {...capture,inputSha256:hash(captureMaterial(capture))};
}
async function assertCurrentInputs(root,capture) {
  validateCapture(capture);
  same(captureMaterial(capture),captureMaterial(await captureIdentityInputs(root,capture.profile)),"Source or dependency lock");
}
async function outputSnapshot(root,profile) {
  // Input-cache exclusions must never hide bytes in the final output inventory.
  const config=profileFor(profile), output=await snapshot(root,config.outputs,true);
  for(const path of config.required) if(!output.records.some(item=>item.path===path&&item.kind==="file"))throw Error(`Required build output is absent: ${path}`);
  return output;
}
function identityMaterial(identity) {
  return {schemaVersion:identity.schemaVersion,profile:identity.profile,input:identity.input,output:identity.output,scope:identity.scope};
}

export async function sealBuildIdentity(repoRoot,capture) {
  await assertCurrentInputs(repoRoot,capture);
  const output=await outputSnapshot(repoRoot,capture.profile);
  // Do not pair an earlier source state with outputs hashed after a source edit.
  await assertCurrentInputs(repoRoot,capture);
  const identity={schemaVersion:"proto-workbench.build-content-identity.v1",profile:capture.profile,input:capture,output,scope:SCOPE};
  return {...identity,contentId:hash(identityMaterial(identity))};
}

export async function verifyBuildIdentity(repoRoot,identity) {
  if(identity?.schemaVersion!=="proto-workbench.build-content-identity.v1"||identity.profile!==identity.input?.profile||identity.scope!==SCOPE)throw Error("Unsupported build content identity.");
  if(identity.contentId!==hash(identityMaterial(identity)))throw Error("Build content identity digest mismatch.");
  same(identity.output?.roots,profileFor(identity.profile).outputs,"Output allowlist");
  await assertCurrentInputs(repoRoot,identity.input);
  same(identity.output,await outputSnapshot(repoRoot,identity.profile),"Build output");
  return {ok:true,contentId:identity.contentId,sourceSha256:identity.input.source.treeSha256,
    dependencyLocksSha256:identity.input.dependencyLocksSha256,outputSha256:identity.output.treeSha256,scope:SCOPE};
}

async function evidencePath(repoRoot,path,create=false) {
  const root=await realpath(repoRoot),absolute=resolve(root,path),rel=relative(root,absolute).replaceAll("\\","/");
  const prefix=`${APP}/build/content-identity/`;
  if(isAbsolute(rel)||!rel.startsWith(prefix)||rel.split("/").some(part=>!part||part==="."||part===".."||/[\x00-\x1f\x7f:]/.test(part)))throw Error("Identity evidence must stay in apps/proto-workbench/build/content-identity/.");
  let current=root;
  for(const part of rel.split("/").slice(0,-1)) {
    current=join(current,part);
    if(create)await mkdir(current).catch(error=>{if(error.code!=="EEXIST")throw error;});
    const metadata=await lstat(current);
    if(!metadata.isDirectory()||metadata.isSymbolicLink())throw Error("Identity evidence cannot cross a directory link.");
  }
  return absolute;
}
async function readEvidence(repoRoot,path) {
  const absolute=await evidencePath(repoRoot,path),before=await lstat(absolute,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>16n*1024n*1024n)throw Error("Unsafe or oversized identity evidence.");
  const handle=await open(absolute,"r");
  try {
    const opened=await handle.stat({bigint:true});
    if(opened.ino!==before.ino||opened.dev!==before.dev||opened.size!==before.size)throw Error("Identity evidence changed before opening.");
    const buffer=Buffer.alloc(Number(opened.size)+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0),after=await handle.stat({bigint:true});
    if(BigInt(bytesRead)!==opened.size||after.size!==opened.size||after.mtimeNs!==opened.mtimeNs||after.ctimeNs!==opened.ctimeNs)throw Error("Identity evidence changed while reading.");
    return JSON.parse(buffer.subarray(0,bytesRead).toString("utf8"));
  } finally {await handle.close();}
}
async function writeEvidence(root,path,data) {
  const absolute=await evidencePath(root,path,true);
  await writeFile(absolute,JSON.stringify(data,null,2)+"\n",{flag:"wx"});
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const option=name=>{const index=process.argv.indexOf(name);if(index<0||!process.argv[index+1])throw Error(`Missing ${name}`);return process.argv[index+1];};
    const root=option("--repo"),manifest=option("--manifest"),command=process.argv[2];
    let result;
    if(command==="capture") {
      const capture=await captureIdentityInputs(root,option("--profile"));await writeEvidence(root,manifest,capture);
      result={ok:true,inputSha256:capture.inputSha256,sourceSha256:capture.source.treeSha256,dependencyLocksSha256:capture.dependencyLocksSha256,scope:SCOPE};
    } else if(command==="seal") {
      const identity=await sealBuildIdentity(root,await readEvidence(root,option("--capture")));await writeEvidence(root,manifest,identity);
      result={ok:true,contentId:identity.contentId,outputSha256:identity.output.treeSha256,scope:SCOPE};
    } else if(command==="verify") result=await verifyBuildIdentity(root,await readEvidence(root,manifest));
    else throw Error("Expected capture, seal or verify.");
    process.stdout.write(JSON.stringify(result)+"\n");
  } catch(error) {process.stderr.write(JSON.stringify({ok:false,message:String(error)})+"\n");process.exitCode=1;}
}
