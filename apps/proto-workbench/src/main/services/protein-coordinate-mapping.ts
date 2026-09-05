import { CIF } from "molstar/lib/mol-io/reader/cif.js";
import { parsePDB } from "molstar/lib/mol-io/reader/pdb/parser.js";
import { trajectoryFromMmCIF } from "molstar/lib/mol-model-formats/structure/mmcif.js";
import { trajectoryFromPDB } from "molstar/lib/mol-model-formats/structure/pdb.js";
import { Task } from "molstar/lib/mol-task/index.js";
import { extractProteinChains } from "../../shared/protein-chain-data.ts";
import type { ProteinStructureData } from "../../shared/protein-structures.ts";

/** Coordinate-only parser: no WebGL, plugin, network, or structure acquisition. */
export async function readProteinCoordinateChains(data: ProteinStructureData, modelIndex: number) {
  const trajectory = data.attachment.format === "pdb" ? await (async () => {
    const parsed = await parsePDB(data.text, data.attachment.source.accession).run();
    if (parsed.isError) throw new Error(parsed.message);
    return trajectoryFromPDB(parsed.result).run();
  })() : await (async () => {
    const parsed = await CIF.parse(data.text).run();
    if (parsed.isError || !parsed.result.blocks.length) throw new Error(parsed.isError ? parsed.message : "No mmCIF block was found.");
    return trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  })();
  if (!Number.isSafeInteger(modelIndex) || modelIndex < 0 || modelIndex >= trajectory.frameCount || trajectory.frameCount > 64) throw new Error("Unsupported structure model index.");
  const model = await Task.resolveInContext(trajectory.getFrameAtIndex(modelIndex));
  return extractProteinChains(model, data.attachment.source.provider === "alphafold", modelIndex);
}
