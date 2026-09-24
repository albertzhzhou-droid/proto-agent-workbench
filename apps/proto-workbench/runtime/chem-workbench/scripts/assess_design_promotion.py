"""Compose retained design acceptance evidence without inference or changing a default.

Hash validation establishes artifact consistency, not author authentication. Independent
observation reviews can satisfy qualitative gates; this is not an extra approval workflow.
Scientific review remains a separate, unreviewed attestation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import runpy
import subprocess
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

from chem_workbench.design_evaluation import check_hash, finite_seconds
from chem_workbench.evaluation import model_identity
from chem_workbench.visualization import content_hash

ROOT = Path(__file__).resolve().parents[1]
RUNNER = runpy.run_path(str(ROOT / "scripts/run_design_evaluation.py"))
COSTS = runpy.run_path(str(ROOT / "scripts/summarize_model_acceptance_costs.py"))
EXTERNAL_CRITERIA = {
    "ui_acceptance": {"actual_workflows", "invalid_inputs", "source_bound_visuals"},
    "packaged_acceptance": {"actual_native_launch", "export_reopen", "package_scope"},
    "deterministic_regressions": {"full_suite_and_required_checks"},
    "windows_supervisor": {"owned_child_containment", "resource_limits", "owned_cleanup"},
    "bounded_contention": {"one_bounded_model_and_psi4_job", "resources_and_cleanup"},
    "committed_source": {"author_and_committer_identity", "frozen_source_commit"},
    "existing_structure_acceptance": {
        "fresh_independent_complex_suite",
        "actual_end_to_end",
        "full_original_acceptance",
    },
}


def require(condition, code):
    if not condition:
        raise ValueError("DESIGN_PROMOTION_" + code)


def read(path):
    return RUNNER["read_json"](path)


def bound(reference, root, *, parse=True):
    require(isinstance(reference, dict) and set(reference) == {"path", "sha256"}, "REFERENCE")
    name = reference["path"]
    require(isinstance(name, str) and not Path(name).is_absolute(), "REFERENCE_PATH")
    path = root / name
    require(not path.is_symlink() and path.resolve().is_relative_to(root.resolve()), "PATH_ESCAPE")
    require(
        isinstance(reference["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", reference["sha256"]),
        "REFERENCE_DIGEST",
    )
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    require(digest == reference["sha256"], "FILE_HASH_MISMATCH")
    return (read(path) if parse else None), path.resolve()


def moment(value):
    require(isinstance(value, str), "TIMESTAMP_REQUIRED")
    result = datetime.fromisoformat(value)
    require(result.tzinfo is not None, "TIMESTAMP_TIMEZONE")
    return result


def text_field(value):
    return isinstance(value, str) and len(value.strip()) >= 12


def gate(passed, *, present=True, details=None):
    return {
        "status": "pass" if passed else "fail" if present else "not_checked",
        "details": details,
    }


def shared_code_matches(shared, design):
    """Legacy Structure/contention snapshots omit only the added dependency declaration."""
    return (
        isinstance(shared, dict)
        and bool(shared)
        and set(design) - set(shared) <= {"pyproject.toml"}
        and set(shared) <= set(design)
        and all(design[key] == value for key, value in shared.items())
    )


def identity_projection(document, frozen):
    check_hash(document, "identity_hash")
    require(document.get("version") == "model-runtime-identity/v1", "IDENTITY_VERSION")
    require(
        document.get("provider_stable") is True
        and model_identity(document.get("provider", {})) == frozen["model_identity"],
        "IDENTITY_PROVIDER",
    )
    process = check_hash(document.get("process_attestation"), "attestation_hash")
    require(
        process.get("version") == "model-process-attestation/v1"
        and process.get("process_identity_stable") is True,
        "PROCESS_ATTESTATION",
    )
    files = document.get("files", [])
    require(
        isinstance(files, list) and files and len({item["role"] for item in files}) == len(files),
        "WEIGHTS_FILES",
    )
    weights = next((item for item in files if item.get("role") == "entryPoint"), None)
    require(
        weights is not None and process.get("model_file_argument") == weights["path"],
        "ACTIVE_WEIGHTS_BINDING",
    )
    bindings = process.get("binary_bindings", [])
    roles = {item.get("role") for item in bindings}
    require(
        {
            "running_lmstudio_executable",
            "running_backend_executable",
            "observed_loaded_backend_module",
            "on_disk_backend_manifest",
            "startup_argument_chat_template",
        }
        <= roles,
        "ACTUAL_RUNTIME_BINARIES",
    )
    all_files = [*files, *(item["file"] for item in bindings)]
    require(
        all(
            type(item.get("bytes")) is int
            and item["bytes"] > 0
            and isinstance(item.get("sha256"), str)
            and re.fullmatch(r"[a-f0-9]{64}", item["sha256"])
            for item in all_files
        ),
        "IDENTITY_FILE_DIGESTS",
    )
    gguf, template = document["gguf"], process["active_chat_template"]
    require(
        isinstance(gguf.get("tokenizer_encoded_metadata_sha256"), str)
        and re.fullmatch(r"[a-f0-9]{64}", gguf["tokenizer_encoded_metadata_sha256"])
        and bool(gguf.get("tokenizer_fields")),
        "TOKENIZER_IDENTITY",
    )
    require(
        hashlib.sha256(template["text"].encode()).hexdigest()
        == template["utf8_sha256"]
        == gguf["chat_template_sha256"]
        == hashlib.sha256(gguf["chat_template"].encode()).hexdigest(),
        "ACTIVE_CHAT_TEMPLATE",
    )
    require(
        any(
            item["role"] == "startup_argument_chat_template"
            and item["file"]["sha256"] == template["utf8_sha256"]
            for item in bindings
        ),
        "TEMPLATE_FILE_BINDING",
    )
    require(
        any(
            item["role"] == "running_backend_executable"
            and item["file"]["path"] == process["engine_process"]["executable_path"]
            for item in bindings
        ),
        "ENGINE_IMAGE_BINDING",
    )
    decoding = document.get("decoding")
    require(
        decoding
        == {
            "temperature": 0,
            "max_tokens": 2400,
            "reasoning_effort": "none",
            "chat_template_kwargs": {"enable_thinking": False},
        },
        "DECODING_BUDGET",
    )
    # PIDs, capture timestamps, file mtimes and temporary template paths may change across loads.
    return {
        "files": sorted((item["role"], item["bytes"], item["sha256"]) for item in files),
        "binaries": sorted(
            (
                item["role"],
                item.get("module_name", ""),
                item["file"]["bytes"],
                item["file"]["sha256"],
            )
            for item in bindings
        ),
        "tokenizer": gguf["tokenizer_encoded_metadata_sha256"],
        "active_template": template["utf8_sha256"],
        "runtime": process["active_runtime"],
        "decoding": decoding,
        "configuration": {
            key: document["provider"].get(key)
            for key in ("key", "quantization", "variant", "loaded_config", "mode")
        },
    }


def load_run(entry, root):
    require(
        isinstance(entry, dict) and set(entry) == {"report", "identity_before", "identity_after"},
        "RUN_ENTRY",
    )
    report, path = bound(entry["report"], root)
    check_hash(report, "report_hash")
    verification = RUNNER["inspect_run"](path.parent, root=root)
    require(verification.get("verified") is True, "REPLAY_REQUIRED")
    frozen = check_hash(read(path.parent / "frozen.json"), "freeze_hash")
    fixtures = check_hash(read(path.parent / "fixtures.json"), "fixtures_hash")
    rows = [
        check_hash(read(path.parent / (case["id"] + ".json")), "row_hash")
        for case in fixtures["cases"]
    ]
    require(
        report.get("version") == "design-model-report/v1"
        and report["freeze_hash"] == frozen["freeze_hash"]
        and report["fixtures_hash"] == fixtures["fixtures_hash"],
        "RUN_BINDING",
    )
    identities = [bound(entry[key], root)[0] for key in ("identity_before", "identity_after")]
    projections = [identity_projection(item, frozen) for item in identities]
    require(projections[0] == projections[1], "PINNED_IDENTITY_DRIFT")
    require(
        moment(identities[0]["captured_at"])
        <= moment(frozen["frozen_at_utc"])
        <= moment(report["completed_at_utc"])
        <= moment(identities[1]["captured_at"]),
        "IDENTITY_CAPTURE_BRACKET",
    )
    return {
        "report": report,
        "frozen": frozen,
        "fixtures": fixtures,
        "rows": rows,
        "identity": projections[0],
    }


def independent(document, controller_authors, suite_author=None):
    reviewer = document.get("reviewer_id")
    require(
        isinstance(reviewer, str)
        and bool(reviewer.strip())
        and reviewer not in controller_authors
        and reviewer != suite_author
        and document.get("review_kind") == "independent_agent_observation_review",
        "INDEPENDENT_REVIEW_IDENTITY",
    )


def fresh_suite_review(reference, runs, root):
    review, _ = bound(reference, root)
    check_hash(review, "review_hash")
    require(review.get("version") == "design-held-out-review/v1", "FRESH_REVIEW_VERSION")
    fixtures = runs[0]["fixtures"]
    require(
        review.get("suite_hash") == fixtures["suite"]["suite_hash"]
        and review.get("fixtures_hash") == fixtures["fixtures_hash"],
        "FRESH_SUITE_BINDING",
    )
    authors = review.get("controller_author_ids")
    author = review.get("suite_author_id")
    require(
        isinstance(authors, list)
        and authors
        and all(isinstance(x, str) and x for x in authors)
        and isinstance(author, str)
        and author
        and author not in authors,
        "SUITE_AUTHOR",
    )
    independent(review, authors, author)
    require(
        moment(review["authored_at"])
        <= moment(review["reviewed_at"])
        <= min(moment(run["frozen"]["frozen_at_utc"]) for run in runs),
        "FRESH_REVIEW_TIMING",
    )
    cases = {case["id"]: case for case in fixtures["suite"]["cases"]}
    findings = review.get("case_reviews", [])
    require(
        len(findings) == len(cases) and {x["case_id"] for x in findings} == set(cases),
        "FRESH_REVIEW_DENOMINATOR",
    )
    require(bool(review.get("evidence_refs")), "FRESH_AUTHORING_EVIDENCE")
    for ref in review["evidence_refs"]:
        bound(ref, root, parse=False)
    passed = all(
        item.get("case_hash") == content_hash(cases[item["case_id"]])
        and item.get("determination") == "held_out"
        and text_field(item.get("rationale"))
        for item in findings
    )
    return review, gate(
        passed,
        details={
            "independence": "Declared agent identities; not signed",
            "reviewed_cases": len(findings),
        },
    )


def rationale_review(reference, runs, fresh, root):
    review, _ = bound(reference, root)
    check_hash(review, "review_hash")
    require(review.get("version") == "design-abstention-review/v1", "RATIONALE_VERSION")
    independent(review, fresh["controller_author_ids"], fresh["suite_author_id"])
    require(review.get("suite_hash") == fresh["suite_hash"], "RATIONALE_SUITE")
    expected = {}
    for run in runs:
        negatives = {
            case["id"]
            for case in run["fixtures"]["cases"]
            if case["expected"]["decision"] == {"action": "needs_input"}
        }
        for row in run["rows"]:
            if row["id"] in negatives:
                expected[(run["report"]["report_hash"], row["id"])] = row
    findings = review.get("reviews", [])
    require(
        len(findings) == len(expected)
        and {(x["report_hash"], x["case_id"]) for x in findings} == set(expected),
        "RATIONALE_DENOMINATOR",
    )
    counts = {run["report"]["report_hash"]: {"correct": 0, "total": 0} for run in runs}
    for item in findings:
        row = expected[(item["report_hash"], item["case_id"])]
        calls = row.get("provider_calls", [])
        response = calls[-1].get("response_text") if calls else None
        require(
            item.get("row_hash") == row["row_hash"]
            and item.get("response_hash") == content_hash(response)
            and text_field(item.get("expected_reason"))
            and text_field(item.get("observed_reason"))
            and item.get("verdict") in {"correct", "incorrect", "unreviewable"},
            "RATIONALE_OBSERVATION_BINDING",
        )
        count = counts[item["report_hash"]]
        count["total"] += 1
        count["correct"] += (
            item["verdict"] == "correct" and row["score"].get("sampled_correct_abstention") is True
        )
    return gate(
        all(x["total"] == 90 and x["correct"] / x["total"] >= 0.95 for x in counts.values()),
        details={
            "per_run": counts,
            "scope": "Independent semantic judgments, "
            "bound to every raw negative response and mechanical safe-stop result",
        },
    )


def external_review(name, reference, runs, fresh, root):
    review, _ = bound(reference, root)
    check_hash(review, "review_hash")
    require(
        review.get("version") == "design-external-evidence-review/v1"
        and review.get("gate") == name,
        "EXTERNAL_REVIEW_VERSION",
    )
    independent(review, fresh["controller_author_ids"], fresh["suite_author_id"])
    require(
        review.get("code_identity_hash") == content_hash(runs[0]["frozen"]["code_identity"])
        and set(review.get("candidate_report_hashes", []))
        == {run["report"]["report_hash"] for run in runs},
        "EXTERNAL_CONTEXT",
    )
    findings = review.get("findings", [])
    require(
        len(findings) == len(EXTERNAL_CRITERIA[name])
        and {item["criterion"] for item in findings} == EXTERNAL_CRITERIA[name],
        "REVIEW_CRITERIA",
    )
    for item in findings:
        require(
            text_field(item.get("observation"))
            and item.get("outcome") in {"supported", "contradicted", "unresolved"}
            and isinstance(item.get("evidence_refs"), list)
            and item["evidence_refs"],
            "REVIEW_OBSERVATIONS_REQUIRED",
        )
        for ref in item["evidence_refs"]:
            bound(ref, root, parse=False)
    artifacts = review.get("artifacts", {})
    require(isinstance(artifacts, dict), "REVIEW_ARTIFACTS")
    parsed = {key: bound(ref, root, parse=False)[1] for key, ref in artifacts.items()}
    machine = verify_external(name, parsed, runs, root)
    return gate(
        machine and all(item["outcome"] == "supported" for item in findings),
        details={
            "reviewer_id": review["reviewer_id"],
            "review_kind": review["review_kind"],
            "artifact_checks_passed": machine,
            "authenticated": False,
        },
    )


def verify_external(name, artifacts, runs, root):
    if name == "deterministic_regressions":
        require("junit" in artifacts, "JUNIT_REQUIRED")
        document = ET.fromstring(artifacts["junit"].read_bytes())
        cases = list(document.iter("testcase"))
        return any(not list(case.iter("skipped")) for case in cases) and not any(
            list(case.iter("failure")) or list(case.iter("error")) for case in cases
        )
    if name == "packaged_acceptance":
        require("release_manifest" in artifacts, "PACKAGE_MANIFEST_REQUIRED")
        manifest = read(artifacts["release_manifest"])
        require(
            manifest.get("version") == "desktop-preview-manifest/v1"
            and isinstance(manifest.get("files"), dict)
            and manifest["files"],
            "PACKAGE_MANIFEST",
        )
        package = artifacts["release_manifest"].parent
        required = {"ChemWorkbench.exe", "resources/app/main.cjs", "resources/app/runtime.json"}
        require(required <= manifest["files"].keys(), "PACKAGE_NATIVE_FILES")
        for path, digest in manifest["files"].items():
            bound({"path": path, "sha256": digest}, package, parse=False)
        for path, expected in runs[0]["frozen"]["code_identity"].items():
            if path.startswith(("tests/", "snapshot-metadata/")):
                continue
            name_in_package = "workspace/" + path
            require(
                name_in_package in manifest["files"]
                and content_hash((package / name_in_package).read_text(encoding="utf-8"))
                == expected,
                "PACKAGE_FROZEN_SOURCE_MISMATCH",
            )
        return True
    if name == "bounded_contention":
        require("report" in artifacts, "CONTENTION_REPORT_REQUIRED")
        report = check_hash(read(artifacts["report"]), "contention_hash")
        require(report.get("version") == "model-compute-contention/v1", "CONTENTION_VERSION")
        for path, digest in report.get("artifact_hashes", {}).items():
            bound(
                {"path": path, "sha256": digest}, artifacts["report"].with_suffix(""), parse=False
            )
        require(
            {
                "contention-input.json",
                "model-request.json",
                "compute-report.json",
                "contention-resources.json",
            }
            <= report.get("artifact_hashes", {}).keys(),
            "CONTENTION_RAW_ARTIFACTS",
        )
        input_path = artifacts["report"].with_suffix("") / "contention-input.json"
        inputs = read(input_path)
        directory = input_path.parent
        provider = read(directory / "model-request.json")
        compute = check_hash(read(directory / "compute-report.json"), "compute_report_hash")
        resources = read(directory / "contention-resources.json")
        verifier = runpy.run_path(str(ROOT / "scripts/verify_model_compute_contention.py"))
        overlap = verifier["verified_overlap"](provider, compute["worker_liveness"])
        resource_result = verifier["assess_resources"](
            resources, compute["worker_liveness"], compute["resource_ceilings"]
        )
        return (
            report.get("passed") is True
            and report.get("identity_stable") is True
            and report.get("overlap", {}).get("passed") is True
            and finite_seconds(report.get("overlap", {}).get("overlap_seconds_lower_bound"))
            and report["overlap"]["overlap_seconds_lower_bound"] > 0
            and type(report.get("provider_request_count")) is int
            and report.get("provider_request_count") == 1
            and type(report.get("host_compute_submission_count")) is int
            and report.get("host_compute_submission_count") == 1
            and report.get("resource_assessment", {}).get("passed") is True
            and report.get("owned_child_stopped") is True
            and report.get("provider_thread_stopped") is True
            and report.get("model_execution_authorized") is False
            and report.get("model_identity") == runs[0]["frozen"]["model_identity"]
            and shared_code_matches(inputs.get("code_identity"), runs[0]["frozen"]["code_identity"])
            and inputs.get("model_identity") == report.get("model_identity")
            and len(provider.get("calls", [])) == 1
            and compute.get("compute_report_hash") == report.get("compute_report_hash")
            and compute.get("version") == "contention-owned-compute/v1"
            and type(compute.get("job_count")) is int
            and compute.get("job_count") == 1
            and compute.get("new_real_computation") is True
            and compute.get("cached_result_reused") is False
            and overlap == report.get("overlap")
            and resource_result == report.get("resource_assessment")
        )
    if name == "committed_source":
        require("commit_record" in artifacts, "COMMIT_RECORD_REQUIRED")
        record = read(artifacts["commit_record"])
        commit = record.get("commit")
        require(isinstance(commit, str) and re.fullmatch(r"[a-f0-9]{40}", commit), "COMMIT_ID")
        for path, expected in runs[0]["frozen"]["code_identity"].items():
            if path.startswith("snapshot-metadata/"):
                continue  # Synthetic vendor index is bound by the frozen source snapshot.
            result = subprocess.run(
                ["git", "show", f"{commit}:{path}"], cwd=root, capture_output=True, check=False
            )
            require(
                result.returncode == 0
                and content_hash(result.stdout.decode("utf-8").replace("\r\n", "\n")) == expected,
                "COMMITTED_SOURCE_MISMATCH",
            )
        return True
    if name == "existing_structure_acceptance":
        require({"report", "execution"} <= artifacts.keys(), "STRUCTURE_EVIDENCE_REQUIRED")
        inspector = runpy.run_path(str(ROOT / "scripts/inspect_model_evaluation_v4.py"))
        verification = inspector["inspect"](artifacts["report"].parent)
        report = check_hash(read(artifacts["report"]), "report_hash")
        frozen = check_hash(read(artifacts["report"].parent / "frozen.json"), "freeze_hash")
        execution = check_hash(read(artifacts["execution"]), "acceptance_hash")
        rows = execution.get("rows", [])
        admitted = {
            case["id"]
            for case in frozen["suite"]["cases"]
            if case.get("family") == "admitted_complete"
        }
        require(
            len(rows) == 40 and len(admitted) == 40 and {row["id"] for row in rows} == admitted,
            "STRUCTURE_FULL_DENOMINATOR",
        )
        for row in rows:
            check_hash(row, "completion_hash")
            require(
                row.get("evaluation_row_hash") == report["case_rows"][row["id"]],
                "STRUCTURE_COMPLETION_BINDING",
            )
            if row.get("passed") is True:
                require(
                    row.get("source_hash") == frozen["source_snapshots"][row["id"]]["source_hash"]
                    and row.get("model_selection_passed") is True
                    and row.get("model_execution_authorized") is False
                    and row.get("direct_tool_parity") is True,
                    "STRUCTURE_SOURCE_PARITY",
                )
                if row.get("expected_action") == "plan_molecular_single_point":
                    require(
                        row.get("real_job_launched") is True
                        and row.get("cached_result_reused") is False
                        and row.get("logical_parity") is True
                        and row.get("resolved_parity") is True
                        and COSTS["verify_calculator_result"](
                            row, artifacts["execution"].with_suffix(""), []
                        )
                        is not None,
                        "STRUCTURE_REAL_COMPUTATION_REQUIRED",
                    )
        return (
            verification.get("scores_recomputed") is True
            and report.get("measured_thresholds_passed") is True
            and report.get("coverage", {}).get("sufficient") is True
            and execution.get("version") == "complex-model-execution-acceptance/v1"
            and execution.get("evaluation_report_hash") == report["report_hash"]
            and execution.get("model_identity") == runs[0]["frozen"]["model_identity"]
            and execution.get("evaluation_freeze_hash") == frozen["freeze_hash"]
            and execution.get("suite_hash") == frozen["suite"]["suite_hash"]
            and execution.get("code_identity_stable") is True
            and execution.get("code_identity") == frozen["code_identity"]
            and shared_code_matches(
                execution.get("code_identity"), runs[0]["frozen"]["code_identity"]
            )
            and len(rows) == 40
            and len({row["id"] for row in rows}) == 40
            and sum(row.get("passed") is True for row in rows) >= 36
        )
    # These qualitative claims require actual independent observations bound above.
    return True


def assess(manifest, root=ROOT):
    check_hash(manifest, "manifest_hash")
    require(manifest.get("version") == "design-promotion-evidence/v1", "MANIFEST_VERSION")
    require(
        set(manifest)
        <= {
            "version",
            "manifest_hash",
            "candidate_runs",
            "baseline_run",
            "fresh_suite_review",
            "abstention_review",
            "external_reviews",
        },
        "UNKNOWN_MANIFEST_FIELDS",
    )
    entries = manifest.get("candidate_runs", [])
    require(isinstance(entries, list) and len(entries) <= 10, "CANDIDATE_RUNS")
    runs = [load_run(entry, root) for entry in entries]
    baseline = load_run(manifest["baseline_run"], root) if manifest.get("baseline_run") else None
    gates = {
        key: gate(False, present=False)
        for key in [
            "candidate_repeats",
            "matched_e2b_baseline",
            "pinned_model_runtime",
            "fresh_held_out_suite",
            "semantic_abstention",
            "all_attempt_costs",
            *EXTERNAL_CRITERIA,
        ]
    }
    costs = []
    if runs:
        report_ids = {run["report"]["report_hash"] for run in runs}
        require(
            len(report_ids) == len(runs)
            and len({run["frozen"]["run_id"] for run in runs}) == len(runs),
            "DUPLICATE_REPEATS",
        )
        matched = [*runs, *([baseline] if baseline else [])]
        comparison = [
            (
                run["frozen"]["fixtures_hash"],
                run["frozen"]["code_identity"],
                run["frozen"]["hardware_accounting"],
                run["identity"]["decoding"],
            )
            for run in matched
        ]
        require(all(value == comparison[0] for value in comparison), "UNMATCHED_COMPARISON")
        require(
            all(run["identity"] == runs[0]["identity"] for run in runs), "REPEAT_IDENTITY_DRIFT"
        )
        gates["candidate_repeats"] = gate(
            len(runs) >= 2
            and all(run["report"].get("local_acceptance_checks_passed") is True for run in runs)
        )
        gates["pinned_model_runtime"] = gate(baseline is not None, present=baseline is not None)
        if baseline:
            gates["matched_e2b_baseline"] = gate(
                baseline["frozen"]["model_identity"].get("key") == "google/gemma-4-e2b"
                and runs[0]["frozen"]["model_identity"].get("key") != "google/gemma-4-e2b"
                and baseline["report"].get("complete") is True
                and baseline["report"].get("identity_stable") is True
                and baseline["report"].get("coverage", {}).get("sufficient") is True
            )
        for run in matched:
            calls = [call for row in run["rows"] for call in row.get("provider_calls", [])]
            tools = [
                step for row in run["rows"] for step in (row.get("record") or {}).get("trace", [])
            ]
            tokens = COSTS["token_summary"](calls)
            durations = COSTS["duration_summary"]([call.get("seconds") for call in calls])
            cost = {
                "report_hash": run["report"]["report_hash"],
                "rows": len(run["rows"]),
                "failed_rows": sum(row["score"].get("passed") is not True for row in run["rows"]),
                "tokens": tokens,
                "model_seconds": durations,
                "tool_seconds": COSTS["duration_summary"]([item.get("seconds") for item in tools]),
            }
            cost["complete"] = (
                bool(calls)
                and tokens["complete"]
                and durations["complete"]
                and cost["tool_seconds"]["complete"]
                and all(
                    row.get("attempted") is True and finite_seconds(row.get("seconds"))
                    for row in run["rows"]
                )
            )
            costs.append(cost)
        gates["all_attempt_costs"] = gate(all(item["complete"] for item in costs))
    fresh = None
    if manifest.get("fresh_suite_review") and runs:
        fresh, gates["fresh_held_out_suite"] = fresh_suite_review(
            manifest["fresh_suite_review"], [*runs, *([baseline] if baseline else [])], root
        )
    if manifest.get("abstention_review") and runs and fresh:
        gates["semantic_abstention"] = rationale_review(
            manifest["abstention_review"], runs, fresh, root
        )
    supplied = manifest.get("external_reviews", {})
    require(
        isinstance(supplied, dict) and supplied.keys() <= EXTERNAL_CRITERIA.keys(), "EXTERNAL_GATES"
    )
    for name, reference in supplied.items():
        if runs and fresh:
            gates[name] = external_review(name, reference, runs, fresh, root)
        else:
            bound(reference, root)  # Even premature supplied references must be hash-valid.
    result = {
        "version": "design-promotion-evidence-assessment/v1",
        "manifest_hash": manifest["manifest_hash"],
        "gates": gates,
        "outstanding_gates": [name for name, item in gates.items() if item["status"] != "pass"],
        "costs_all_attempts": costs,
        "candidate_metric_repeats": [run["report"]["metrics"] for run in runs],
        "baseline_metrics": baseline["report"]["metrics"] if baseline else None,
        "authenticated": False,
        "execution_authority": False,
        "scientific_review": "unreviewed",
        "scope": "Retained evidence assessment with explicit independent agent observations. "
        "No default-model mutation, scientific approval, cryptographic signing, "
        "or whole-goal claim.",
    }
    result["promotion_approved"] = not result["outstanding_gates"]
    result["assessment_hash"] = content_hash(result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = read(args.evidence)
    entries = [
        *manifest.get("candidate_runs", []),
        *([manifest["baseline_run"]] if manifest.get("baseline_run") else []),
    ]
    require(
        not any(
            args.output.resolve().is_relative_to(
                (args.root / entry["report"]["path"]).resolve().parent
            )
            for entry in entries
        ),
        "OUTPUT_INSIDE_IMMUTABLE_RUN",
    )
    result = assess(manifest, args.root)
    RUNNER["write_new"](args.output, result)
    print(json.dumps(result, indent=2))
    return 0 if result["promotion_approved"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
