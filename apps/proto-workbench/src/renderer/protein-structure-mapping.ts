import type { ProteinResidueMapping, ProteinStructureChain } from "../shared/protein-structures.ts";

/** Exact deposited sequence or an explicitly positioned, residue-identical fragment. */
export function mapProteinStructure(
  proteinSequence: string,
  chain: ProteinStructureChain,
  explicitStartOneBased?: number,
): ProteinResidueMapping {
  const fail = (reason: string): ProteinResidueMapping => ({ status: "unmapped", reason, coverage: 0, positions: [] });
  if (!proteinSequence || !chain.sequence || !/^[ACDEFGHIKLMNPQRSTVWYOU]+$/.test(chain.sequence)) {
    return fail("A complete unambiguous polymer sequence is required for residue linking.");
  }
  let offset = 0;
  let status: ProteinResidueMapping["status"] = "exact";
  if (chain.sequence !== proteinSequence) {
    if (explicitStartOneBased === undefined) return fail("Sequence differs from this protein. Supply an explicit fragment start; mutations are not automatically aligned.");
    if (!Number.isSafeInteger(explicitStartOneBased) || explicitStartOneBased < 1) return fail("Fragment start must be a positive whole-number protein position.");
    offset = explicitStartOneBased - 1;
    if (proteinSequence.slice(offset, offset + chain.sequence.length) !== chain.sequence) {
      return fail("The positioned chain is not residue-identical to the selected protein segment.");
    }
    status = "explicit-partial";
  }
  const seen = new Set<number>();
  const keys = new Set<string>();
  const positions: ProteinResidueMapping["positions"] = [];
  for (const residue of chain.residues) {
    if (!Number.isSafeInteger(residue.polymerIndex) || residue.polymerIndex < 0 || residue.polymerIndex >= chain.sequence.length
      || chain.sequence[residue.polymerIndex] !== residue.oneLetter || seen.has(residue.polymerIndex) || keys.has(residue.key)) {
      return fail("Residue identities or deposited numbering are ambiguous; linking is withheld.");
    }
    seen.add(residue.polymerIndex); keys.add(residue.key);
    positions.push({ proteinIndex: offset + residue.polymerIndex, residue });
  }
  return { status, reason: status === "exact" ? "Deposited polymer sequence exactly matches this protein." : "Explicit fragment position verified residue by residue.",
    coverage: positions.length / proteinSequence.length, positions };
}

export function chooseUnambiguousChain(proteinSequence: string, chains: ProteinStructureChain[]): string {
  const exact = chains.filter((chain) => mapProteinStructure(proteinSequence, chain).status === "exact");
  return exact.length === 1 ? exact[0].id : "";
}
