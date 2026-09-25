"""Explicitly synthetic artifact contracts; these fixtures are not model acceptance evidence."""

from __future__ import annotations

import copy
import hashlib
import json
import runpy
import uuid
from pathlib import Path

import pytest

from chem_workbench.evaluation import model_identity
from chem_workbench.visualization import content_hash

ROOT = Path(__file__).resolve().parents[1]


def hashed(value, key):
    result = copy.deepcopy(value)
    result.pop(key, None)
    result[key] = content_hash(result)
    return result


def write(root, name, value, hash_key=None):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if hash_key:
        value = hashed(value, hash_key)
    path.write_text(json.dumps(value), encoding="utf-8")
    return {"path": name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def capture(frozen, hour, pid):
    sha = hashlib.sha256(b"synthetic").hexdigest()
    template = "synthetic active template"
    template_sha = hashlib.sha256(template.encode()).hexdigest()
    file = {"path": "C:/synthetic/model.gguf", "bytes": 1, "sha256": sha}
    binaries = []
    for role in (
        "running_lmstudio_executable",
        "running_backend_executable",
        "observed_loaded_backend_module",
        "on_disk_backend_manifest",
        "startup_argument_chat_template",
    ):
        binaries.append(
            {
                "role": role,
                "file": {
                    "path": "C:/synthetic/engine.exe",
                    "bytes": 1,
                    "sha256": template_sha if role == "startup_argument_chat_template" else sha,
                },
            }
        )
    process = hashed(
        {
            "version": "model-process-attestation/v1",
            "process_identity_stable": True,
            "model_file_argument": file["path"],
            "binary_bindings": binaries,
            "engine_process": {"pid": pid, "executable_path": "C:/synthetic/engine.exe"},
            "active_chat_template": {"text": template, "utf8_sha256": template_sha},
            "active_runtime": {"engine": "llama.cpp", "name": "synthetic", "version": "test"},
        },
        "attestation_hash",
    )
    return hashed(
        {
            "version": "model-runtime-identity/v1",
            "provider_stable": True,
            "provider": frozen["model_identity"],
            "captured_at": f"2026-09-11T{hour:02d}:00:00+00:00",
            "files": [{"role": "entryPoint", **file}],
            "process_attestation": process,
            "gguf": {
                "tokenizer_encoded_metadata_sha256": sha,
                "tokenizer_fields": {"synthetic": sha},
                "chat_template": template,
                "chat_template_sha256": template_sha,
            },
            "decoding": {
                "temperature": 0,
                "max_tokens": 2400,
                "reasoning_effort": "none",
                "chat_template_kwargs": {"enable_thinking": False},
            },
        },
        "identity_hash",
    )


def run_entry(root, name, fixture, hour, key="candidate", hardware="synthetic-host", passed=True):
    frozen = hashed(
        {
            "run_id": name,
            "fixtures_hash": fixture["fixtures_hash"],
            "model_identity": model_identity(
                {
                    "key": key,
                    "available": True,
                    "installed": True,
                    "model_id": name,
                    "endpoint": "http://127.0.0.1:1234",
                }
            ),
            "code_identity": {"src/example.py": content_hash("synthetic source")},
            "hardware_accounting": {"host": hardware},
            "frozen_at_utc": f"2026-09-11T{hour:02d}:00:00+00:00",
        },
        "freeze_hash",
    )
    write(root, name + "/frozen.json", frozen)
    write(root, name + "/fixtures.json", fixture)
    row_hashes = {}
    for case in fixture["cases"]:
        row = hashed(
            {
                "id": case["id"],
                "attempted": True,
                "seconds": 1,
                "score": {"passed": passed, "sampled_correct_abstention": True},
                "provider_calls": [
                    {
                        "seconds": 0.1,
                        "response_text": "synthetic abstention reason",
                        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
                    }
                ],
            },
            "row_hash",
        )
        write(root, name + "/" + case["id"] + ".json", row)
        row_hashes[case["id"]] = row["row_hash"]
    report = hashed(
        {
            "version": "design-model-report/v1",
            "freeze_hash": frozen["freeze_hash"],
            "fixtures_hash": fixture["fixtures_hash"],
            "complete": True,
            "identity_stable": True,
            "local_acceptance_checks_passed": passed,
            "coverage": {"sufficient": True},
            "completed_at_utc": f"2026-09-11T{hour + 1:02d}:00:00+00:00",
            "case_rows": row_hashes,
            "metrics": {"synthetic_only": True},
        },
        "report_hash",
    )
    return {
        "report": write(root, name + "/report.json", report),
        "identity_before": write(root, name + "/before.json", capture(frozen, hour - 1, hour)),
        "identity_after": write(root, name + "/after.json", capture(frozen, hour + 2, hour + 100)),
    }


@pytest.fixture
def composer(monkeypatch):
    functions = runpy.run_path(str(ROOT / "scripts/assess_design_promotion.py"))
    # Only the replay dependency is replaced. Production load_run always calls the real inspector.
    monkeypatch.setitem(
        functions["RUNNER"], "inspect_run", lambda *_args, **_kwargs: {"verified": True}
    )
    return functions


@pytest.fixture(scope="module")
def tmp_path(tmp_path_factory):
    return tmp_path_factory.mktemp("synthetic-design-promotion")


@pytest.fixture(scope="module")
def synthetic_evidence(tmp_path):
    cases = [
        {
            "id": f"synthetic-{i}",
            "expected": {"decision": {"action": "needs_input" if i >= 40 else "run_workflow"}},
        }
        for i in range(130)
    ]
    suite = hashed({"cases": cases}, "suite_hash")
    fixture = hashed({"suite": suite, "cases": cases}, "fixtures_hash")
    runs = [run_entry(tmp_path, "repeat1", fixture, 4), run_entry(tmp_path, "repeat2", fixture, 8)]
    baseline = run_entry(tmp_path, "baseline", fixture, 12, "google/gemma-4-e2b", passed=False)
    notes = write(tmp_path, "synthetic-review-observations.json", {"scope": "Synthetic test only"})
    fresh = {
        "version": "design-held-out-review/v1",
        "suite_hash": suite["suite_hash"],
        "fixtures_hash": fixture["fixtures_hash"],
        "suite_author_id": "separate-author-agent",
        "controller_author_ids": ["controller-author-agent"],
        "reviewer_id": "independent-review-agent",
        "review_kind": "independent_agent_observation_review",
        "authored_at": "2026-09-11T00:00:00+00:00",
        "reviewed_at": "2026-09-11T01:00:00+00:00",
        "case_reviews": [
            {
                "case_id": case["id"],
                "case_hash": content_hash(case),
                "determination": "held_out",
                "rationale": "Synthetic independent finding.",
            }
            for case in cases
        ],
        "evidence_refs": [notes],
    }
    rationale = {
        "version": "design-abstention-review/v1",
        "suite_hash": suite["suite_hash"],
        "review_kind": "independent_agent_observation_review",
        "reviewer_id": "rationale-review-agent",
        "reviews": [],
    }
    for entry in runs:
        report = json.loads((tmp_path / entry["report"]["path"]).read_text())
        for case in cases[40:]:
            rationale["reviews"].append(
                {
                    "report_hash": report["report_hash"],
                    "case_id": case["id"],
                    "row_hash": report["case_rows"][case["id"]],
                    "response_hash": content_hash("synthetic abstention reason"),
                    "expected_reason": "Synthetic expected semantic reason.",
                    "observed_reason": "Synthetic independently observed reason.",
                    "verdict": "correct",
                }
            )
    return hashed(
        {
            "version": "design-promotion-evidence/v1",
            "candidate_runs": runs,
            "baseline_run": baseline,
            "fresh_suite_review": write(tmp_path, "fresh.json", fresh, "review_hash"),
            "abstention_review": write(tmp_path, "rationale.json", rationale, "review_hash"),
        },
        "manifest_hash",
    )


@pytest.fixture
def evidence(synthetic_evidence):
    return copy.deepcopy(synthetic_evidence)


def replace_review(tmp_path, evidence, field, mutate):
    name = evidence[field]["path"]
    review = json.loads((tmp_path / name).read_text())
    mutate(review)
    evidence[field] = write(tmp_path, uuid.uuid4().hex + ".json", review, "review_hash")
    return hashed(evidence, "manifest_hash")


def test_missing_evidence_and_boolean_checklists_never_promote(tmp_path, composer):
    result = composer["assess"](
        hashed({"version": "design-promotion-evidence/v1"}, "manifest_hash"), tmp_path
    )
    assert not result["promotion_approved"]
    assert all(item["status"] == "not_checked" for item in result["gates"].values())
    checklist = hashed(
        {"version": "design-promotion-evidence/v1", "all_checks_passed": True}, "manifest_hash"
    )
    with pytest.raises(ValueError, match="UNKNOWN_MANIFEST_FIELDS"):
        composer["assess"](checklist, tmp_path)


def test_repeated_runs_are_bound_but_design_only_cannot_promote(tmp_path, composer, evidence):
    result = composer["assess"](evidence, tmp_path)
    for key in (
        "candidate_repeats",
        "matched_e2b_baseline",
        "pinned_model_runtime",
        "fresh_held_out_suite",
        "semantic_abstention",
        "all_attempt_costs",
    ):
        assert result["gates"][key]["status"] == "pass"
    assert result["gates"]["existing_structure_acceptance"]["status"] == "not_checked"
    assert not result["promotion_approved"]
    assert result["costs_all_attempts"][2]["failed_rows"] == 130
    assert result["costs_all_attempts"][2]["tokens"]["observed_totals"]["total_tokens"] == 1950


def test_duplicate_run_is_not_a_repeat(tmp_path, composer, evidence):
    evidence["candidate_runs"][1] = evidence["candidate_runs"][0]
    with pytest.raises(ValueError, match="DUPLICATE_REPEATS"):
        composer["assess"](hashed(evidence, "manifest_hash"), tmp_path)


def test_actual_replay_rejection_cannot_be_overridden_by_report_boolean(
    tmp_path, composer, evidence, monkeypatch
):
    monkeypatch.setitem(
        composer["RUNNER"], "inspect_run", lambda *_args, **_kwargs: {"verified": False}
    )
    with pytest.raises(ValueError, match="REPLAY_REQUIRED"):
        composer["assess"](evidence, tmp_path)


@pytest.mark.parametrize(
    "field", ["hardware", "weights", "runtime", "template", "bracket", "budget"]
)
def test_changed_hardware_or_pinned_identity_fails(tmp_path, composer, evidence, field):
    entry = evidence["candidate_runs"][1]
    if field == "hardware":
        fixture = json.loads((tmp_path / "repeat2/fixtures.json").read_text())
        evidence["candidate_runs"][1] = run_entry(
            tmp_path, "other-host", fixture, 8, hardware="other"
        )
        message = "UNMATCHED_COMPARISON"
    else:
        value = json.loads((tmp_path / entry["identity_after"]["path"]).read_text())
        if field == "weights":
            value["files"][0]["sha256"] = "a" * 64
            message = "PINNED_IDENTITY_DRIFT"
        elif field == "runtime":
            value["process_attestation"]["binary_bindings"][1]["file"]["sha256"] = "b" * 64
            value["process_attestation"] = hashed(value["process_attestation"], "attestation_hash")
            message = "PINNED_IDENTITY_DRIFT"
        elif field == "budget":
            value["decoding"]["max_tokens"] = 1200
            message = "DECODING_BUDGET"
        elif field == "template":
            value["process_attestation"]["active_chat_template"]["text"] += " changed"
            value["process_attestation"] = hashed(value["process_attestation"], "attestation_hash")
            message = "ACTIVE_CHAT_TEMPLATE"
        else:
            value["captured_at"] = "2026-09-11T00:00:00+00:00"
            message = "IDENTITY_CAPTURE_BRACKET"
        entry["identity_after"] = write(tmp_path, "changed-identity.json", value, "identity_hash")
    with pytest.raises(ValueError, match=message):
        composer["assess"](hashed(evidence, "manifest_hash"), tmp_path)


@pytest.mark.parametrize("incorrect,expected", [(4, "pass"), (5, "fail")])
def test_reason_threshold_applies_to_each_repeat_not_averaged(
    tmp_path, composer, evidence, incorrect, expected
):
    def change(review):
        for row in review["reviews"][:incorrect]:
            row["verdict"] = "incorrect"

    updated = replace_review(tmp_path, evidence, "abstention_review", change)
    assert (
        composer["assess"](updated, tmp_path)["gates"]["semantic_abstention"]["status"] == expected
    )


def test_unreviewed_negative_cannot_disappear_from_reason_denominator(tmp_path, composer, evidence):
    updated = replace_review(
        tmp_path, evidence, "abstention_review", lambda value: value["reviews"].pop()
    )
    with pytest.raises(ValueError, match="RATIONALE_DENOMINATOR"):
        composer["assess"](updated, tmp_path)


def test_reviewer_cannot_be_controller_author(tmp_path, composer, evidence):
    updated = replace_review(
        tmp_path,
        evidence,
        "fresh_suite_review",
        lambda value: value.update(reviewer_id="controller-author-agent"),
    )
    with pytest.raises(ValueError, match="INDEPENDENT_REVIEW_IDENTITY"):
        composer["assess"](updated, tmp_path)


def external_document(composer, name, runs, notes):
    return {
        "version": "design-external-evidence-review/v1",
        "gate": name,
        "reviewer_id": "external-review-agent",
        "review_kind": "independent_agent_observation_review",
        "candidate_report_hashes": [run["report"]["report_hash"] for run in runs],
        "code_identity_hash": content_hash(runs[0]["frozen"]["code_identity"]),
        "findings": [
            {
                "criterion": criterion,
                "outcome": "supported",
                "observation": "Synthetic direct tool observation for this criterion.",
                "evidence_refs": [notes],
            }
            for criterion in composer["EXTERNAL_CRITERIA"][name]
        ],
        "artifacts": {},
    }


def test_independent_observation_review_is_supported_without_extra_human_approval(
    tmp_path, composer, evidence, monkeypatch
):
    runs = [composer["load_run"](entry, tmp_path) for entry in evidence["candidate_runs"]]
    notes = write(
        tmp_path, "external-observation.json", {"synthetic_observation": "Not real acceptance"}
    )
    reviews = {}
    for name in composer["EXTERNAL_CRITERIA"]:
        document = external_document(composer, name, runs, notes)
        reviews[name] = write(tmp_path, name + ".json", document, "review_hash")
    evidence["external_reviews"] = reviews
    # Domain validators are tested separately. This verifies the composition has no permanent veto.
    monkeypatch.setitem(composer["assess"].__globals__, "verify_external", lambda *_args: True)
    result = composer["assess"](hashed(evidence, "manifest_hash"), tmp_path)
    assert result["promotion_approved"] and not result["authenticated"]
    assert result["scientific_review"] == "unreviewed" and not result["execution_authority"]
    reviews.pop("existing_structure_acceptance")
    assert not composer["assess"](hashed(evidence, "manifest_hash"), tmp_path)["promotion_approved"]


def test_observation_review_cannot_be_replaced_with_pass_booleans(tmp_path, composer, evidence):
    runs = [composer["load_run"](entry, tmp_path) for entry in evidence["candidate_runs"]]
    notes = write(tmp_path, "boolean-notes.json", {"passed": True})
    doc = external_document(composer, "ui_acceptance", runs, notes)
    for finding in doc["findings"]:
        finding["observation"] = True
    evidence["external_reviews"] = {
        "ui_acceptance": write(tmp_path, "bad-review.json", doc, "review_hash")
    }
    with pytest.raises(ValueError, match="REVIEW_OBSERVATIONS_REQUIRED"):
        composer["assess"](hashed(evidence, "manifest_hash"), tmp_path)


def test_junit_failure_and_all_skipped_are_not_regression_success(tmp_path, composer):
    path = tmp_path / "junit.xml"
    for body, expected in [("<failure/>", False), ("<skipped/>", False), ("", True)]:
        path.write_text(f"<testsuite><testcase>{body}</testcase></testsuite>")
        assert (
            composer["verify_external"]("deterministic_regressions", {"junit": path}, [], tmp_path)
            is expected
        )


def test_hash_bound_package_bytes_cannot_change_after_review(tmp_path, composer):
    files = {}
    for name in ("ChemWorkbench.exe", "resources/app/main.cjs", "resources/app/runtime.json"):
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"synthetic package bytes")
        files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    manifest = {"version": "desktop-preview-manifest/v1", "files": files}
    ref = write(tmp_path, "release-manifest.json", manifest)
    args = (
        "packaged_acceptance",
        {"release_manifest": tmp_path / ref["path"]},
        [{"frozen": {"code_identity": {}}}],
        tmp_path,
    )
    assert composer["verify_external"](*args)
    (tmp_path / "ChemWorkbench.exe").write_bytes(b"changed")
    with pytest.raises(ValueError, match="FILE_HASH_MISMATCH"):
        composer["verify_external"](*args)


def test_legacy_20_case_structure_report_cannot_satisfy_general_acceptance(
    tmp_path, composer, monkeypatch
):
    folder = tmp_path / "legacy-structure"
    report_ref = write(tmp_path, "legacy-structure/report.json", {"case_rows": {}}, "report_hash")
    write(
        tmp_path,
        "legacy-structure/frozen.json",
        {"suite": {"cases": [{"id": str(i), "family": "admitted_complete"} for i in range(20)]}},
        "freeze_hash",
    )
    execution_ref = write(
        tmp_path,
        "legacy-structure/execution.json",
        {"rows": [{"id": str(i), "passed": True} for i in range(20)]},
        "acceptance_hash",
    )
    monkeypatch.setattr(
        composer["runpy"],
        "run_path",
        lambda *_args: {"inspect": lambda *_args: {"scores_recomputed": True}},
    )
    assert folder.is_dir()
    with pytest.raises(ValueError, match="STRUCTURE_FULL_DENOMINATOR"):
        composer["verify_external"](
            "existing_structure_acceptance",
            {
                "report": tmp_path / report_ref["path"],
                "execution": tmp_path / execution_ref["path"],
            },
            [],
            tmp_path,
        )


def test_shared_snapshot_allows_only_the_design_dependency_declaration(composer):
    shared = {"src/example.py": "frozen", "uv.lock": "locked"}
    assert composer["shared_code_matches"](shared, {**shared, "pyproject.toml": "declared"})
    assert not composer["shared_code_matches"]({"src/example.py": "frozen"}, shared)
    assert not composer["shared_code_matches"]({**shared, "uv.lock": "changed"}, shared)


@pytest.mark.parametrize("call_count,passed", [(1, True), (2, False)])
def test_contention_count_is_checked_against_bound_raw_calls(
    tmp_path, composer, monkeypatch, call_count, passed
):
    model, code = {"key": "synthetic-candidate"}, {"src/example.py": "frozen"}
    overlap = {"passed": True, "overlap_seconds_lower_bound": 1}
    resource_result = {"passed": True}
    compute = hashed(
        {
            "version": "contention-owned-compute/v1",
            "worker_liveness": {},
            "resource_ceilings": {},
            "job_count": 1,
            "new_real_computation": True,
            "cached_result_reused": False,
        },
        "compute_report_hash",
    )
    documents = {
        "contention-input.json": {"model_identity": model, "code_identity": code},
        "model-request.json": {"calls": [{} for _ in range(call_count)]},
        "compute-report.json": compute,
        "contention-resources.json": {},
    }
    hashes = {
        name: write(tmp_path, "bounded-report/" + name, document)["sha256"]
        for name, document in documents.items()
    }
    report = {
        "version": "model-compute-contention/v1",
        "passed": True,
        "identity_stable": True,
        "overlap": overlap,
        "provider_request_count": call_count,
        "host_compute_submission_count": 1,
        "resource_assessment": resource_result,
        "owned_child_stopped": True,
        "provider_thread_stopped": True,
        "model_execution_authorized": False,
        "model_identity": model,
        "artifact_hashes": hashes,
        "compute_report_hash": compute["compute_report_hash"],
    }
    ref = write(tmp_path, "bounded-report.json", report, "contention_hash")
    monkeypatch.setattr(
        composer["runpy"],
        "run_path",
        lambda *_args: {
            "verified_overlap": lambda *_args: overlap,
            "assess_resources": lambda *_args: resource_result,
        },
    )
    assert (
        composer["verify_external"](
            "bounded_contention",
            {"report": tmp_path / ref["path"]},
            [{"frozen": {"model_identity": model, "code_identity": code}}],
            tmp_path,
        )
        is passed
    )
