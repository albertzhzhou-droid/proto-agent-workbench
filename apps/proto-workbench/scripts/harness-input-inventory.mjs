import {createHash} from "node:crypto";
import {readFile, readdir, realpath, stat} from "node:fs/promises";
import {dirname, join, relative, resolve} from "node:path";
import {createRequire, isBuiltin} from "node:module";
import ts from "typescript";

const hash = value => createHash("sha256").update(value).digest("hex");
const codeFile = path => /\.(?:[cm]?js|tsx?|json|wasm|node|pem|crt|cer|glsl|wgsl)$/i.test(path);
const sourceFile = path => /\.(?:py|json|md)$/i.test(path);
async function walk(root, predicate, found = []) {
  for (const entry of await readdir(root, {withFileTypes:true})) {
    if (entry.name === "node_modules" || entry.name === "__pycache__") continue;
    const path = join(root,entry.name);
    if (entry.isDirectory()) await walk(path,predicate,found);
    else if (entry.isFile() && predicate(path)) found.push(path);
  }
  return found;
}

/** Hash the actual runtime source graph and installed dependency bytes. UI
 * components outside that graph do not invalidate a kernel-only model matrix. */
export async function captureImplementationInventory(repo, entry) {
  const files = new Set(), visited = new Set(), dependencies = new Map(), directories = [], pending = [resolve(entry)];
  const collectPackage = async (request, from) => {
    if (isBuiltin(request) || request.startsWith("node:")) return;
    const require = createRequire(from);
    let resolved;
    try {resolved=await realpath(require.resolve(request));}
    catch(error){
      const name=request.startsWith("@")?request.split("/").slice(0,2).join("/"):request.split("/")[0];
      for(const search of require.resolve.paths(name)??[]){const candidate=join(search,name,"package.json");if((await stat(candidate).catch(()=>undefined))?.isFile()){resolved=await realpath(candidate);break;}}
      if(!resolved)throw error;
    }
    let root = dirname(resolved);
    while (!(await stat(join(root,"package.json")).catch(()=>undefined))?.isFile()) {const parent=dirname(root);if(parent===root)throw new Error(`Cannot bind dependency ${request}`);root=parent;}
    if(dependencies.has(root))return;
    const metadata=JSON.parse(await readFile(join(root,"package.json"),"utf8"));
    dependencies.set(root,{name:metadata.name,version:metadata.version,root});
    directories.push({root,kind:"package"});
    for(const path of await walk(root,codeFile))files.add(path);
    for(const name of Object.keys(metadata.dependencies??{}))if(!name.startsWith("@types/"))await collectPackage(name,join(root,"package.json"));
  };
  while(pending.length){
    const path=await realpath(pending.pop());if(visited.has(path))continue;visited.add(path);files.add(path);
    if(!/\.[cm]?[jt]sx?$/i.test(path))continue;
    const source=ts.createSourceFile(path,await readFile(path,"utf8"),ts.ScriptTarget.Latest,true);
    const requests=[];
    const visit=node=>{
      if(ts.isImportDeclaration(node)&&!node.importClause?.isTypeOnly&&ts.isStringLiteral(node.moduleSpecifier)){
        const bindings=node.importClause?.namedBindings;
        if(!bindings||!ts.isNamedImports(bindings)||bindings.elements.some(item=>!item.isTypeOnly))requests.push(node.moduleSpecifier.text);
      }
      if(ts.isExportDeclaration(node)&&!node.isTypeOnly&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))requests.push(node.moduleSpecifier.text);
      if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword&&ts.isStringLiteral(node.arguments[0]))requests.push(node.arguments[0].text);
      ts.forEachChild(node,visit);
    };visit(source);
    for(const request of requests){
      if(request.startsWith(".")){let target=resolve(dirname(path),request);if(!(await stat(target).catch(()=>undefined))?.isFile())target=createRequire(path).resolve(target);pending.push(target);}
      else await collectPackage(request,path);
    }
  }
  for(const subdir of ["src/proto_agent",".codex/skills"]){const root=await realpath(resolve(repo,subdir));directories.push({root,kind:"source"});for(const path of await walk(root,sourceFile))files.add(await realpath(path));}
  for(const name of ["AGENTS.md","connectors/proto_workbench.json","workflows/design_review.json","literature/seed_sources.json","scripts/prepare_harness_inputs.py","apps/proto-workbench/package.json","apps/proto-workbench/pnpm-lock.yaml","pyproject.toml","uv.lock","requirements.txt"]){const path=resolve(repo,name);if((await stat(path).catch(()=>undefined))?.isFile())files.add(await realpath(path));}
  const entries=[];for(const path of [...files].sort()){const bytes=await readFile(path);entries.push({path,relativePath:relative(repo,path).replaceAll("\\","/"),sha256:hash(bytes),sizeBytes:bytes.length});}
  return {schema:"proto-workbench.matrix-inputs.v1",observedAt:new Date().toISOString(),sourceRoot:await realpath(repo),node:{version:process.version,execPath:process.execPath,executableSha256:hash(await readFile(process.execPath)),versions:process.versions},directories,dependencies:[...dependencies.values()],entries,sha256:hash(JSON.stringify(entries))};
}

export async function verifyImplementationInventory(inventory) {
  const changed=[];
  const known = new Set(inventory.entries.map(entry=>entry.path));
  for(const directory of inventory.directories??[]){
    const found=await walk(directory.root,directory.kind==="package"?codeFile:sourceFile).catch(()=>undefined);
    if(!found){changed.push(relative(inventory.sourceRoot,directory.root));continue;}
    for(const path of found)if(!known.has(await realpath(path)))changed.push(`added:${relative(inventory.sourceRoot,path).replaceAll("\\","/")}`);
  }
  for(const entry of inventory.entries){const bytes=await readFile(entry.path).catch(()=>undefined);if(!bytes||hash(bytes)!==entry.sha256)changed.push(entry.relativePath);}
  if(hash(await readFile(inventory.node.execPath))!==inventory.node.executableSha256)changed.push("<node executable>");
  return {ok:changed.length===0,checkedAt:new Date().toISOString(),inventorySha256:inventory.sha256,changed};
}
