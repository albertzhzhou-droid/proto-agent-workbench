"""Durable disk observations for the host-owned refinement supervisor.

This monitor has no execution authority and does not stop processes or delete
scratch. Its caller owns the Job Object and stops it on any failed observation.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path
from typing import Any, BinaryIO

from chem_workbench.refinement_execution.disk_budget import (
    DiskBudget,
    DiskBudgetWatch,
    OwnedRunDirectory,
)


class RefinementStorageMonitor:
    """Retain a bounded journal; admission failure precedes process creation."""

    JOURNAL_LIMIT = 16 * 1024**2

    def __init__(self, root: Path, run_directory: str, budget: DiskBudget) -> None:
        if type(budget) is not DiskBudget:
            raise ValueError("INVALID_ARGUMENT: explicit DiskBudget required")
        budget.validate()
        self.owned = OwnedRunDirectory.capture(root, run_directory)
        self.watch = DiskBudgetWatch(self.owned, budget)
        self.path = self.owned.path / "supervisor-disk-observations.jsonl"
        self.stream: BinaryIO | None = None
        self.identity: tuple[int, int] | None = None
        self.digest = hashlib.sha256()
        self.length = 0
        self.count = 0
        self.last: dict[str, Any] | None = None
        self.journal_integrity_verified = False

    def __enter__(self) -> RefinementStorageMonitor:
        self.owned.verify()
        self.stream = self.path.open("x+b", buffering=0)
        try:
            info = os.fstat(self.stream.fileno())
            self.identity = info.st_dev, info.st_ino
            if not self.check("before_launch", force=True):
                raise ValueError(
                    "RESOURCE_LIMIT: disk admission failed; retained supervisor journal"
                )
            return self
        except BaseException:
            self.stream.close()
            raise

    def _verify_journal(self) -> None:
        self.journal_integrity_verified = False
        self.owned.verify()
        if self.stream is None or self.stream.closed:
            raise ValueError("DISK_OBSERVATION_FAILED: journal is closed")

        def verify_metadata() -> None:
            assert self.stream is not None
            for info in (os.fstat(self.stream.fileno()), self.path.lstat()):
                if (
                    not stat.S_ISREG(info.st_mode)
                    or getattr(info, "st_file_attributes", 0) & 0x400
                    or info.st_nlink != 1
                    or (info.st_dev, info.st_ino) != self.identity
                    or info.st_size != self.length
                ):
                    raise ValueError("DISK_OBSERVATION_FAILED: supervisor journal identity changed")

        verify_metadata()
        self.stream.seek(0)
        actual = hashlib.sha256()
        remaining = self.length + 1
        consumed = 0
        # Never follow a live appender to EOF: read only admitted bytes plus one
        # sentinel, so journal growth cannot starve the owner's deadline loop.
        while remaining:
            chunk = self.stream.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            actual.update(chunk)
            consumed += len(chunk)
            remaining -= len(chunk)
        if consumed != self.length:
            raise ValueError("DISK_OBSERVATION_FAILED: supervisor journal length changed")
        verify_metadata()
        if actual.digest() != self.digest.digest():
            raise ValueError("DISK_OBSERVATION_FAILED: supervisor journal bytes changed")
        self.stream.seek(0, os.SEEK_END)
        self.journal_integrity_verified = True

    def check(self, phase: str, *, force: bool = False) -> bool:
        observation = self.watch.check(force=force)
        if observation is None:
            return True
        self._verify_journal()
        record = {"phase": phase, "sequence": self.count, "observation": observation}
        raw = (json.dumps(record, sort_keys=True, allow_nan=False) + "\n").encode()
        if self.length + len(raw) > self.JOURNAL_LIMIT:
            raise ValueError("DISK_OBSERVATION_FAILED: supervisor journal exceeds 16 MiB")
        assert self.stream is not None
        self.journal_integrity_verified = False
        if self.stream.write(raw) != len(raw):
            raise OSError("DISK_OBSERVATION_FAILED: short supervisor journal write")
        self.stream.flush()
        os.fsync(self.stream.fileno())
        self.digest.update(raw)
        self.length += len(raw)
        self.count += 1
        self.last = observation
        self._verify_journal()
        return bool(observation["status"] == "within_observed_limits")

    def summary(self) -> dict[str, Any]:
        return {
            "journal": {
                "path": self.path.relative_to(self.owned.repository_root).as_posix(),
                "sha256": self.digest.hexdigest(),
                "bytes": self.length,
            },
            "observations": self.count,
            "journal_integrity_verified": self.journal_integrity_verified,
            "last_observation": self.last,
            "scratch_retained": True,
            "operating_system_disk_quota": False,
        }

    def retain_exception(
        self, error: BaseException, stdout: bytes, stderr: bytes, *, tree_empty: bool
    ) -> None:
        """Retain captured prefixes if no ordinary runner return can be produced."""
        self.owned.verify()
        refs = []
        for kind, raw in (("stdout", stdout), ("stderr", stderr)):
            path = self.owned.path / ("supervisor-failure-" + kind + ".bin")
            with path.open("xb", buffering=0) as stream:
                if stream.write(raw) != len(raw):
                    raise OSError("RETENTION_FAILED: partial capture write")
                os.fsync(stream.fileno())
            refs.append({
                "kind": kind, "path": path.relative_to(self.owned.repository_root).as_posix(),
                "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
            })
        body = {
            "version": "refinement-supervisor-exception/v1",
            "status": "failed", "exception_type": type(error).__name__,
            "error": str(error)[:600], "process_tree_empty_verified": tree_empty,
            "captured_streams_complete": False, "captured_prefixes": refs,
            "storage": self.summary(), "scientific_result_accepted": False,
        }
        raw = json.dumps(body, sort_keys=True, allow_nan=False).encode()
        with (self.owned.path / "supervisor-failure.json").open("xb", buffering=0) as stream:
            if stream.write(raw) != len(raw):
                raise OSError("RETENTION_FAILED: partial failure record write")
            os.fsync(stream.fileno())
        self.owned.verify()

    def __exit__(self, *_args: object) -> None:
        if self.stream is not None:
            self.stream.close()
