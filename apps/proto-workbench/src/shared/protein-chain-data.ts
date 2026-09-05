import type { Model } from "molstar/lib/mol-model/structure.js";
import type { ProteinStructureChain, ProteinStructureResidue } from "./protein-structures.ts";
import { PROTEIN_STRUCTURE_LIMITS as LIMITS } from "./protein-structures.ts";
const THREE_TO_ONE: Readonly<Record<string, string>> = Object.freeze({
  ALA: "A", ARG: "R", ASN: "N", ASP: "D", CYS: "C", GLU: "E", GLN: "Q", GLY: "G", HIS: "H",
  ILE: "I", LEU: "L", LYS: "K", MET: "M", PHE: "F", PRO: "P", SER: "S", THR: "T", TRP: "W", TYR: "Y", VAL: "V", SEC: "U", PYL: "O",
});

/** Retain deposited identifiers; never use auth_seq_id as a protein offset. */
export function extractProteinChains(model: Model, predicted: boolean, modelIndex: number): ProteinStructureChain[] {
  const hierarchy = model.atomicHierarchy;
  if (hierarchy.atoms._rowCount > LIMITS.maxAtoms || hierarchy.residues._rowCount > LIMITS.maxResidues
    || hierarchy.chains._rowCount > LIMITS.maxChains) throw new Error("Structure exceeds the supported atom, residue, or chain budget.");
  for (let atom = 0; atom < hierarchy.atoms._rowCount; atom += 1) {
    const point = [model.atomicConformation.x[atom], model.atomicConformation.y[atom], model.atomicConformation.z[atom]];
    if (point.some((value) => !Number.isFinite(value) || Math.abs(value) > 1_000_000)) throw new Error("Invalid or unbounded atomic coordinates.");
  }
  const output: ProteinStructureChain[] = [];
  for (let chainIndex = 0; chainIndex < hierarchy.chains._rowCount; chainIndex += 1) {
    const entityId = hierarchy.chains.label_entity_id.value(chainIndex);
    const sequenceRecord = model.sequence.sequences.find((entry) => entry.entityId === entityId);
    if (!sequenceRecord || sequenceRecord.sequence.kind !== "protein") continue;
    const polymer = sequenceRecord.sequence;
    if (polymer.length > LIMITS.maxResidues) throw new Error("Polymer sequence exceeds the structural mapping budget.");
    const labelAsymId = hierarchy.chains.label_asym_id.value(chainIndex);
    const authAsymId = hierarchy.chains.auth_asym_id.value(chainIndex);
    const id = `${modelIndex}:${labelAsymId}`;
    const firstAtom = hierarchy.chainAtomSegments.offsets[chainIndex];
    const lastAtom = hierarchy.chainAtomSegments.offsets[chainIndex + 1] - 1;
    if (lastAtom < firstAtom) continue;
    const firstResidue = hierarchy.residueAtomSegments.index[firstAtom];
    const lastResidue = hierarchy.residueAtomSegments.index[lastAtom];
    const residues: ProteinStructureResidue[] = [];
    for (let index: number = firstResidue; index <= lastResidue; index += 1) {
      const atomStart = hierarchy.residueAtomSegments.offsets[index];
      const atomEnd = hierarchy.residueAtomSegments.offsets[index + 1];
      const labelSeqId = hierarchy.residues.label_seq_id.value(index);
      const authSeqId = hierarchy.residues.auth_seq_id.value(index);
      const insertionCode = hierarchy.residues.pdbx_PDB_ins_code.value(index);
      const component = hierarchy.atoms.label_comp_id.value(atomStart);
      const oneLetter = THREE_TO_ONE[component] ?? "X";
      let alphaCarbon: number = atomStart;
      for (let atom: number = atomStart; atom < atomEnd; atom += 1) {
        if (hierarchy.atoms.label_atom_id.value(atom) === "CA") { alphaCarbon = atom; break; }
      }
      const rawConfidence = model.atomicConformation.B_iso_or_equiv.value(alphaCarbon);
      residues.push({ key: `${id}:${labelSeqId}:${authSeqId}:${insertionCode}`, labelSeqId, authSeqId, insertionCode, oneLetter,
        polymerIndex: polymer.index(labelSeqId), confidence: predicted && Number.isFinite(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 100 ? rawConfidence : null });
    }
    const sequence = Array.from({ length: polymer.length }, (_, index) => polymer.code.value(index)).join("");
    output.push({ id, modelIndex, labelAsymId, authAsymId, sequence, residues });
  }
  return output;
}
