import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, link, unlink } from "node:fs/promises";
import { join, relative } from "node:path";

/** Publish a portable inspection receipt before settling a workspace journal.
 * A hard-link publish is exclusive; no previous proof is overwritten. */
export async function writeHarnessReconciliationProof(workspace:string,proof:Record<string,unknown>):Promise<string> {
  const root=await realpath(workspace);
  let directory=root;
  for(const segment of ["build","harness-reconciliation"]){
    directory=join(directory,segment);
    await mkdir(directory).catch(error=>{if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;});
    const info=await lstat(directory);
    if(!info.isDirectory()||info.isSymbolicLink()||await realpath(directory)!==directory)throw new Error("HARNESS_RECONCILIATION_PATH_UNSAFE");
  }
  const payload=JSON.stringify({schema_version:"proto-workbench.harness-reconciliation.v1",...proof})+"\n";
  if(Buffer.byteLength(payload)>2*1024*1024)throw new Error("HARNESS_RECONCILIATION_PROOF_LIMIT");
  const name=randomUUID(),temporary=join(directory,`${name}.tmp`),target=join(directory,`${name}.json`);
  const descriptor=await open(temporary,"wx");
  try{await descriptor.writeFile(payload);await descriptor.sync();}finally{await descriptor.close();}
  try{await link(temporary,target);}finally{await unlink(temporary);}
  return `${relative(root,target).replaceAll("\\","/")}#sha256=${createHash("sha256").update(payload).digest("hex")}`;
}
