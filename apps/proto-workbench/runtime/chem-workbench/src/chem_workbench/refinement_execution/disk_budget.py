"""Host-side metadata budget observation; no launch, process control or deletion.

This is a periodic monitor, not an operating-system disk quota. A running writer
can grow files between observations. The owning Job Object supervisor must stop
its own job on a failed observation, and retain partial evidence before cleanup.
"""

from __future__ import annotations

import math
import os
import re
import shutil
import stat
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True, kw_only=True)
class DiskBudget:
    max_run_bytes: int
    max_entries: int
    minimum_free_bytes: int
    scan_timeout_seconds: float
    interval_seconds: float

    def validate(self) -> None:
        for name in ("max_run_bytes", "max_entries", "minimum_free_bytes"):
            value = getattr(self, name)
            if type(value) is not int or value < (0 if name == "minimum_free_bytes" else 1):
                raise ValueError("INVALID_ARGUMENT: disk budget integer: " + name)
        for name in ("scan_timeout_seconds", "interval_seconds"):
            value = getattr(self, name)
            if type(value) not in (float, int) or not math.isfinite(value) or value <= 0:
                raise ValueError("INVALID_ARGUMENT: positive finite disk clock policy: " + name)


def _identity(info: os.stat_result) -> tuple[int, int]:
    if not info.st_ino:
        raise ValueError("DISK_OBSERVATION_FAILED: filesystem identity unavailable")
    return info.st_dev, info.st_ino


def _reject_link(info: os.stat_result) -> None:
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ValueError("DISK_OBSERVATION_FAILED: reparse point or symbolic link")


def _checked_directory_chain(path: Path) -> list[tuple[Path, tuple[int, int]]]:
    """Check each existing absolute component without resolving links away."""
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("INVALID_ARGUMENT: absolute lexical directory required")
    current = Path(path.anchor)
    result: list[tuple[Path, tuple[int, int]]] = []
    for part in (None, *path.parts[1:]):
        if part is not None:
            current = current / part
        info = current.lstat()
        _reject_link(info)
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError("DISK_OBSERVATION_FAILED: non-directory ancestor")
        result.append((current, _identity(info)))
    return result


@dataclass(frozen=True)
class OwnedRunDirectory:
    """Identity captured by the host after it creates the exclusive run directory.

    Capturing a directory does not grant authority to launch or terminate a job.
    The supervisor must supply the same path as its independently approved run.
    """

    repository_root: Path
    relative_path: str
    ancestor_identities: tuple[tuple[Path, tuple[int, int]], ...]

    @classmethod
    def capture(cls, root: Path, relative_path: str) -> OwnedRunDirectory:
        if (
            type(relative_path) is not str
            or not relative_path
            or re.search(r"[\\:<>\"|?*\x00-\x1f]", relative_path)
            or any(
                part in ("", ".", "..") or part.endswith((" ", "."))
                for part in relative_path.split("/")
            )
        ):
            raise ValueError("INVALID_ARGUMENT: contained run-relative path required")
        chain = _checked_directory_chain(root / relative_path)
        if root not in [path for path, _ in chain]:
            raise ValueError("INVALID_ARGUMENT: exact repository ancestor required")
        return cls(root, relative_path, tuple(chain))

    @property
    def path(self) -> Path:
        return self.repository_root / self.relative_path

    def verify(self) -> None:
        actual = tuple(_checked_directory_chain(self.path))
        if actual != self.ancestor_identities:
            raise ValueError("DISK_OBSERVATION_FAILED: owned directory identity changed")


def observe_disk_budget(
    owned: OwnedRunDirectory,
    budget: DiskBudget,
    *,
    clock: Callable[[], float] = time.monotonic,
    free_bytes: Callable[[Path], int] = lambda path: shutil.disk_usage(path).free,
) -> dict[str, Any]:
    """Bound a live metadata walk; return failure with all available partial counts.

    Reads no file content. Counts every directory entry, hidden files, scratch,
    logs and outputs. Logical lengths conservatively count hard links twice only
    by rejecting them altogether; sparse/compressed physical allocation differs.
    A successful scan is an observation, never an atomic completeness attestation.
    """
    budget.validate()
    started = clock()
    if type(started) not in (int, float) or not math.isfinite(started):
        raise ValueError("INVALID_ARGUMENT: finite monotonic clock required")
    record: dict[str, Any] = {
        "version": "refinement-disk-budget-observation/v1",
        "run_directory": owned.relative_path,
        "budget": asdict(budget),
        "started_monotonic": started,
        "finished_monotonic": None,
        "status": "unverified",
        "reason": None,
        "entry_count": 0,
        "file_count": 0,
        "logical_bytes": 0,
        "free_bytes_before": None,
        "free_bytes_after": None,
        "last_path": None,
        "atomic_snapshot": False,
        "hard_disk_quota": False,
    }

    def tick() -> float:
        now = clock()
        if type(now) not in (int, float) or not math.isfinite(now) or now < started:
            raise ValueError("DISK_OBSERVATION_FAILED: invalid or reversed clock")
        if now - started > budget.scan_timeout_seconds:
            raise ValueError("DISK_OBSERVATION_FAILED: metadata scan deadline")
        return float(now)

    def check_free(field: str) -> None:
        available = free_bytes(owned.path)
        if type(available) is not int or available < 0:
            raise ValueError("DISK_OBSERVATION_FAILED: free-space observation unavailable")
        record[field] = available
        if available < budget.minimum_free_bytes:
            raise ValueError("DISK_LIMIT: minimum free disk space")

    try:
        owned.verify()
        check_free("free_bytes_before")
        pending = [(owned.path, owned.ancestor_identities[-1][1])]
        while pending:
            tick()
            directory, expected_identity = pending.pop()
            before = directory.lstat()
            _reject_link(before)
            if not stat.S_ISDIR(before.st_mode) or _identity(before) != expected_identity:
                raise ValueError("DISK_OBSERVATION_FAILED: directory changed before enumeration")
            with os.scandir(directory) as entries:
                for entry in entries:
                    tick()
                    record["entry_count"] += 1
                    record["last_path"] = Path(entry.path).relative_to(owned.path).as_posix()
                    if record["entry_count"] > budget.max_entries:
                        raise ValueError("DISK_LIMIT: directory entry count")
                    # Windows DirEntry caches can report zero inode/link counts.
                    # Request fresh no-follow metadata for the owned path instead.
                    info = Path(entry.path).lstat()
                    _reject_link(info)
                    if stat.S_ISDIR(info.st_mode):
                        pending.append((Path(entry.path), _identity(info)))
                    elif stat.S_ISREG(info.st_mode):
                        if info.st_nlink != 1 or info.st_size < 0:
                            raise ValueError("DISK_OBSERVATION_FAILED: hard link or invalid length")
                        record["file_count"] += 1
                        record["logical_bytes"] += info.st_size
                        if record["logical_bytes"] > budget.max_run_bytes:
                            raise ValueError("DISK_LIMIT: total run logical bytes")
                    else:
                        raise ValueError("DISK_OBSERVATION_FAILED: unsupported filesystem entry")
            after = directory.lstat()
            _reject_link(after)
            if not stat.S_ISDIR(after.st_mode) or _identity(after) != expected_identity:
                raise ValueError("DISK_OBSERVATION_FAILED: directory changed during enumeration")
        owned.verify()
        check_free("free_bytes_after")
        record["finished_monotonic"] = tick()
        record["status"] = "within_observed_limits"
    except (OSError, ValueError) as error:
        record["reason"] = str(error)
        record["status"] = (
            "limit_exceeded" if str(error).startswith("DISK_LIMIT:") else "unverified"
        )
        record["exception_type"] = type(error).__name__
        finished = clock()
        if type(finished) in (int, float) and math.isfinite(finished) and finished >= started:
            record["finished_monotonic"] = finished
    return record


class DiskBudgetWatch:
    """Scheduled, sticky-failure monitor called by the existing owned supervisor.

    There is no background thread or process control. Any non-success record is
    a stop request to that supervisor; caller must durably retain it first.
    """

    def __init__(self, owned: OwnedRunDirectory, budget: DiskBudget) -> None:
        budget.validate()
        self.owned, self.budget = owned, budget
        self.next_scan: float | None = None
        self.last_clock: float | None = None
        self.failure: dict[str, Any] | None = None

    def check(
        self,
        *,
        force: bool = False,
        clock: Callable[[], float] = time.monotonic,
        free_bytes: Callable[[Path], int] = lambda path: shutil.disk_usage(path).free,
    ) -> dict[str, Any] | None:
        if self.failure is not None:
            return self.failure
        now = clock()
        if type(now) not in (int, float) or not math.isfinite(now):
            raise ValueError("INVALID_ARGUMENT: finite monotonic clock required")
        if self.last_clock is not None and now < self.last_clock:
            raise ValueError("DISK_OBSERVATION_FAILED: monitor clock reversed")
        self.last_clock = float(now)
        if not force and self.next_scan is not None and now < self.next_scan:
            return None
        result = observe_disk_budget(self.owned, self.budget, clock=clock, free_bytes=free_bytes)
        finished = result["finished_monotonic"]
        self.next_scan = (finished if finished is not None else now) + self.budget.interval_seconds
        if result["status"] != "within_observed_limits":
            self.failure = result
        return result
