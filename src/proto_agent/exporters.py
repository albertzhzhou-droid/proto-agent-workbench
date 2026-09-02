from __future__ import annotations

from pathlib import Path
from typing import Any

from .sbol import export_sbol3_turtle
from .security import MAX_JSON_FILE_BYTES, read_json_bounded


def load_ir(path: str | Path) -> dict[str, Any]:
    payload = read_json_bounded(path, MAX_JSON_FILE_BYTES)
    if not isinstance(payload, dict):
        raise ValueError("Compiled IR must be a JSON object.")
    return payload


def export_ir(ir: dict[str, Any], output_format: str) -> str:
    if output_format == "sbol":
        if ir.get("domain") == "protein":
            raise ValueError("SBOL export is limited to nucleotide constructs; use FASTA for protein IR.")
        return export_sbol3_turtle(ir)
    if output_format == "genbank":
        if ir.get("domain") == "protein":
            raise ValueError("GenBank export is limited to nucleotide constructs; use FASTA for protein IR.")
        return _export_toy_genbank(ir)
    if output_format == "fasta":
        return _export_fasta(ir)
    raise ValueError(f"Unsupported export format: {output_format}")


def _construct_sequence(construct: dict[str, Any]) -> str:
    return "".join(part.get("sequence", "") for part in construct.get("parts", []))


def _export_toy_genbank(ir: dict[str, Any]) -> str:
    records = []
    for construct in ir.get("constructs", []):
        sequence = _construct_sequence(construct)
        records.extend(
            [
                f"LOCUS       {construct['name'][:16]:<16} {len(sequence):>5} bp    DNA     SYN",
                f"DEFINITION  Toy GenBank-like export for {ir['design_id']} / {construct['name']}.",
                "FEATURES             Location/Qualifiers",
            ]
        )
        position = 1
        for part in construct.get("parts", []):
            end = position + len(part.get("sequence", "")) - 1
            records.append(f"     misc_feature    {position}..{end}")
            records.append(f"                     /label=\"{part['type']}:{part['id']}\"")
            position = end + 1
        records.append("ORIGIN")
        records.append(f"        1 {sequence.lower()}")
        records.append("//")
    return "\n".join(records) + "\n"


def _export_fasta(ir: dict[str, Any]) -> str:
    if ir.get("domain") == "protein":
        lines = []
        for protein in ir.get("proteins", []):
            identifier = _fasta_header_token(protein.get("id", "protein"), "protein")
            name = _fasta_header_token(protein.get("name", ""), "record")
            design_id = _fasta_header_token(ir.get("design_id", "protein"), "protein")
            lines.append(f">{design_id}|{identifier}|{name}|protein")
            lines.append(str(protein.get("sequence", "")))
        if not lines:
            raise ValueError("Protein IR contains no exportable sequences.")
        return "\n".join(lines) + "\n"
    lines = []
    for construct in ir.get("constructs", []):
        sequence = _construct_sequence(construct)
        lines.append(f">{ir['design_id']}|{construct['name']}|toy_fixture")
        lines.append(sequence)
    return "\n".join(lines) + "\n"


def _fasta_header_token(value: Any, fallback: str) -> str:
    """Keep untrusted labels on one bounded FASTA header line."""

    token = " ".join(str(value or "").replace("\x00", " ").split())[:256]
    return token or fallback
