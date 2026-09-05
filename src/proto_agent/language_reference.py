"""Bounded, executable-tool-facing language documentation; no biological IDs."""
from __future__ import annotations

from typing import Any


def language_reference(topic: str = "all") -> dict[str, Any]:
    if topic not in {"all", "dna", "protein", "edits"}:
        raise ValueError("topic must be all, dna, protein, or edits")
    sections = {
        "dna": {
            "format": "Line-oriented .proto source, not JSON, YAML, Python, or natural language.",
            "template": "# Replace angle-bracket placeholders using tool-returned identifiers.\ndesign <local_design_name> chassis <materialized_chassis>\nconstruct <local_construct_name>:\n  topology linear\n  promoter <materialized_promoter_id> instance=p1\n  rbs <materialized_rbs_id> instance=r1\n  cds <materialized_cds_id> instance=c1\n  terminator <materialized_terminator_id> instance=t1\n",
            "identity": "Local design, construct, and instance names are workspace labels. Biological part IDs must be exact IDs returned by proto_search_parts against the materialized parts_path. Catalog resource_id is not automatically the materialized part ID.",
            "grammar": ["One design <id> chassis <id> header is required.", "A construct starts with construct <name>:; part lines contain a part type followed by an exact library ID.", "Part types are promoter, rbs, cds, terminator. The compatibility validator checks required occurrence types and ordering.", "topology is linear or circular. It belongs inside a construct.", "Part placement options are instance=<local_id> and orientation=forward|reverse. Source records and source sequence hashes remain unchanged.", "Comments begin with #. Annotation JSON is a single line beginning with annotation inside a construct.", "Optional constraints use constraint <type> key=value ...; obtain supported names and errors from structured validation instead of inventing a constraint."],
            "workflow": ["proto_materials_search", "proto_materials_materialize", "proto_search_parts with the returned parts_path", "workspace_propose_patch with complete source", "proto_check with the bound parts_path", "proto_workflow_run with the same parts_path", "proto_provenance_verify", "proto_review_packet"],
            "versions": "Legacy forward-only designs compile to proto-agent.ir.v1. Occurrence placement, orientation or annotations compile to proto-agent.ir.v2 with explicit source identities and coordinate transforms.",
        },
        "protein": {
            "format": "Proteins use a materialized protein-selection JSON and a separate protein-domain IR; a protein selection is not a DNA .proto design.",
            "workflow": ["proto_materials_search restricted to protein_sequence", "proto_materials_materialize_proteins with exact eligible resource_ids", "proto_protein_validate using proteins_path", "proto_protein_compile using proteins_path", "proto_export using the compiled ir_path and format=fasta"],
            "identity": "Use the selection produced by materialization. Do not hand-author catalog attestations, sequence hashes, resource IDs, review status, or source sequence bytes.",
            "interpretation": "A successful compile is a software/provenance check. It does not establish protein function, expression, activity, physical structure, safety approval, or experimental readiness.",
        },
        "edits": {
            "tool": "proto_design_edit prepares a checked candidate and unified diff without writing files. Bind both expected_source_sha256 and expected_parts_sha256 from current reads.",
            "commands": [
                {"type": "reorder_occurrences", "construct": "<local_construct_name>", "instance_ids": ["<every_existing_instance_once>"]},
                {"type": "set_orientation", "construct": "<local_construct_name>", "instance_id": "<existing_instance>", "orientation": "reverse"},
                {"type": "upsert_annotation", "construct": "<local_construct_name>", "annotation": {"id": "<local_annotation_id>", "name": "Review note", "type": "misc_feature", "origin": "user", "anchors": [{"instance_id": "<existing_instance>", "start": 0, "end": 1, "direction": 0}]}},
                {"type": "delete_annotation", "construct": "<local_construct_name>", "annotation_id": "<existing_annotation_id>"},
            ],
            "coordinates": "Anchor start is zero-based inclusive; end is exclusive. Bounds refer to the source occurrence sequence. Direction is -1, 0, or 1; reversal transforms displayed coordinates without changing source identity.",
            "application": "Read an existing target before replacing it. A source/library mismatch requires refreshing and explicitly rebasing; never overwrite a concurrent change using an old model read.",
        },
    }
    return {"ok": True, "schema": "proto-agent.language-reference.v1", "topic": topic,
            "sections": sections if topic == "all" else {topic: sections[topic]},
            "placeholders_are_not_resource_ids": True,
            "boundary": "Software-only source syntax and validation reference. No biological or wet-lab execution instructions."}
