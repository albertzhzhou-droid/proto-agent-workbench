"""Owned cwd checks and a real stdlib atexit subprocess; no native chemistry."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from chem_workbench import execution
from chem_workbench.refinement_execution.disk_budget import OwnedRunDirectory


@pytest.fixture
def owned(tmp_path):
    (tmp_path / "run").mkdir()
    return OwnedRunDirectory.capture(tmp_path, "run")


def test_helper_creates_exclusive_child_and_keeps_existing_scratch_contents(owned):
    scratch = owned.path / "scratch"
    scratch.mkdir()
    retained = scratch / "existing.txt"
    retained.write_text("retained unchanged")
    parent_cwd = Path.cwd()
    cwd = execution._prepare_refinement_worker_cwd(owned)
    assert cwd.path == scratch / "worker-cwd"
    cwd.verify()
    assert retained.read_text() == "retained unchanged"
    assert Path.cwd() == parent_cwd
    with pytest.raises(FileExistsError):
        execution._prepare_refinement_worker_cwd(owned)


@pytest.mark.parametrize("boundary", ["run", "scratch"])
def test_linked_lexical_ancestor_rejected_without_creating_cwd(owned, monkeypatch, boundary):
    scratch = owned.path / "scratch"
    scratch.mkdir()
    target = owned.path if boundary == "run" else scratch
    actual_lstat = Path.lstat

    def linked(path, *args, **kwargs):
        info = actual_lstat(path, *args, **kwargs)
        if path == target:
            return SimpleNamespace(
                st_mode=info.st_mode,
                st_file_attributes=getattr(info, "st_file_attributes", 0) | 0x400,
            )
        return info

    monkeypatch.setattr(Path, "lstat", linked)
    with pytest.raises(ValueError, match="reparse point"):
        execution._prepare_refinement_worker_cwd(owned)
    assert not (scratch / "worker-cwd").exists()


@pytest.mark.parametrize("kind", ["scratch_file", "cwd_file", "cwd_directory"])
def test_occupied_target_is_preserved_and_not_admitted(owned, kind):
    scratch = owned.path / "scratch"
    if kind == "scratch_file":
        scratch.write_text("prior file")
        preserved = scratch
    else:
        scratch.mkdir()
        target = scratch / "worker-cwd"
        if kind == "cwd_directory":
            target.mkdir()
            preserved = target / "prior.txt"
        else:
            preserved = target
        preserved.write_text("prior file")
    with pytest.raises((ValueError, FileExistsError)):
        execution._prepare_refinement_worker_cwd(owned)
    assert preserved.read_text() == "prior file"


def test_captured_cwd_detects_directory_replacement(owned):
    cwd = execution._prepare_refinement_worker_cwd(owned)
    cwd.path.rename(cwd.path.with_name("original-worker-cwd"))
    cwd.path.mkdir()
    with pytest.raises(ValueError, match="identity changed"):
        cwd.verify()


def test_real_stdlib_exit_hook_writes_timer_inside_owned_cwd(owned, tmp_path):
    """A real Python child demonstrates cwd/atexit only, never Psi4 behavior."""
    cwd = execution._prepare_refinement_worker_cwd(owned)
    script = tmp_path / "stdlib_exit_probe.py"
    script.write_text(
        "import atexit, json, os, sys\n"
        "from pathlib import Path\n"
        "atexit.register(lambda: Path('timer.dat').write_text('stdlib fixture only'))\n"
        "assert Path(sys.argv[1]).is_absolute() and Path(sys.argv[2]).is_absolute()\n"
        "assert Path(sys.argv[1]).read_text() == 'absolute input'\n"
        "Path(sys.argv[2]).write_text('absolute output')\n"
        "print(json.dumps({'cwd': os.getcwd(), 'native_chemistry_imported': False}))\n",
        encoding="utf-8",
    )
    input_path, output_path = owned.path / "input.txt", owned.path / "output.txt"
    input_path.write_text("absolute input")
    parent_cwd = Path.cwd()
    result = subprocess.run(
        [sys.executable, "-I", "-S", str(script), str(input_path), str(output_path)],
        cwd=cwd.path,
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    assert json.loads(result.stdout) == {"cwd": str(cwd.path), "native_chemistry_imported": False}
    assert result.stderr == ""
    assert (cwd.path / "timer.dat").read_text() == "stdlib fixture only"
    assert not (owned.path / "timer.dat").exists()
    assert not (tmp_path / "timer.dat").exists()
    assert output_path.read_text() == "absolute output"
    assert Path.cwd() == parent_cwd
    cwd.verify()
