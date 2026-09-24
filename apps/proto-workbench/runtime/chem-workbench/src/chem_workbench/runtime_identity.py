"""Content fingerprints of installed, result-relevant local runtime files."""

from __future__ import annotations

import hashlib
import sys
import threading
from itertools import chain
from pathlib import Path
from typing import Any

from chem_workbench.paths import psi4_prefix
from chem_workbench.visualization import content_hash

_LOCK = threading.Lock()
_CACHE: dict[str, tuple[int, int, int, str]] = {}


def file_digest(path: Path) -> str:
    stat = path.stat()
    stamp = (stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    key = str(path.resolve())
    with _LOCK:
        previous = _CACHE.get(key)
        if previous is not None and previous[:3] == stamp:
            return previous[3]
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    with _LOCK:
        _CACHE[key] = (*stamp, digest)
    return digest


def environment_identity(kind: str, repository: Path) -> dict[str, Any]:
    prefix = (
        psi4_prefix(repository) if kind in {"psi4_water", "psi4_molecular"} else Path(sys.prefix)
    )
    roots: list[Path] = []
    packages = {
        "mock": [],
        "ase_emt": ["ase", "numpy", "numpy.libs", "scipy", "scipy.libs"],
        "psi4_water": ["psi4", "qcengine", "qcelemental", "numpy", "pydantic", "pydantic_core"],
        "psi4_molecular": ["psi4", "qcengine", "qcelemental", "numpy", "pydantic", "pydantic_core"],
    }[kind]
    site = prefix / "Lib/site-packages"
    for name in packages:
        path = site / name
        if not path.exists():
            raise ValueError(f"WORKER_UNAVAILABLE: missing runtime package {name}")
        roots.append(path)
        roots.extend(site.glob(name.replace(".", "_") + "-*.dist-info"))
    if kind in {"psi4_water", "psi4_molecular"}:
        roots.extend(
            p
            for p in (
                prefix / "Library/bin",
                prefix / "Library/share/psi4",
                prefix / "share/psi4",
                prefix / "conda-meta",
            )
            if p.exists()
        )
    entries = {}
    for root in roots:
        for path in root.rglob("*"):
            if (
                path.is_file()
                and "__pycache__" not in path.parts
                and path.suffix not in {".pyc", ".pyo"}
            ):
                entries[path.relative_to(prefix).as_posix()] = file_digest(path)
    return {
        "version": "runtime-content/v1",
        "prefix": str(prefix.resolve()),
        "files": len(entries),
        "manifest_hash": content_hash(entries),
        "cache_policy": "size-mtime-ctime; trusted local OS owner",
    }


def _refinement_linked(path: Path) -> bool:
    """Include Windows junctions without requiring Python 3.12 Path APIs."""
    return path.is_symlink() or bool(getattr(path.lstat(), "st_file_attributes", 0) & 0x400)


def refinement_environment_identity(repository: Path, *, profile_id: str) -> dict[str, Any]:
    """Bind installed files for the separate Windows Psi4/OptKing descriptor.

    This is an on-disk identity, not an import trace or backend availability test.
    Binding the complete Python Lib tree covers transitive optimizer dependencies,
    single-file modules, package metadata and the standard library without importing
    the isolated environment into the controller. Installing an unrelated package
    also invalidates this deliberately conservative refinement identity. Existing
    single-point identities retain their original narrower scope.

    The worker must separately bind its actual resolved basis, effective options,
    loaded versions, invocation and evaluated records. File presence does not prove
    a functional, gradient or optimizer API is usable.
    """
    from chem_workbench.method_profiles import get_method_profile

    get_method_profile(profile_id)
    prefix = psi4_prefix(repository).resolve()
    site = prefix / "Lib/site-packages"
    # These are essential installed components, not a claim that this list alone
    # enumerates all imports. The complete Lib tree below binds the dependencies.
    required = {
        "python": prefix / "python.exe",
        "psi4_driver": site / "psi4/driver/driver.py",
        "optking": site / "optking/__init__.py",
        "qcengine": site / "qcengine/__init__.py",
        "qcelemental": site / "qcelemental/__init__.py",
        "numpy": site / "numpy/__init__.py",
        "pydantic": site / "pydantic/__init__.py",
        "pydantic_core": site / "pydantic_core/__init__.py",
        "msgpack": site / "msgpack/__init__.py",
        "libxc": prefix / "Library/bin/xc.dll",
        "python_lib": prefix / "Lib",
        "native_runtime": prefix / "Library/bin",
        "package_records": prefix / "conda-meta",
    }
    for name, path in required.items():
        valid = (
            path.is_dir()
            if name in {"python_lib", "native_runtime", "package_records"}
            else path.is_file()
        )
        if not valid:
            raise ValueError(f"WORKER_UNAVAILABLE: missing refinement runtime component {name}")
    cores = sorted(path for path in (site / "psi4").glob("core*.pyd") if path.is_file())
    python_dlls = sorted(path for path in prefix.glob("python*.dll") if path.is_file())
    if not cores or not python_dlls:
        raise ValueError("WORKER_UNAVAILABLE: missing refinement Psi4 core or Python runtime")
    data_roots = [
        path for path in (prefix / "Library/share/psi4", prefix / "share/psi4") if path.is_dir()
    ]
    basis_files = [path / "basis/def2-tzvppd.gbs" for path in data_roots]
    basis_files = [path for path in basis_files if path.is_file()]
    if not basis_files:
        raise ValueError("WORKER_UNAVAILABLE: missing refinement def2-tzvppd basis file")
    # Lib includes Psi4 driver and core plus OptKing's complete installed Python
    # dependency trees. All Psi4 data include auxiliary basis and grid resources.
    roots = [prefix / "Lib", prefix / "Library/bin", prefix / "conda-meta", *data_roots]
    if (prefix / "DLLs").is_dir():
        roots.append(prefix / "DLLs")
    for root in roots:
        if _refinement_linked(root):
            raise ValueError("WORKER_UNAVAILABLE: linked refinement runtime directory")
    standalone = [prefix / "python.exe", *prefix.glob("*.dll"), *prefix.glob("python*.zip")]
    transient_directories = {
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        ".cache",
        "scratch",
        "test_scratch",
    }
    entries = {}
    for path in chain(standalone, (p for root in roots for p in root.rglob("*"))):
        relative = path.relative_to(prefix)
        # rglob does not descend directory symlinks. Reject them before the file
        # filter so a linked import package cannot silently disappear from entries.
        if _refinement_linked(path):
            raise ValueError("WORKER_UNAVAILABLE: linked refinement runtime file or directory")
        if (
            path.is_file()
            and not transient_directories.intersection(relative.parts)
            and not any(part.startswith("pytest-of-") for part in relative.parts)
            and path.suffix.lower() not in {".pyc", ".pyo", ".log", ".tmp"}
        ):
            if not path.resolve().is_relative_to(prefix):
                raise ValueError("WORKER_UNAVAILABLE: refinement runtime file leaves its prefix")
            entries[path.relative_to(prefix).as_posix()] = file_digest(path)
    entries = dict(sorted(entries.items()))
    return {
        "version": "refinement-runtime-content/v1",
        "profile_id": profile_id,
        "prefix": str(prefix),
        "files": len(entries),
        "manifest_hash": content_hash(entries),
        "entries": entries,
        "roots": [path.relative_to(prefix).as_posix() for path in roots],
        "required_components": {
            name: path.relative_to(prefix).as_posix() for name, path in required.items()
        },
        "psi4_core_files": {
            path.relative_to(prefix).as_posix(): entries[path.relative_to(prefix).as_posix()]
            for path in cores
        },
        "basis_files": {
            path.relative_to(prefix).as_posix(): entries[path.relative_to(prefix).as_posix()]
            for path in basis_files
        },
        "cache_policy": "size-mtime-ctime; trusted local OS owner",
        "excluded": (
            "Python bytecode/cache directories, transient .log/.tmp files "
            "and named test scratch directories"
        ),
        "scope": (
            "Installed file inventory; actual imports, loaded modules and effective basis "
            "require worker evidence"
        ),
        "backend_verified": False,
    }
