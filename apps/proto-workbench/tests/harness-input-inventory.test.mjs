import test from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,writeFile,rm} from "node:fs/promises";
import {resolve,join,relative,isAbsolute} from "node:path";
import {captureImplementationInventory,verifyImplementationInventory} from "../scripts/harness-input-inventory.mjs";

test("frozen inventory detects imported source edits, dependency-independent Python additions, and removal",async()=>{
  const owned=resolve("build/test-input-inventory");await mkdir(owned,{recursive:true});
  const root=await mkdtemp(join(owned,"case-"));
  try {
    await mkdir(join(root,"src/proto_agent"),{recursive:true});
    await mkdir(join(root,".codex/skills"),{recursive:true});
    await writeFile(join(root,"entry.mjs"),'import "./helper.mjs";\n');
    await writeFile(join(root,"helper.mjs"),'export const value=1;\n');
    await writeFile(join(root,"src/proto_agent/main.py"),'VALUE = 1\n');
    const inventory=await captureImplementationInventory(root,join(root,"entry.mjs"));
    assert.equal((await verifyImplementationInventory(inventory)).ok,true);
    await writeFile(join(root,"helper.mjs"),'export const value=2;\n');
    assert.ok((await verifyImplementationInventory(inventory)).changed.includes("helper.mjs"));
    await writeFile(join(root,"helper.mjs"),'export const value=1;\n');
    await writeFile(join(root,"src/proto_agent/new.py"),'VALUE = 2\n');
    assert.ok((await verifyImplementationInventory(inventory)).changed.includes("added:src/proto_agent/new.py"));
    await rm(join(root,"src/proto_agent/main.py"));
    assert.ok((await verifyImplementationInventory(inventory)).changed.includes("src/proto_agent/main.py"));
  } finally {
    const child=relative(owned,root);assert.ok(child&&!child.startsWith("..")&&!isAbsolute(child));
    await rm(root,{recursive:true,force:true});
  }
});
