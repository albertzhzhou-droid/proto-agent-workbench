"""Governed execution lifecycle tests (Structure Studio roadmap Next 1-3)."""

from __future__ import annotations

import copy
import importlib.util
import json
import subprocess
import time
from collections.abc import Callable
from pathlib import Path

import pytest

from chem_workbench.execution import (
    ExecutionStore,
    build_cu_resolved_plan,
    build_mock_resolved_plan,
    build_water_resolved_plan,
    issue_approval,
    submit_run,
)
from chem_workbench.tool_gateway import invoke_tool
from chem_workbench.visualization import compile_snapshot

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
RunChem = Callable[..., subprocess.CompletedProcess[bytes]]
FCC_COPPER_CIF = REPOSITORY_ROOT / "examples" / "crystals" / "structures" / "fcc-copper.cif"
WATER_GEOMETRY = REPOSITORY_ROOT / "examples" / "molecules" / "water-hf-sto3g-geometry.json"
PSI4_PYTHON = REPOSITORY_ROOT / ".chem-backends" / "psi4" / "python.exe"

requires_ase = pytest.mark.skipif(
    not importlib.util.find_spec("ase"), reason="ase is not installed"
)
requires_psi4 = pytest.mark.skipif(
    not PSI4_PYTHON.is_file(), reason="the isolated Psi4 environment is not installed"
)


def _approved_mock(store: ExecutionStore, **plan_kwargs: object) -> dict:
    plan = build_mock_resolved_plan(**plan_kwargs)  # type: ignore[arg-type]
    store.save_plan(plan)
    return issue_approval(store, plan["resolved_plan_hash"], actor="test")


def test_mock_worker_completes_the_full_authorization_lifecycle(tmp_path: Path) -> None:
    store = ExecutionStore(tmp_path / "store")
    approval = _approved_mock(store)

    job = submit_run(store, approval["token"])

    assert job["status"] == "succeeded"
    assert job["evidence_eligible"] is False
    run_dir = store.runs / job["job_id"]
    result = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))
    assert result["evidence_eligible"] is False
    assert result["property"] == "marker"
    assert (run_dir / "input.json").is_file()
    assert (run_dir / "stdout.txt").is_file()
    assert result["input_sha256"] and result["output_sha256"]


def test_duplicate_submission_returns_the_same_job(tmp_path: Path) -> None:
    store = ExecutionStore(tmp_path / "store")
    approval = _approved_mock(store)

    first = submit_run(store, approval["token"])
    second = submit_run(store, approval["token"])

    assert first["job_id"] == second["job_id"]
    assert len(list((tmp_path / "store" / "runs").iterdir())) == 1


def test_expired_or_exhausted_approvals_fail_closed(tmp_path: Path) -> None:
    store = ExecutionStore(tmp_path / "store")
    plan = build_mock_resolved_plan()
    store.save_plan(plan)
    approval = issue_approval(store, plan["resolved_plan_hash"], actor="test", ttl_seconds=10)
    with pytest.raises(ValueError, match="APPROVAL_STALE: the approval has expired"):
        submit_run(store, approval["token"], now=approval["expires_at"] + 100)

    # With one launch the repeated intent is idempotent: the same job returns
    # and no second execution happens.
    fresh = issue_approval(store, plan["resolved_plan_hash"], actor="test", max_launches=2)
    first = submit_run(store, fresh["token"])
    second = submit_run(store, fresh["token"])
    assert first["job_id"] == second["job_id"]

    # A new, explicit launch intent spends a fresh launch; with a one-launch
    # budget already spent, a new intent is rejected.
    spent_plan = build_mock_resolved_plan(marker="other")
    store.save_plan(spent_plan)
    spent = issue_approval(store, spent_plan["resolved_plan_hash"], actor="test", max_launches=1)
    submit_run(store, spent["token"], launch_intent="first")
    with pytest.raises(ValueError, match="launch budget is exhausted"):
        submit_run(store, spent["token"], launch_intent="second")


def test_unknown_token_and_tampered_plans_fail_closed(tmp_path: Path) -> None:
    store = ExecutionStore(tmp_path / "store")
    with pytest.raises(ValueError, match="APPROVAL_REQUIRED"):
        submit_run(store, "no-such-token")

    plan = build_mock_resolved_plan()
    store.save_plan(plan)
    approval = issue_approval(store, plan["resolved_plan_hash"], actor="test")
    tampered = copy.deepcopy(plan)
    tampered["resource_ceilings"]["deadline_seconds"] = 1
    with pytest.raises(ValueError, match="content mismatch"):
        store.save_plan(tampered)
    path = store.plans / (plan["resolved_plan_hash"][7:] + ".json")
    path.write_text(json.dumps(tampered), encoding="utf-8")
    with pytest.raises(ValueError, match="content mismatch"):
        submit_run(store, approval["token"])


def test_current_subject_hash_mismatch_is_stale(tmp_path: Path) -> None:
    store = ExecutionStore(tmp_path / "store")
    plan = build_mock_resolved_plan()
    store.save_plan(plan)
    approval = issue_approval(store, plan["resolved_plan_hash"], actor="test")
    with pytest.raises(ValueError, match="current subject differs"):
        submit_run(store, approval["token"], current_subject_hash="sha256:" + "0" * 64)


def test_deadline_kills_the_worker_tree(tmp_path: Path) -> None:
    store = ExecutionStore(tmp_path / "store")
    plan = build_mock_resolved_plan(sleep_seconds=30.0, deadline_seconds=2)
    store.save_plan(plan)
    approval = issue_approval(store, plan["resolved_plan_hash"], actor="test")

    started = time.monotonic()
    job = submit_run(store, approval["token"])
    elapsed = time.monotonic() - started

    assert job["status"] in {"timeout", "failed"}
    assert elapsed < 25
    result = json.loads((store.runs / job["job_id"] / "result.json").read_text())
    assert result["evidence_eligible"] is False


def test_model_arguments_cannot_grant_authority() -> None:
    source = (REPOSITORY_ROOT / "examples" / "crystals" / "fcc-copper.chem").read_text(
        encoding="utf-8"
    )
    cif = FCC_COPPER_CIF.read_text(encoding="utf-8")
    snapshot = compile_snapshot(source, {"structures/fcc-copper.cif": cif})
    assert snapshot.success

    with pytest.raises(ValueError, match="INVALID_ARGUMENT"):
        invoke_tool(
            "plan_cu_lattice_scan",
            {
                "object_id": "fcc_copper",
                "scale_factors": [0.98, 1.0],
                "approved": True,
                "actor": "model",
            },
            snapshot,
        )
    with pytest.raises(ValueError, match="UNKNOWN_TOOL"):
        invoke_tool("execute_python", {}, snapshot)


@requires_ase
def test_copper_batch_executes_with_real_emt_evidence(tmp_path: Path) -> None:
    store = ExecutionStore(tmp_path / "store")
    source = (REPOSITORY_ROOT / "examples" / "crystals" / "fcc-copper.chem").read_text(
        encoding="utf-8"
    )
    snapshot = compile_snapshot(
        source, {"structures/fcc-copper.cif": FCC_COPPER_CIF.read_text(encoding="utf-8")}
    )
    assert snapshot.success
    draft = invoke_tool(
        "plan_cu_lattice_scan",
        {"object_id": "fcc_copper", "scale_factors": [0.98, 1.0, 1.02]},
        snapshot,
    )["data"]

    plan = build_cu_resolved_plan(draft, deadline_seconds=120)
    store.save_plan(plan)
    approval = issue_approval(store, plan["resolved_plan_hash"], actor="test")

    job = submit_run(store, approval["token"])

    assert job["status"] == "succeeded"
    assert job["evidence_eligible"] is True
    result = json.loads((store.runs / job["job_id"] / "result.json").read_text(encoding="utf-8"))
    assert result["evidence_eligible"] is True
    ranking = result["ranking"]
    assert len(ranking) == 3
    assert {float(entry["scale"]) for entry in ranking} == {0.98, 1.00, 1.02}
    energies = {float(entry["scale"]): float(entry["energy_eV_per_atom"]) for entry in ranking}
    assert abs(energies[1.00] - (-0.004952520525836501)) < 1e-8
    assert len(result["plot"]["scales"]) == 3
    assert result["excluded"] == []


@requires_psi4
def test_water_hf_sto3g_executes_with_real_psi4_evidence(tmp_path: Path) -> None:
    store = ExecutionStore(tmp_path / "store")
    geometry = json.loads(WATER_GEOMETRY.read_text(encoding="utf-8"))

    plan = build_water_resolved_plan(geometry, deadline_seconds=300)
    store.save_plan(plan)
    approval = issue_approval(store, plan["resolved_plan_hash"], actor="test")

    job = submit_run(store, approval["token"])

    assert job["status"] == "succeeded"
    result = json.loads((store.runs / job["job_id"] / "result.json").read_text(encoding="utf-8"))
    assert result["evidence_eligible"] is True
    assert result["success"] is True
    assert result["within_acceptance_window"] is True
    energy = float(result["energy_hartree"])
    assert -75.1 < energy < -74.8
    assert result["worker"]["script_sha256"]
    assert result["environment"]["packages"]["qcelemental"]
    raw = json.loads((store.runs / job["job_id"] / "output.json").read_text(encoding="utf-8"))
    assert raw["worker"] == "psi4_water"


def test_cli_chain_proposes_resolves_and_approves_without_execution(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    draft = tmp_path / "draft.json"
    store = tmp_path / "store"
    proposed = run_chem("propose-cu", FCC_COPPER_CIF, "--scales", "0.98", "1.00", "--output", draft)
    assert proposed.returncode == 0, proposed.stderr.decode("utf-8", errors="replace")
    assert json.loads(draft.read_text(encoding="utf-8"))["status"] == "draft_not_executable"

    resolved = tmp_path / "resolved.json"
    resolution = run_chem("resolve", draft, "--store", store, "--output", resolved)
    assert resolution.returncode == 0, resolution.stderr.decode("utf-8", errors="replace")

    approval = run_chem("approve", resolved, "--store", store, "--launches", "1")
    assert approval.returncode == 0, approval.stderr.decode("utf-8", errors="replace")
    assert b"approval_token=" in approval.stdout
    assert (store / "approvals").is_dir()

    bad_scales = run_chem(
        "propose-cu", FCC_COPPER_CIF, "--scales", "1.5", "1.6", "--output", tmp_path / "bad.json"
    )
    assert bad_scales.returncode == 3


def _copper_draft() -> dict:
    source = (REPOSITORY_ROOT / "examples/crystals/fcc-copper.chem").read_text(encoding="utf-8")
    snapshot = compile_snapshot(
        source, {"structures/fcc-copper.cif": FCC_COPPER_CIF.read_text(encoding="utf-8")}
    )
    return invoke_tool(
        "plan_cu_lattice_scan",
        {"object_id": "fcc_copper", "scale_factors": [0.98, 1.0, 1.02]},
        snapshot,
    )["data"]


@pytest.mark.parametrize("field", ["acceptance", "candidates", "allowed_actions"])
def test_full_plan_hash_rejects_unbound_field_tampering(tmp_path: Path, field: str) -> None:
    store = ExecutionStore(tmp_path / "store")
    plan = build_cu_resolved_plan(_copper_draft())
    path = store.save_plan(plan)
    approval = issue_approval(store, plan["resolved_plan_hash"], actor="test")
    if field == "acceptance":
        plan[field]["rule"] = "trust_any_output"
    elif field == "candidates":
        plan[field][0]["lattice_angstrom"][0][0] = "99"
    else:
        plan[field] = ["execute", "publish"]
    path.write_text(json.dumps(plan), encoding="utf-8")
    with pytest.raises(ValueError, match="content mismatch"):
        submit_run(store, approval["token"])
    assert not list(store.jobs.iterdir())


def test_current_worker_drift_invalidates_approval(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import chem_workbench.execution as execution

    store = ExecutionStore(tmp_path / "store")
    approval = _approved_mock(store)
    original = execution.worker_identity
    monkeypatch.setattr(
        execution, "worker_identity", lambda worker: {**original(worker), "script_sha256": "0" * 64}
    )
    with pytest.raises(ValueError, match="launch chain changed"):
        submit_run(store, approval["token"])
    assert not list(store.jobs.iterdir())


@pytest.mark.parametrize("change", ["hash", "composition", "scale", "sites"])
def test_resolve_rejects_forged_copper_candidates(change: str) -> None:
    from chem_workbench.visualization import content_hash

    draft = _copper_draft()
    candidate = draft["candidates"][0]
    if change == "composition":
        candidate["fractional_sites"][0]["element"] = "Ni"
    elif change == "scale":
        candidate["scale"] = "2"
    elif change == "sites":
        candidate["fractional_sites"][0]["coordinates"][0] = "0.1"
    else:
        candidate["lattice_angstrom"][0][0] = "8"
    if change != "hash":
        candidate["candidate_hash"] = content_hash(
            {k: v for k, v in candidate.items() if k != "candidate_hash"}
        )
    draft["logical_plan_hash"] = content_hash(
        {k: v for k, v in draft.items() if k != "logical_plan_hash"}
    )
    with pytest.raises(ValueError):
        build_cu_resolved_plan(draft)


@pytest.mark.parametrize("change", ["unknown", "duplicate", "missing", "scale", "normalization"])
def test_result_must_cover_exact_approved_candidate_set(change: str) -> None:
    from chem_workbench.execution import _validate_result

    plan = build_cu_resolved_plan(_copper_draft())
    outcomes = [
        {
            "candidate_hash": c["candidate_hash"],
            "scale": c["scale"],
            "convergence": "converged",
            "energy_eV": "-4",
            "energy_eV_per_atom": "-1",
        }
        for c in plan["candidates"]
    ]
    response = {"worker": "ase_emt", "normalization": "eV/atom", "outcomes": outcomes}
    if change == "unknown":
        outcomes[0]["candidate_hash"] = "sha256:" + "0" * 64
    elif change == "duplicate":
        outcomes[1] = outcomes[0]
    elif change == "missing":
        outcomes.pop()
    elif change == "scale":
        outcomes[0]["scale"] = "1.05"
    else:
        response["normalization"] = "hartree"
    with pytest.raises(ValueError, match="INVALID_TOOL_OUTPUT"):
        _validate_result(plan, response)


@pytest.mark.parametrize(
    "success,energy", [(False, "-74.96"), ("false", "-74.96"), (True, "-2"), (True, "NaN")]
)
def test_water_failed_acceptance_is_not_success(success: object, energy: str) -> None:
    from chem_workbench.execution import _validate_result

    plan = build_water_resolved_plan(json.loads(WATER_GEOMETRY.read_text(encoding="utf-8")))
    with pytest.raises(ValueError, match="INVALID_TOOL_OUTPUT"):
        _validate_result(
            plan, {"worker": "psi4_water", "success": success, "energy_hartree": energy}
        )


def test_invalid_water_and_resource_limits_rejected() -> None:
    geometry = json.loads(WATER_GEOMETRY.read_text(encoding="utf-8"))
    geometry["atoms"][0][0] = "C"
    with pytest.raises(ValueError, match="H2O"):
        build_water_resolved_plan(geometry)
    with pytest.raises(ValueError, match="host limits"):
        build_mock_resolved_plan(deadline_seconds=-1)


def test_parallel_submission_cannot_spend_same_budget(tmp_path: Path) -> None:
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    store = ExecutionStore(tmp_path / "store")
    approval = _approved_mock(store)
    ready, release = Event(), Event()

    def holder() -> None:
        with ExecutionStore(store.root).submission_lock():
            ready.set()
            assert release.wait(10)

    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(holder)
        assert ready.wait(10)
        try:
            with pytest.raises(ValueError, match="EXECUTION_BUSY"):
                submit_run(store, approval["token"])
            assert store.load_approval(approval["token"])["launches_used"] == 0
        finally:
            release.set()
        future.result()
    assert submit_run(store, approval["token"])["status"] == "succeeded"


def test_store_ids_cannot_escape_root(tmp_path: Path) -> None:
    store = ExecutionStore(tmp_path / "store")
    assert store.load_approval("../../outside") is None
    with pytest.raises(ValueError, match="identifier"):
        store.load_plan("sha256:../../outside")
    with pytest.raises(ValueError, match="identifier"):
        store.run_directory("../../outside")


@pytest.mark.parametrize("mode", ["missing", "stdout", "output"])
def test_runner_enforces_output_contract(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: str
) -> None:
    import sys

    import chem_workbench.execution as execution

    store = ExecutionStore(tmp_path / "store")
    approval = _approved_mock(store)

    def argv(worker: object, input_path: Path, output_path: Path) -> list[str]:
        code = {
            "missing": "pass",
            "stdout": "import sys;sys.stdout.write('x'*200000)",
            "output": (
                "from pathlib import Path;import sys;Path(sys.argv[1]).write_bytes(b'x'*200000)"
            ),
        }[mode]
        return [sys.executable, "-c", code, str(output_path)]

    monkeypatch.setattr(execution, "_worker_argv", argv)
    job = submit_run(store, approval["token"])
    assert job["status"] == ("failed" if mode == "missing" else "output_limit")
    assert job["evidence_eligible"] is False
    assert (store.runs / job["job_id"] / "stdout.txt").stat().st_size <= 100000


def test_assignment_failure_never_executes_child(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import sys

    import chem_workbench.execution as execution

    marker = tmp_path / "must-not-exist"
    monkeypatch.setattr(
        execution,
        "_worker_argv",
        lambda *args: [
            sys.executable,
            "-c",
            "from pathlib import Path;import sys;Path(sys.argv[1]).touch()",
            str(marker),
        ],
    )

    def fail(*args: object) -> None:
        raise OSError("assignment failed")

    monkeypatch.setattr(execution._JobObject, "assign", fail)
    input_path = tmp_path / "input.json"
    input_path.write_text("{}")
    with pytest.raises(OSError, match="assignment failed"):
        execution.run_worker(
            execution.WORKERS["mock"],
            input_path,
            tmp_path / "output.json",
            deadline_seconds=2,
            max_output_bytes=1000,
        )
    assert not marker.exists()


def test_deadline_terminates_descendant(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import ctypes
    import sys

    import chem_workbench.execution as execution

    pid_file = tmp_path / "child.pid"
    code = (
        "import subprocess,sys,time;from pathlib import Path;"
        "p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);"
        "Path(sys.argv[1]).write_text(str(p.pid));time.sleep(60)"
    )
    monkeypatch.setattr(
        execution, "_worker_argv", lambda *args: [sys.executable, "-c", code, str(pid_file)]
    )
    input_path = tmp_path / "input.json"
    input_path.write_text("{}")
    result = execution.run_worker(
        execution.WORKERS["mock"],
        input_path,
        tmp_path / "output.json",
        deadline_seconds=2,
        max_output_bytes=1000,
    )
    assert result["status"] == "timeout"
    pid = int(pid_file.read_text())
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [ctypes.c_uint, ctypes.c_int, ctypes.c_uint]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x100000, False, pid)
    if handle:
        try:
            assert kernel.WaitForSingleObject(handle, 2000) == 0
        finally:
            kernel.CloseHandle(handle)


@pytest.mark.parametrize("command", ["resolve", "approve", "propose-water"])
def test_execution_cli_rejects_nonobject_input(
    tmp_path: Path, run_chem: RunChem, command: str
) -> None:
    path = tmp_path / "invalid.json"
    path.write_text("[]")
    arguments = [command, path]
    if command != "propose-water":
        arguments.extend(["--store", tmp_path / "store"])
    result = run_chem(*arguments)
    assert result.returncode == 3
    assert b"Traceback" not in result.stderr


def test_cli_approval_verifies_reviewed_file(tmp_path: Path, run_chem: RunChem) -> None:
    store = ExecutionStore(tmp_path / "store")
    plan = build_cu_resolved_plan(_copper_draft())
    store.save_plan(plan)
    plan["candidates"][0]["scale"] = "2"
    reviewed = tmp_path / "reviewed.json"
    reviewed.write_text(json.dumps(plan))
    result = run_chem("approve", reviewed, "--store", store.root)
    assert result.returncode == 3
    assert not list(store.approvals.iterdir())


def test_failed_real_worker_output_never_becomes_evidence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import chem_workbench.execution as execution

    store = ExecutionStore(tmp_path / "store")
    plan = build_cu_resolved_plan(_copper_draft())
    store.save_plan(plan)
    approval = issue_approval(store, plan["resolved_plan_hash"], actor="test")

    def invalid_output(
        worker: object, input_path: Path, output_path: Path, **kwargs: object
    ) -> dict:
        output_path.write_text('{"worker":"ase_emt","outcomes":[]}')
        return {"status": "succeeded", "_stdout": b"", "_stderr": b""}

    monkeypatch.setattr(execution, "run_worker", invalid_output)
    job = submit_run(store, approval["token"])
    assert job["status"] == "failed"
    assert job["evidence_eligible"] is False
    result = json.loads((store.runs / job["job_id"] / "result.json").read_text())
    assert result["evidence_eligible"] is False
    assert "validation failed" in result["summary"]
