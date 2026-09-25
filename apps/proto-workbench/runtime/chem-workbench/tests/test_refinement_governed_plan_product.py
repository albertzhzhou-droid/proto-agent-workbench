"""Pure host plan tests; retained geometry, explicit synthetic path/identity fixtures.

No electronic computation, optimizer, provider, approval issuance or process launch.
Runtime and basis refs in the original input are historical, not availability proof.
"""

from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import asdict
from pathlib import Path

import pytest

from chem_workbench.molecular_refinement import seal_refinement_spec
from chem_workbench.refinement_execution import governed_plan as facade
from chem_workbench.refinement_execution import refinement_plan, refinement_subject
from chem_workbench.refinement_execution.disk_budget import DiskBudget
from chem_workbench.refinement_execution.execution_contract import (
    seal_execution_contract,
    validate_worker_request,
)

FIXTURES = Path(__file__).parent / "fixtures/refinement_execution_subject"


def ref(path, root):
    return {
        "path": path.relative_to(root).as_posix(),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def write(path, value):
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")), encoding="utf-8")


def rehash(value, field):
    value[field] = refinement_plan.content_hash(
        {key: item for key, item in value.items() if key != field}
    )


@pytest.fixture(scope="module")
def retained_case(tmp_path_factory):
    root = tmp_path_factory.mktemp("governed-design-source")
    record_path, source_path = root / "record.json", root / "source.chem"
    record_path.write_bytes((FIXTURES / "design-record.original.json").read_bytes())
    source_path.write_bytes((FIXTURES / "candidate-source.original.chem").read_bytes())
    record = json.loads(record_path.read_bytes())
    subject = refinement_subject.prepare_design_candidate_subject(
        record,
        {
            "run_ref": record["record_hash"],
            "candidate_hash": record["organic"]["candidates"][2]["candidate_hash"],
        },
        root=root,
        record_artifact=ref(record_path, root),
        source_artifact=ref(source_path, root),
        electronic_state={"charge": 0, "multiplicity": 1},
    )
    subject_path = root / "subject.json"
    write(subject_path, subject)
    spec = json.loads((FIXTURES / "mass-bound-input.original.json").read_bytes())["spec"]
    assert spec["geometry"] == subject["geometry"]
    # TEST ONLY: relocate source binding; exact original geometry and mass rows stay intact.
    spec["source_binding"] = {
        "kind": "candidate_geometry",
        "source_hash": subject["source_snapshot"]["source_text_hash"],
        "candidate_hash": subject["candidate"]["candidate_hash"],
        "atom_identity_hash": subject["atom_identity_hash"],
        "geometry_hash": subject["geometry"]["geometry_hash"],
        "artifact": ref(subject_path, root),
    }
    spec = seal_refinement_spec({key: value for key, value in spec.items() if key != "spec_hash"})
    write(root / "spec.json", spec)
    write(root / "contract.json", seal_execution_contract(spec, "gradient"))
    return root


@pytest.fixture
def case(tmp_path, retained_case):
    for name in ("record.json", "source.chem", "subject.json", "spec.json", "contract.json"):
        (tmp_path / name).write_bytes((retained_case / name).read_bytes())
    return {
        "root": tmp_path,
        "spec_ref": ref(tmp_path / "spec.json", tmp_path),
        "subject_ref": ref(tmp_path / "subject.json", tmp_path),
        "execution_contract_ref": ref(tmp_path / "contract.json", tmp_path),
        "mode": "gradient",
        "observed_worker_identity": {
            "kind": "psi4_refinement",
            "script": "worker_refinement_psi4.py",
            "fixture": "independently injected synthetic host identity, no runtime observed",
            "script_sha256": "1" * 64,
        },
        "disk_budget": DiskBudget(
            max_run_bytes=8 * 1024**3,
            max_entries=20000,
            minimum_free_bytes=10 * 1024**3,
            scan_timeout_seconds=2.0,
            interval_seconds=5.0,
        ),
    }


def context(case):
    return facade.context_from_artifacts(
        **{key: value for key, value in case.items() if key != "disk_budget"}
    )


def validate(plan, case):
    return facade.validate_plan(plan, case["root"], case["observed_worker_identity"])


def test_actual_host_subject_and_outer_plan_bind_exact_source_and_disk(case):
    plan = facade.prepare(**case)
    core = refinement_plan.build_resolved_plan(context(case))
    assert validate(plan, case) == plan
    assert facade.validate_stored_plan(plan, case["root"]) == plan
    assert len(plan["subject"]["geometry"]["atoms"]) == 34
    assert sum(atom["element"] != "H" for atom in plan["subject"]["geometry"]["atoms"]) == 19
    assert plan["subject"]["computation_authorized"] is False
    assert plan["subject"]["execution_authorized"] is False
    assert (
        plan["subject"]["source_snapshot"]["source_text_hash"]
        != plan["subject"]["candidate"]["generation_request_hash"]
    )
    assert plan["core_plan_hash"] == core["resolved_plan_hash"]
    assert plan["core_logical_plan_hash"] == core["logical_plan_hash"]
    assert plan["resource_ceilings"] == core["resource_ceilings"]
    assert set(plan["resource_ceilings"]) == set(refinement_plan.LIMITS)
    assert plan["disk_budget"] == asdict(case["disk_budget"])
    assert plan["prepared_input"] == core["prepared_input"]
    assert validate_worker_request(plan["prepared_input"]) == plan["prepared_input"]
    assert "disk_budget" not in plan["prepared_input"]
    assert "disk_budget" not in plan["spec"]["resources"]
    assert plan["logical_plan_hash"] == refinement_plan.content_hash(
        {
            "core_logical_plan_hash": core["logical_plan_hash"],
            "artifact_refs": plan["artifact_refs"],
            "disk_budget": plan["disk_budget"],
        }
    )


def test_disk_change_changes_outer_hash_only_and_never_rewrites_request(case):
    first = facade.prepare(**case)
    case["disk_budget"] = {**asdict(case["disk_budget"]), "max_entries": 19999}
    second = facade.prepare(**case)
    assert first["logical_plan_hash"] != second["logical_plan_hash"]
    assert first["resolved_plan_hash"] != second["resolved_plan_hash"]
    for key in ("prepared_input", "prepared_input_hash", "core_plan_hash", "resource_ceilings"):
        assert first[key] == second[key]


def test_history_is_readable_after_worker_change_but_current_validation_rejects(case):
    plan = facade.prepare(**case)
    case["observed_worker_identity"]["script_sha256"] = "2" * 64
    assert facade.validate_stored_plan(plan, case["root"]) == plan
    with pytest.raises(ValueError, match="APPROVAL_STALE"):
        validate(plan, case)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda plan: plan["subject"].update(execution_authorized=True),
        lambda plan: plan["spec"]["source_binding"].update(source_hash="sha256:" + "0" * 64),
        lambda plan: plan["worker"].update(script_sha256="3" * 64),
        lambda plan: plan["prepared_input"].update(mode="optimization"),
        lambda plan: plan["resource_ceilings"].update(threads=4),
        lambda plan: plan.update(core_plan_hash="sha256:" + "0" * 64),
        lambda plan: plan.update(core_logical_plan_hash="sha256:" + "0" * 64),
        lambda plan: plan.update(logical_plan_hash="sha256:" + "0" * 64),
        lambda plan: plan.update(extra="unadmitted field"),
        lambda plan: plan["acceptance"].update(authority="self_approved"),
        lambda plan: plan["artifact_refs"].update(extra={"path": "x", "sha256": "0" * 64}),
    ],
)
def test_rehashed_plan_body_cannot_replace_actual_artifacts_or_observed_context(case, mutation):
    plan = facade.prepare(**case)
    mutation(plan)
    rehash(plan, "resolved_plan_hash")
    with pytest.raises(ValueError):
        validate(plan, case)


@pytest.mark.parametrize(
    "name", ["spec.json", "subject.json", "record.json", "source.chem", "contract.json"]
)
def test_each_raw_artifact_is_checked_on_every_validation_and_history_read(case, name):
    plan = facade.prepare(**case)
    path = case["root"] / name
    path.write_bytes(path.read_bytes() + b"\n")
    with pytest.raises(ValueError, match="bytes changed"):
        validate(plan, case)
    with pytest.raises(ValueError, match="bytes changed"):
        facade.validate_stored_plan(plan, case["root"])


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("max_run_bytes", True),
        ("max_entries", 1.0),
        ("minimum_free_bytes", -1),
        ("scan_timeout_seconds", True),
        ("interval_seconds", "5"),
        ("interval_seconds", float("nan")),
        ("interval_seconds", float("inf")),
        ("scan_timeout_seconds", 0),
        ("unexpected", 1),
    ],
)
def test_disk_policy_is_explicit_exact_and_strictly_typed(case, key, value):
    case["disk_budget"] = {**asdict(case["disk_budget"]), key: value}
    with pytest.raises(ValueError):
        facade.prepare(**case)


def test_disk_field_cannot_be_omitted(case):
    case["disk_budget"] = asdict(case["disk_budget"])
    del case["disk_budget"]["max_entries"]
    with pytest.raises(ValueError, match="five-field"):
        facade.prepare(**case)


@pytest.mark.parametrize("path", ["../spec.json", "/spec.json", "C:/spec.json", "NUL", "a\\b"])
def test_spec_reference_cannot_escape_root(case, path):
    case["spec_ref"]["path"] = path
    with pytest.raises(ValueError):
        facade.prepare(**case)


def test_subject_ref_must_equal_actual_spec_source_ref(case):
    (case["root"] / "other-subject.json").write_bytes((case["root"] / "subject.json").read_bytes())
    case["subject_ref"] = ref(case["root"] / "other-subject.json", case["root"])
    with pytest.raises(ValueError, match="subject reference"):
        facade.prepare(**case)


@pytest.mark.parametrize("version", ["refinement-complex-cohort/v1", "structure-subject/v1"])
def test_unadmitted_structure_and_cohort_have_no_permissive_fallback(case, version):
    subject = json.loads((case["root"] / "subject.json").read_bytes())
    subject["version"] = version
    rehash(subject, "subject_hash")
    write(case["root"] / "subject.json", subject)
    case["subject_ref"] = ref(case["root"] / "subject.json", case["root"])
    spec = json.loads((case["root"] / "spec.json").read_bytes())
    spec["source_binding"]["artifact"] = case["subject_ref"]
    rehash(spec, "spec_hash")
    write(case["root"] / "spec.json", spec)
    case["spec_ref"] = ref(case["root"] / "spec.json", case["root"])
    with pytest.raises(ValueError, match=r"UNSUPPORTED_PROFILE.*Structure and cohort"):
        facade.prepare(**case)


def test_contract_must_be_for_actual_spec_and_mode(case):
    case["mode"] = "optimization"
    with pytest.raises(ValueError):
        facade.prepare(**case)


def test_declared_subject_cannot_bypass_genuine_host_graph_verifier(case, monkeypatch):
    called = []

    def reject(spec, root):
        called.append((spec["spec_hash"], root))
        raise ValueError("host graph/source verification failed")

    monkeypatch.setattr(facade, "verify_design_subject_for_spec", reject)
    with pytest.raises(ValueError, match="host graph/source"):
        facade.prepare(**case)
    assert len(called) == 1


def test_post_validation_source_change_is_rejected_before_context_returns(case, monkeypatch):
    original = facade.verify_design_subject_for_spec

    def mutate_after_validation(spec, root):
        result = original(spec, root)
        path = root / "source.chem"
        path.write_bytes(path.read_bytes() + b"\n")
        return result

    monkeypatch.setattr(facade, "verify_design_subject_for_spec", mutate_after_validation)
    with pytest.raises(ValueError, match="bytes changed"):
        context(case)


def test_context_nested_mutation_cannot_change_previously_authenticated_subject(case):
    actual = context(case)
    actual.subject["execution_authorized"] = True
    rehash(actual.subject, "subject_hash")
    with pytest.raises(ValueError, match="core subject"):
        refinement_plan.build_resolved_plan(actual)


def test_context_valid_resealed_spec_still_cannot_replace_authenticated_spec_bytes(case):
    actual = context(case)
    actual.spec["optimizer_settings"]["maximum_iterations"] = 149
    rehash(actual.spec, "spec_hash")
    with pytest.raises(ValueError, match="core spec"):
        refinement_plan.build_resolved_plan(actual)


@pytest.mark.parametrize("mode", [None, True, {}, "unknown"])
def test_mode_has_strict_type_and_declared_values(case, mode):
    case["mode"] = mode
    with pytest.raises(ValueError, match="execution mode"):
        facade.prepare(**case)


def test_plan_is_detached_from_caller_identity_and_all_outputs(case):
    before = copy.deepcopy(case["observed_worker_identity"])
    plan = facade.prepare(**case)
    plan["worker"]["script_sha256"] = "4" * 64
    assert case["observed_worker_identity"] == before
    fresh = facade.prepare(**case)
    assert fresh["worker"] == before


@pytest.mark.parametrize(
    "bad_worker",
    [[], {"kind": "psi4_water"}, {"kind": "psi4_refinement", "script": "other.py"}],
)
def test_observed_worker_requires_refinement_descriptor(case, bad_worker):
    case["observed_worker_identity"] = bad_worker
    with pytest.raises(ValueError):
        facade.prepare(**case)


def test_raw_json_duplicate_keys_are_not_normalized_away(case):
    path = case["root"] / "contract.json"
    raw = path.read_bytes()
    path.write_bytes(b'{"version":"duplicate",' + raw[1:])
    case["execution_contract_ref"] = ref(path, case["root"])
    with pytest.raises(ValueError, match="duplicate JSON key"):
        facade.prepare(**case)
