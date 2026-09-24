"""A source-preserving comparison of supplied, already aligned proteins."""
from __future__ import annotations

import hashlib

from .compute_bio import analyze_protein_conservation
from .compute_structures import analyze_protein_phylogeny


def analyze_protein_comparison(arguments):
    supplied = arguments.get("aligned_sequences")
    if not isinstance(supplied, list) or not 2 <= len(supplied) <= 50:
        raise ValueError("Supply 2 to 50 named, prealigned proteins.")
    rows, names = [], set()
    for entry in supplied:
        if not isinstance(entry, dict) or set(entry) != {"name", "sequence"}:
            raise ValueError("Each aligned protein needs exactly name and sequence.")
        name, sequence = entry["name"], entry["sequence"]
        if not isinstance(name, str) or not 1 <= len(name) <= 100 or name != name.strip() or any(ord(c) < 32 or ord(c) == 127 for c in name):
            raise ValueError("Protein names must be 1 to 100 printable characters without outer whitespace.")
        if name in names:
            raise ValueError("Protein names must be unique; duplicate identities cannot be mapped.")
        names.add(name)
        if not isinstance(sequence, str) or not sequence.isascii() or not 10 <= len(sequence) <= 2000:
            raise ValueError("Each aligned protein must contain 10 to 2000 ASCII residues/gaps.")
        sequence = sequence.upper()
        if set(sequence) - set("ACDEFGHIKLMNPQRSTVWY-") or not sequence.replace("-", ""):
            raise ValueError("Use the 20 standard amino acids and '-' gaps; an all-gap sequence is invalid.")
        ungapped = sequence.replace("-", "")
        offset, positions = 0, []
        for residue in sequence:
            positions.append(offset if residue != "-" else None)
            offset += residue != "-"
        rows.append({"name": name, "sequence": sequence, "ungapped_sequence": ungapped,
                     "sequence_sha256": hashlib.sha256(ungapped.encode("ascii")).hexdigest(),
                     "alignment_to_sequence": positions})
    if len({len(row["sequence"]) for row in rows}) != 1:
        raise ValueError("Sequences must already be aligned to the same length; no padding is performed.")
    if sum(len(row["sequence"]) for row in rows) > 10000:
        raise ValueError("The complete alignment must not exceed 10000 characters.")
    conservation = analyze_protein_conservation({"aligned_sequences": [row["sequence"] for row in rows]})
    phylogeny = analyze_protein_phylogeny({"aligned_sequences": [
        {"name": row["name"], "sequence": row["sequence"]} for row in rows]}) if len(rows) >= 3 else None
    return {"study_schema": "proto-agent.protein-comparison.v1", "sequence_count": len(rows),
            "alignment_length": len(rows[0]["sequence"]), "alignment": rows,
            "conservation": conservation, "phylogeny": phylogeny,
            "coordinate_system": {"alignment_columns": "1-based", "sequence_positions": "0-based; null for gaps"},
            "method": "Supplied alignment with source-preserving coordinates, gap-aware conservation and identity-distance neighbor joining",
            "limitations": ["This operation consumes a supplied alignment; it does not infer or validate evolutionary homology.",
                            "Tree branch lengths use identity distance; there is no substitution-model selection or bootstrap support.",
                            "Coordinate linkage to a design requires an exact name and ungapped-sequence match. Gaps have no residue position.",
                            "No material eligibility or biological function is inferred from this analysis."] +
                           (["At least three sequences are required for the tree; the two-sequence comparison has no tree."] if phylogeny is None else [])}


TOOLS = {"analyze_protein_comparison": {
    "title": "Protein comparative study",
    "description": "Compare a named protein alignment with conservation, a tree and explicit sequence coordinates for linked structure inspection.",
    "implementation": "proto-native", "upstream_functions": [], "dependency": ["numpy"],
    "method_references": ["https://doi.org/10.1093/oxfordjournals.molbev.a040454"],
    "input_schema": {"type": "object", "additionalProperties": False, "required": ["aligned_sequences"], "properties": {
        "aligned_sequences": {"type": "array", "minItems": 2, "maxItems": 50, "items": {
            "type": "object", "additionalProperties": False, "required": ["name", "sequence"], "properties": {
                "name": {"type": "string", "minLength": 1, "maxLength": 100},
                "sequence": {"type": "string", "minLength": 10, "maxLength": 2000}}}}}},
    "example": {"aligned_sequences": [{"name": "example-a", "sequence": "ACDEFGHIKLMN"},
                                      {"name": "example-b", "sequence": "AC-EFGHIKLMN"},
                                      {"name": "example-c", "sequence": "ACDEYGHIKLMN"}]}
}}
HANDLERS = {"analyze_protein_comparison": analyze_protein_comparison}
