"""Prepare provenance-checked scientific INPUT fixtures for autonomous acceptance.

Never completes a model deliverable. IDs come only from the active governed
catalogue. This helper does not alter catalogue activation or source sequences.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import sqlite3
import ssl
import certifi
from pathlib import Path

from proto_agent.mcp_server import McpServer
from proto_agent.security import WorkspacePaths


def prepare(workspace: Path, kind: str, materials_root: Path) -> dict:
    os.environ["PROTO_AGENT_MATERIALS_ROOT"] = str(materials_root.resolve())
    server = McpServer(workspace)
    paths = WorkspacePaths.create(workspace)
    if kind == "identity":
        store, snapshot_id = server._active_materials_store({})
        manifest = store._snapshot_dir(snapshot_id) / "manifest.json"
        return {"input_only": True, "snapshot_id": snapshot_id, "manifest_sha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
                "python": {"version": sys.version, "executable": sys.executable, "executable_sha256": hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest(), "sqlite": sqlite3.sqlite_version, "openssl": ssl.OPENSSL_VERSION,
                           "certifi_version": certifi.__version__, "certificate_bundle": certifi.where(), "certificate_bundle_sha256": hashlib.sha256(Path(certifi.where()).read_bytes()).hexdigest()}}
    if kind in {"dna", "dna-invalid"}:
        records = []
        for part_type in ("promoter", "rbs", "cds", "terminator"):
            found = server._tool_materials_search({"kind": "genetic_part", "query": part_type, "limit": 100})
            choices = [record for record in found["matches"] if record.get("part_type") == part_type and "ecoli_k12" in record.get("chassis", [])]
            if not choices:
                raise ValueError(f"No eligible {part_type} input supports the declared software chassis.")
            records.append(choices[0])
        selection = server._tool_materials_materialize({"resource_ids": [r["resource_id"] for r in records], "chassis": "ecoli_k12", "out": "build/fixtures/parts.json"})
        source = "# Governed acceptance INPUT fixture; software checks only.\ndesign acceptance_input chassis ecoli_k12\nconstruct unit:\n  topology linear\n"
        source += "".join(f"  {r['part_type']} {r['resource_id']} instance={label}\n" for r, label in zip(records, ("p1", "r1", "c1", "t1")))
        source_path = paths.build_file("build/fixtures/base.proto", extensions={".proto"})
        source_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.write_text(source, encoding="utf-8", newline="")
        checked = server._tool_check({"path": "build/fixtures/base.proto", "parts_path": selection["parts_path"]})
        if not checked.get("ok"):
            raise ValueError(f"Governed input fixture did not validate: {json.dumps(checked)}")
        compiled = server._tool_compile({"path": "build/fixtures/base.proto", "parts_path": selection["parts_path"], "out": "build/fixtures/base.ir.json"})
        if not compiled.get("ok"):
            raise ValueError(f"Governed input fixture did not compile: {json.dumps(compiled)}")
        if kind == "dna-invalid":
            # One parser-level fault, keeping all source identities unchanged.
            source_path.write_text(source.replace("topology linear", "topology invalid_fixture_value"), encoding="utf-8", newline="")
            invalid = server._tool_check({"path": "build/fixtures/base.proto", "parts_path": selection["parts_path"]})
            if invalid.get("ok"):
                raise ValueError("Controlled invalid input unexpectedly passed validation.")
        return {"kind": kind, "input_only": True, "source_path": "build/fixtures/base.proto", "source_sha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
                "parts_path": selection["parts_path"], "snapshot_id": selection["snapshot_id"], "resource_ids": [r["resource_id"] for r in records], "chassis": "ecoli_k12",
                "initial_validation_ok": kind == "dna", "ir_path": "build/fixtures/base.ir.json"}
    found = server._tool_materials_search({"kind": "protein_sequence", "limit": 1})
    if not found["matches"]:
        raise ValueError("No eligible protein input is available in the active catalogue.")
    resource_ids = [found["matches"][0]["resource_id"]]
    selection = server._tool_materials_materialize_proteins({"resource_ids": resource_ids, "out": "build/fixtures/proteins.json"})
    compiled = server._tool_protein_compile({"path": selection["proteins_path"], "out": "build/fixtures/protein.ir.json"})
    if not compiled.get("ok"):
        raise ValueError(f"Governed protein input did not compile: {json.dumps(compiled)}")
    return {"kind": "protein", "input_only": True, "resource_ids": resource_ids, "snapshot_id": selection["snapshot_id"], "proteins_path": selection["proteins_path"], "ir_path": "build/fixtures/protein.ir.json"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--materials-root", type=Path, required=True)
    parser.add_argument("--kind", choices=("dna", "dna-invalid", "protein", "identity"), required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.workspace.resolve(), args.kind, args.materials_root.resolve()), ensure_ascii=True))


if __name__ == "__main__":
    main()
