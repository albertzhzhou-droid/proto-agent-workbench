import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TOOL_CONTRACTS } from "../src/shared/tool-contracts.ts";

/** Python consumes this generated snapshot; edit only shared/tool-contracts.ts. */
const target=fileURLToPath(new URL("../../../src/proto_agent/data/tool-contracts.json",import.meta.url));
const snapshot={schema_version:"proto-agent.tool-contract.v1",tools:[...TOOL_CONTRACTS.values()]
  .filter(contract=>contract.surface==="mcp")
  .map(contract=>({name:contract.name,effect:contract.effect,network:contract.network,access:contract.access,capability_id:contract.capabilityId,
    preconditions:contract.preconditions,produces:contract.produces,idempotent:contract.idempotent,cost_class:contract.costClass,max_calls_per_run:contract.maxCallsPerRun}))};
const serialized=`${JSON.stringify(snapshot,null,2)}\n`;
if(process.argv.includes("--check")){
  const actual=await readFile(target,"utf8");
  if(actual!==serialized)throw new Error("Generated Python tool contracts are stale. Run node --experimental-strip-types scripts/export-tool-contracts.mjs.");
  process.stdout.write(`Verified ${snapshot.tools.length} generated Python tool contracts.\n`);
}else{
  await writeFile(target,serialized,"utf8");
  process.stdout.write(`Exported ${snapshot.tools.length} Python tool contracts.\n`);
}
