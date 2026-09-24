"""Assess original promotion gates using explicit hash-bound evidence and JSON assertions.

This verifies retained observations; it neither executes evidence files nor authenticates
their authors. An assertion is a JSON pointer and exact expected value, never code.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import runpy
from pathlib import Path

from chem_workbench.evaluation import (
    PROMOTION_EVIDENCE_GATES,
    assess_promotion,
    verify_complex_chemistry,
)
from chem_workbench.visualization import content_hash

INSPECTOR = runpy.run_path(str(Path(__file__).with_name("inspect_model_evaluation_v4.py")))


def pointer_value(document, pointer):
    if not isinstance(pointer, str) or (pointer and not pointer.startswith("/")):
        raise ValueError("INVALID_EVIDENCE_POINTER")
    value = document
    for segment in pointer.split("/")[1:] if pointer else []:
        key = segment.replace("~1", "/").replace("~0", "~")
        value = value[int(key)] if isinstance(value, list) else value[key]
    return value


def verify_evidence_reference(reference, root):
    if not isinstance(reference, dict) or set(reference) != {"path", "sha256", "assertions"}:
        raise ValueError("INVALID_EVIDENCE_REFERENCE")
    path = (root / reference["path"]).resolve()
    if not path.is_relative_to(root.resolve()) or path.is_symlink():
        raise ValueError("EVIDENCE_PATH_ESCAPE")
    with path.open("rb") as stream:
        raw = stream.read(32 * 1024 * 1024 + 1)
    if len(raw) > 32 * 1024 * 1024:
        raise ValueError("EVIDENCE_SIZE_LIMIT")
    if hashlib.sha256(raw).hexdigest() != reference["sha256"]:
        raise ValueError("EVIDENCE_HASH_MISMATCH")
    assertions = reference["assertions"]
    if not isinstance(assertions, list) or not assertions:
        raise ValueError("EVIDENCE_ASSERTIONS_REQUIRED")
    document = json.loads(raw)
    for assertion in assertions:
        if not isinstance(assertion, dict) or set(assertion) != {"pointer", "equals"}:
            raise ValueError("INVALID_EVIDENCE_ASSERTION")
        actual = pointer_value(document, assertion["pointer"])
        # JSON boolean true is not interchangeable with the number one.
        if type(actual) is not type(assertion["equals"]) or actual != assertion["equals"]:
            raise ValueError("EVIDENCE_ASSERTION_FAILED")
    return {"path": str(path), "sha256": reference["sha256"], "assertions": assertions}


def assess(directory: Path, manifest: dict, root: Path):
    checked = INSPECTOR["checked"]
    verification = INSPECTOR["inspect"](directory)
    if not verification["scores_recomputed"]:
        raise ValueError("PROMOTION_SCORES_NOT_RECOMPUTED")
    report = checked(directory / "report.json", "report_hash")
    frozen = checked(directory / "frozen.json", "freeze_hash")
    if report.get("version") != "model-evaluation-report/v4":
        raise ValueError("PROMOTION_REQUIRES_V4")
    if manifest.get("version") != "model-promotion-evidence/v1":
        raise ValueError("INVALID_PROMOTION_EVIDENCE_VERSION")
    if (
        manifest.get("suite_hash") != report["suite_hash"]
        or manifest.get("report_hash") != report["report_hash"]
    ):
        raise ValueError("PROMOTION_EVIDENCE_CONTEXT_MISMATCH")
    supplied = manifest.get("gates", {})
    if not isinstance(supplied, dict) or supplied.keys() - PROMOTION_EVIDENCE_GATES.keys():
        raise ValueError("UNKNOWN_PROMOTION_EVIDENCE_GATE")
    evidence = {}
    for name, entry in supplied.items():
        if not isinstance(entry, dict) or set(entry) != {"status", "evidence_refs"}:
            raise ValueError("INVALID_PROMOTION_GATE")
        refs = [verify_evidence_reference(ref, root) for ref in entry["evidence_refs"]]
        evidence[name] = {
            "status": entry["status"],
            "evidence_refs": refs,
            "evidence_verified": bool(refs),
        }
    # Complexity is checked here from compiled source, not accepted from manifest assertions.
    complexity = verify_complex_chemistry(frozen["suite"]["cases"])
    if frozen.get("complexity_verification") != complexity:
        raise ValueError("COMPLEXITY_VERIFICATION_MISMATCH")
    freeze_path = directory / "frozen.json"
    evidence["complex_chemistry_gate"] = {
        "status": "pass" if complexity["passed"] else "fail",
        "evidence_verified": True,
        "evidence_refs": [
            {
                "path": str(freeze_path.resolve()),
                "sha256": hashlib.sha256(freeze_path.read_bytes()).hexdigest(),
            }
        ],
    }
    assessment = assess_promotion(
        report["measured_thresholds_passed"], report["coverage"], evidence
    )
    result = {
        "version": "model-promotion-evidence-assessment/v1",
        "suite_hash": report["suite_hash"],
        "report_hash": report["report_hash"],
        "evidence_manifest_hash": content_hash(manifest),
        "verification": verification,
        "complexity_verification": complexity,
        "assessment": assessment,
        "authenticated": False,
        "execution_authority": False,
    }
    result["assessment_hash"] = content_hash(result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.resolve().is_relative_to(args.directory.resolve()):
        raise ValueError("OUTPUT_INSIDE_IMMUTABLE_BUNDLE")
    result = assess(args.directory, INSPECTOR["read_json"](args.evidence), args.root)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps(result, indent=2))
