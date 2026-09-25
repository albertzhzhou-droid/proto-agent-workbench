"""Filesystem supervision tests; no chemical result or scientific acceptance."""

import os
from dataclasses import replace
from pathlib import Path

import pytest

from chem_workbench.refinement_execution.disk_budget import (
    DiskBudget,
    DiskBudgetWatch,
    OwnedRunDirectory,
    observe_disk_budget,
)


@pytest.fixture
def owned(tmp_path):
    run = tmp_path / "owned-run"
    run.mkdir()
    return OwnedRunDirectory.capture(tmp_path, "owned-run")


@pytest.fixture
def budget():
    return DiskBudget(
        max_run_bytes=100,
        max_entries=20,
        minimum_free_bytes=50,
        scan_timeout_seconds=2.0,
        interval_seconds=1.0,
    )


def observe(owned, budget, **kwargs):
    return observe_disk_budget(
        owned,
        budget,
        clock=kwargs.pop("clock", lambda: 100.0),
        free_bytes=kwargs.pop("free_bytes", lambda _: 1000),
        **kwargs,
    )


def test_count_all_run_content_including_hidden_and_scratch(owned, budget):
    (owned.path / "scratch").mkdir()
    (owned.path / "scratch" / "native.bin").write_bytes(b"x" * 70)
    (owned.path / ".retained").write_bytes(b"x" * 20)
    (owned.path / "output.json").write_bytes(b"x" * 10)
    result = observe(owned, budget)
    assert result["status"] == "within_observed_limits"
    assert (result["entry_count"], result["file_count"], result["logical_bytes"]) == (4, 3, 100)
    assert result["atomic_snapshot"] is False
    assert result["hard_disk_quota"] is False
    assert (owned.path / "scratch" / "native.bin").read_bytes() == b"x" * 70


def test_sum_across_files_exceeds_individual_sizes(owned, budget):
    for index in range(3):
        (owned.path / str(index)).write_bytes(b"x" * 40)
    result = observe(owned, budget)
    assert result["status"] == "limit_exceeded"
    assert result["logical_bytes"] == 120
    assert result["file_count"] == 3
    assert len(list(owned.path.iterdir())) == 3


def test_directory_count_bounds_empty_tree(owned, budget):
    for index in range(3):
        (owned.path / str(index)).mkdir()
    result = observe(owned, replace(budget, max_entries=2))
    assert result["status"] == "limit_exceeded"
    assert result["entry_count"] == 3
    assert result["logical_bytes"] == 0


@pytest.mark.parametrize("free", [49, 0])
def test_low_free_space_before_scan(owned, budget, free):
    result = observe(owned, budget, free_bytes=lambda _: free)
    assert result["status"] == "limit_exceeded"
    assert result["free_bytes_before"] == free
    assert result["entry_count"] == 0


def test_free_space_falls_during_scan(owned, budget):
    values = iter([1000, 40])
    result = observe(owned, budget, free_bytes=lambda _: next(values))
    assert result["status"] == "limit_exceeded"
    assert result["free_bytes_after"] == 40


@pytest.mark.parametrize("free", [True, -1, 1.1, None])
def test_unknown_free_space_does_not_admit(owned, budget, free):
    result = observe(owned, budget, free_bytes=lambda _: free)
    assert result["status"] == "unverified"


def test_io_error_retains_observation(owned, budget):
    def denied(_):
        raise PermissionError("synthetic denied metadata")

    result = observe(owned, budget, free_bytes=denied)
    assert result["status"] == "unverified"
    assert result["exception_type"] == "PermissionError"


def test_replaced_run_directory_is_rejected(owned, budget):
    original = owned.path
    original.rename(original.with_name("prior-owned-run"))
    original.mkdir()
    result = observe(owned, budget)
    assert result["status"] == "unverified"
    assert "identity changed" in result["reason"]
    assert original.with_name("prior-owned-run").is_dir()


def test_hardlink_cannot_cross_ownership(owned, budget):
    outside = owned.repository_root / "outside.bin"
    outside.write_bytes(b"123")
    os.link(outside, owned.path / "alias.bin")
    result = observe(owned, budget)
    assert result["status"] == "unverified"
    assert "hard link" in result["reason"]
    assert outside.read_bytes() == b"123"


def test_reparse_metadata_blocks_enumeration(owned, budget, monkeypatch):
    from chem_workbench.refinement_execution import disk_budget

    original = disk_budget._reject_link
    calls = 0

    def reparse(info):
        nonlocal calls
        calls += 1
        if calls == len(owned.ancestor_identities) + 1:
            raise ValueError("DISK_OBSERVATION_FAILED: reparse point or symbolic link")
        original(info)

    monkeypatch.setattr(disk_budget, "_reject_link", reparse)
    result = observe(owned, budget)
    assert result["status"] == "unverified"
    assert result["entry_count"] == 0


def test_scan_timeout_is_not_success(owned, budget):
    values = iter([100.0, 103.0, 104.0])
    result = observe(owned, budget, clock=lambda: next(values))
    assert result["status"] == "unverified"
    assert "scan deadline" in result["reason"]


def test_reversed_clock_during_scan_is_unverified(owned, budget):
    values = iter([100.0, 99.0, 101.0])
    result = observe(owned, budget, clock=lambda: next(values))
    assert result["status"] == "unverified"
    assert "reversed clock" in result["reason"]


@pytest.mark.parametrize(
    "path", ["", "../elsewhere", "/absolute", "a//b", "a\\b", "a:b", "a/./b", "a.", "a "]
)
def test_unowned_path_rejected(tmp_path, path):
    with pytest.raises(ValueError):
        OwnedRunDirectory.capture(tmp_path, path)


@pytest.mark.parametrize(
    "changes",
    [
        {"max_run_bytes": True},
        {"max_run_bytes": 0},
        {"max_entries": 0},
        {"minimum_free_bytes": -1},
        {"scan_timeout_seconds": float("inf")},
        {"interval_seconds": float("nan")},
        {"interval_seconds": False},
    ],
)
def test_invalid_budget(owned, budget, changes):
    with pytest.raises(ValueError):
        observe(owned, replace(budget, **changes))


def test_watch_interval_terminal_force_and_sticky_failure(owned, budget):
    watch = DiskBudgetWatch(owned, budget)

    def clock():
        return 100.0

    assert watch.check(clock=clock, free_bytes=lambda _: 1000)["status"] == "within_observed_limits"
    assert watch.check(clock=clock, free_bytes=lambda _: 0) is None
    failed = watch.check(force=True, clock=clock, free_bytes=lambda _: 0)
    assert failed["status"] == "limit_exceeded"
    assert watch.check(force=True, clock=clock, free_bytes=lambda _: 1000) is failed


def test_directory_removed_during_scan_is_unverified(owned, budget, monkeypatch):
    from chem_workbench.refinement_execution import disk_budget

    native_scandir = disk_budget.os.scandir
    (owned.path / "vanishing").mkdir()

    def changed(directory):
        if Path(directory).name == "vanishing":
            Path(directory).rmdir()
        return native_scandir(directory)

    monkeypatch.setattr(disk_budget.os, "scandir", changed)
    result = observe(owned, budget)
    assert result["status"] == "unverified"
    assert result["entry_count"] == 1


def test_reversed_monitor_clock_cannot_skip_forever(owned, budget):
    watch = DiskBudgetWatch(owned, budget)
    watch.check(clock=lambda: 100.0, free_bytes=lambda _: 1000)
    with pytest.raises(ValueError, match="monitor clock reversed"):
        watch.check(clock=lambda: 99.0, free_bytes=lambda _: 1000)
