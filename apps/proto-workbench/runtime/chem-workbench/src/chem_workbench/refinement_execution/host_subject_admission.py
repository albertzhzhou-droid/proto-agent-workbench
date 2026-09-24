"""Host chemistry/source admission, without issuing execution authority.

The four data artifacts are relative to the caller's evidence root. The verifier
artifact is package-relative code provenance, resolved from the installed module
here; it is not a user-authored path and is not read from the evidence root.
The caller must independently authenticate the retained admission at launch.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from chem_workbench.molecular_refinement import validate_refinement_spec
from chem_workbench.refinement_execution import refinement_subject
from chem_workbench.refinement_execution.worker_subject_replay import (
    ADMISSION_VERSION,
    HOST_SCOPE,
    artifact_ref,
    canonical_hash,
    load_json,
    read_bound,
    replay_closure,
    require,
    same,
)

VERIFIER_MODULE = "chem_workbench.refinement_execution.refinement_subject"
VERIFIER_PACKAGE_PATH = "chem_workbench/refinement_execution/refinement_subject.py"


def verifier_provenance() -> tuple[dict[str, str], bytes]:
    """Installed source metadata; complete loaded-code identity remains host-owned."""
    source = Path(refinement_subject.__file__)
    info = source.lstat()
    require(
        not source.is_symlink() and not getattr(info, "st_file_attributes", 0) & 0x400,
        "linked host verifier source",
    )
    raw = source.read_bytes()
    return {"path": VERIFIER_PACKAGE_PATH, "sha256": hashlib.sha256(raw).hexdigest()}, raw


def build_host_admission(*, root: Path, spec_ref: object) -> dict[str, Any]:
    """Run full product host verification and bind the exact original checked data."""
    verifier_ref, verifier_raw = verifier_provenance()
    spec_ref = artifact_ref(spec_ref)
    spec_raw = read_bound(root, spec_ref)
    spec = load_json(spec_raw)
    require(same(validate_refinement_spec(spec), spec), "host spec normalization")
    subject_ref = spec["source_binding"]["artifact"]
    subject_raw = read_bound(root, subject_ref)
    subject = load_json(subject_raw)
    refs = {
        "spec": spec_ref,
        "subject": subject_ref,
        "design_record": subject["design_record"]["artifact"],
        "source": subject["source_snapshot"]["artifact"],
    }
    raw = {role: read_bound(root, ref) for role, ref in refs.items()}
    require(raw["spec"] == spec_raw and raw["subject"] == subject_raw, "host input drift")
    checked = refinement_subject.verify_design_subject_for_spec(spec, root)
    require(same(subject, checked), "host subject verifier differs")
    host = {
        "verifier_artifact": verifier_ref,
        "graph_validation": checked["graph_validation"],
        "source_semantic_hash": checked["source_snapshot"]["semantic_hash"],
        "molecule_object_hash": checked["source_snapshot"]["molecule_object_hash"],
        "full_subject_spec_validation": True,
    }
    replay = replay_closure(spec, checked, raw["design_record"], raw["source"], host)
    require(
        all(read_bound(root, refs[role]) == value for role, value in raw.items()),
        "host artifact changed during admission",
    )
    require(verifier_provenance() == (verifier_ref, verifier_raw), "host verifier source changed")
    body = {
        "version": ADMISSION_VERSION,
        "scope": HOST_SCOPE,
        "artifacts": refs,
        "spec_hash": spec["spec_hash"],
        "subject_hash": checked["subject_hash"],
        "geometry_hash": spec["geometry"]["geometry_hash"],
        "runtime_binding_hash": spec["runtime_binding"]["binding_hash"],
        "isotope_binding_hash": replay["isotope_binding_hash"],
        "host_validation": host,
        "computation_authorized": False,
        "execution_authorized": False,
    }
    return {**body, "binding_hash": canonical_hash(body)}
