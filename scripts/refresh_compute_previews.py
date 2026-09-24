"""Refresh only changed, CPU-only recorded examples; retain all other results.

Run with the project's Python. --metadata-only updates current catalog schemas
and metadata while preserving every recorded example/result association.
All request, result and provenance artifacts stay under build/.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from proto_agent.compute import compute_catalog, run_compute  # noqa: E402
from proto_agent.compute_stats import TOOLS as STATISTICS  # noqa: E402


TARGET = REPO / "apps/proto-workbench/src/renderer/compute-preview.json"
REFRESH_TOOLS = [*STATISTICS, "compare_protein_structures", "analyze_protein_phylogeny", "analyze_protein_comparison", "import_colabfold_result", "analyze_rnaseq_study"]
NOTICE = "Synthetic software examples only; recording a result does not validate biological function, study design or real-sample accuracy."


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def object_digest(value):
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode())


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def synthetic_coordinates(points):
    # Same explicit development fixture as tests/test_compute_batch3.py and the
    # historical build/biomni-research/record_batch4_preview.py, not a protein record.
    header = "REMARK 999 SYNTHETIC SOFTWARE TEST FIXTURE; NOT AN EXPERIMENTAL STRUCTURE\n"
    return (header + "\n".join(
        f"ATOM  {index + 1:5d}  CA  ALA A{index + 1:4d}    {x:8.3f}{y:8.3f}{z:8.3f}  1.00  0.00           C"
        for index, (x, y, z) in enumerate(points)) + "\n").encode("ascii")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metadata-only", action="store_true")
    parser.add_argument("--tool", action="append", choices=REFRESH_TOOLS, help="Refresh only this bounded method; repeat for multiple methods.")
    args = parser.parse_args()
    if args.metadata_only and args.tool:
        parser.error("--metadata-only cannot be combined with --tool")
    original_bytes = TARGET.read_bytes()
    original = json.loads(original_bytes)
    recorded = {entry["id"]: entry for entry in original["catalog"]["tools"]}
    created_at = datetime.now(timezone.utc).isoformat()
    root = REPO / "build/research-upgrade-20260922/compute-preview-refresh" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid4().hex[:8])
    root.mkdir(parents=True, exist_ok=False)
    (root / "compute-preview.before.json").write_bytes(original_bytes)
    source_files = sorted((REPO / "src/proto_agent").glob("compute*.py")) + [
        REPO / "src/proto_agent/security.py", REPO / "src/proto_agent/provenance.py", REPO / "src/proto_agent/rnaseq_data.py", Path(__file__).resolve()]
    sources = {path.relative_to(REPO).as_posix(): digest(path.read_bytes()) for path in source_files}
    catalog = compute_catalog()
    catalog["tools"] = [compute_catalog(entry["id"])["tools"][0] for entry in catalog["tools"]]
    catalog["execution"] = "recorded"
    # Retained results must retain the exact request that produced them. Some
    # older binary-file examples intentionally override the catalog default.
    refresh = [] if args.metadata_only else list(dict.fromkeys(args.tool or REFRESH_TOOLS))
    for entry in catalog["tools"]:
        if entry["id"] in recorded and entry["id"] not in refresh:
            entry["example"] = recorded[entry["id"]]["example"]
    results = dict(original["results"])
    runs = []
    if refresh:
        workspace = root / "workspace"
        inputs = workspace / "build/compute-inputs"
        inputs.mkdir(parents=True)
        points = [(index * 3.8, 0, 0) for index in range(20)]
        displaced = [(x, y, z + (4.0 if 8 <= index < 12 else 0.0)) for index, (x, y, z) in enumerate(points)]
        (inputs / "apo.pdb").write_bytes(synthetic_coordinates(points))
        (inputs / "bound.pdb").write_bytes(synthetic_coordinates(displaced))
        # An explicit confidence-format fixture, not an inferred biological model.
        scores = [75, 60, 40]
        prediction = "REMARK 999 SYNTHETIC SOFTWARE FORMAT FIXTURE; NOT A PREDICTION\n" + "\n".join(
            f"ATOM  {i+1:5d}  CA  ALA A{i+1:4d}    {i*3.8:8.3f}{0:8.3f}{0:8.3f}  1.00{score:6.2f}           C"
            for i, score in enumerate(scores)) + "\nEND\n"
        (inputs / "prediction.pdb").write_text(prediction, encoding="ascii")
        write_json(inputs / "scores.json", {"plddt": scores, "pae": [[0,2,9],[4,0,7],[3,6,0]], "max_pae": 9})
        (inputs / "rnaseq-counts.csv").write_text("gene_id,control1,control2,treated1,treated2\nsynthetic-feature-a,10,12,19,21\nsynthetic-feature-b,30,22,7,8\nsynthetic-zero-feature,0,0,0,0\n", encoding="utf-8")
        (inputs / "rnaseq-samples.csv").write_text("sample,condition\ncontrol1,control\ncontrol2,control\ntreated1,treated\ntreated2,treated\n", encoding="utf-8")
        write_json(inputs / "SYNTHETIC_FIXTURES.json", {"notice": NOTICE,
            "basis": "tests/test_compute_batch3.py:test_pdb_comparison_rmsd_and_region; historical build/biomni-research/record_batch4_preview.py",
            "files": {name: digest((inputs / name).read_bytes()) for name in ("apo.pdb", "bound.pdb", "prediction.pdb", "scores.json", "rnaseq-counts.csv", "rnaseq-samples.csv")}})
        details = {entry["id"]: entry for entry in catalog["tools"]}
        if "analyze_rnaseq_study" in refresh:
            details["analyze_rnaseq_study"]["example"] = {**details["analyze_rnaseq_study"]["example"],
                "counts_path": "build/compute-inputs/rnaseq-counts.csv", "samples_path": "build/compute-inputs/rnaseq-samples.csv", "analysis_mode": "validate"}
        for name in refresh:
            request_path = workspace / "build/requests" / f"{name}.json"
            write_json(request_path, {"tool": name, "arguments": details[name]["example"]})
            response = run_compute(request_path.relative_to(workspace).as_posix(), workspace_root=workspace)
            result_path = workspace / next(path for path in response["artifacts"] if path.endswith("/result.json"))
            result = json.loads(result_path.read_text(encoding="utf-8"))
            results[name] = result
            runs.append({"tool": name, "request_path": request_path.relative_to(REPO).as_posix(),
                         "manifest_path": (workspace / response["manifest_path"]).relative_to(REPO).as_posix(),
                         "result_path": result_path.relative_to(REPO).as_posix(),
                         "result_sha256": digest(result_path.read_bytes()), "canonical_result_sha256": object_digest(result)})
    ids = {entry["id"] for entry in catalog["tools"]}
    if ids != set(results):
        raise ValueError(f"Recorded result/catalog mismatch: missing={sorted(ids-set(results))}, obsolete={sorted(set(results)-ids)}")
    unchanged = sorted(set(original["results"]) - set(refresh))
    for name in unchanged:
        if results[name] != original["results"][name]:
            raise ValueError(f"Historical result changed unexpectedly: {name}")
    for path, expected in sources.items():
        if digest((REPO / path).read_bytes()) != expected:
            raise ValueError(f"Source changed during recording: {path}; evidence remains in {root} and the preview was not updated.")
    if TARGET.read_bytes() != original_bytes:
        raise ValueError("Preview was edited concurrently; refusing to replace it.")
    manifest_path = root / "generation.json"
    result = {"catalog": catalog, "results": results,
              "recording": {"schema_version": "proto-agent.compute-preview-recording.v1", "created_at": created_at,
                            "notice": NOTICE, "generation_manifest_path": manifest_path.relative_to(REPO).as_posix(),
                            "refreshed_tools": refresh, "mode": "metadata-only" if args.metadata_only else "bounded-cpu-refresh",
                            "previous_generation": original.get("recording")}}
    encoded = (json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
    manifest = {"schema_version": "proto-agent.compute-preview-generation.v1", "created_at": created_at, "notice": NOTICE,
                "mode": result["recording"]["mode"], "source_sha256": sources,
                "before_preview_sha256": digest(original_bytes), "after_preview_sha256": digest(encoded),
                "catalog_count": len(ids), "refreshed_tools": refresh, "runs": runs,
                "retained_result_sha256": {name: object_digest(results[name]) for name in unchanged},
                "previous_recording": original.get("recording"), "target": TARGET.relative_to(REPO).as_posix()}
    write_json(manifest_path, manifest)
    (root / "compute-preview.after.json").write_bytes(encoded)
    TARGET.write_bytes(encoded)
    print(json.dumps({"ok": True, "catalog_count": len(ids), "refreshed_count": len(refresh),
                      "retained_result_count": len(unchanged), "generation_manifest": manifest_path.relative_to(REPO).as_posix()}))


if __name__ == "__main__":
    main()
