import {createHash} from "node:crypto";
import {closeSync,fstatSync,lstatSync,openSync,readSync,realpathSync} from "node:fs";
import {isAbsolute,join,relative,resolve,sep} from "node:path";

const fail=(message:string):never=>{throw Object.assign(new Error(message),{code:"RECONCILIATION_EVIDENCE_INVALID"});};
const MAX_BYTES=64*1024*1024;

/** A verdict binds a contained, regular artifact's observed bytes, not free text.
 * The binding is evidence integrity only; the reviewer supplies the verdict. */
export function validateReconciliationEvidence(workspace:string,reference:string):string {
  if(typeof reference!=="string"||reference.length>4096)fail("Use a workspace-relative evidence file.");
  const match=/^(.+?)(?:#sha256=([a-f0-9]{64}))?$/.exec(reference.trim());
  if(!match)fail("Use a workspace-relative path, optionally followed by #sha256=<digest>.");
  const path=match![1].replaceAll("\\","/");
  if(isAbsolute(path)||/[:\x00-\x1f#]/.test(path)||path.split("/").some(part=>!part||part==="."||part===".."))fail("Evidence must be a contained workspace-relative file.");
  const root=realpathSync(workspace),target=resolve(root,path),rel=relative(root,target);
  if(rel.startsWith(`..${sep}`)||rel===".."||isAbsolute(rel))fail("Evidence is outside the workspace.");
  let cursor=root;
  try {
    for(const part of rel.split(sep)){
      cursor=join(cursor,part);
      if(lstatSync(cursor).isSymbolicLink()||realpathSync(cursor)!==cursor)fail("Evidence cannot traverse a symbolic link or junction.");
    }
    const before=lstatSync(target);
    if(!before.isFile()||before.nlink!==1||before.size>MAX_BYTES)fail("Evidence must be a regular file no larger than 64 MiB.");
    const fd=openSync(target,"r");
    try {
      const opened=fstatSync(fd);
      if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)fail("Evidence changed while opening it.");
      const hash=createHash("sha256"),buffer=Buffer.alloc(64*1024);let position=0;
      while(position<opened.size){const count=readSync(fd,buffer,0,Math.min(buffer.length,opened.size-position),position);if(!count)fail("Evidence changed while reading it.");hash.update(buffer.subarray(0,count));position+=count;}
      const after=fstatSync(fd),current=lstatSync(target);
      if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs||after.nlink!==1||current.nlink!==1||current.dev!==opened.dev||current.ino!==opened.ino)fail("Evidence changed while hashing it.");
      cursor=root;
      for(const part of rel.split(sep)){cursor=join(cursor,part);if(lstatSync(cursor).isSymbolicLink()||realpathSync(cursor)!==cursor)fail("Evidence ancestry changed while hashing it.");}
      const digest=hash.digest("hex");
      if(match![2]&&match![2]!==digest)fail("Evidence SHA-256 does not match the supplied digest.");
      return `${rel.split(sep).join("/")}#sha256=${digest}`;
    }finally{closeSync(fd);}
  }catch(error){if((error as {code?:string}).code==="RECONCILIATION_EVIDENCE_INVALID")throw error;return fail("The evidence file does not exist or cannot be read safely.");}
}
