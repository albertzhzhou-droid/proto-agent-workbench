"""Bounded host-envelope storage only; payloads are explicitly non-scientific."""

import json

import pytest

from chem_workbench.execution import ExecutionStore


def test_refinement_envelope_larger_than_legacy_limit_reopens(tmp_path):
    store = ExecutionStore(tmp_path / "store", artifact_root=tmp_path)
    job_id = "a" * 32
    path = store.run_directory(job_id) / "result.json"
    value = {"test_only": True, "synthetic_storage_payload": "x" * 10_000_001}
    path.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(ValueError, match="size limit"):
        store._read(path)
    assert store.read_refinement_result(job_id) == value


def test_refinement_host_envelope_keeps_a_finite_storage_ceiling(tmp_path):
    store = ExecutionStore(tmp_path / "store", artifact_root=tmp_path)
    job_id = "a" * 32
    path = store.run_directory(job_id) / "result.json"
    with path.open("wb") as stream:
        stream.truncate(64 * 1024**2 + 1)
    with pytest.raises(ValueError, match="size limit"):
        store.read_refinement_result(job_id)


@pytest.mark.parametrize("job_id", ["../other", "a" * 31, "sha256:" + "a" * 64, None])
def test_result_reader_uses_only_an_owned_job_filename(tmp_path, job_id):
    store = ExecutionStore(tmp_path / "store", artifact_root=tmp_path)
    with pytest.raises(ValueError):
        store.read_refinement_result(job_id)
