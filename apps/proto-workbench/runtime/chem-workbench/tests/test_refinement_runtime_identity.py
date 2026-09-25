"""Pure file-inventory contracts; no isolated interpreter or calculator launch."""

from pathlib import Path

import pytest

from chem_workbench import runtime_identity
from chem_workbench.visualization import content_hash

PROFILE = "psi4.wb97x_v.def2_tzvppd.optimize.v1"


def write(prefix: Path, name: str, content: bytes = b"retained installed bytes") -> Path:
    path = prefix / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


@pytest.fixture
def installed(tmp_path, monkeypatch):
    prefix = tmp_path / "isolated"
    for name in (
        "python.exe",
        "python312.dll",
        "Lib/pathlib.py",
        "DLLs/_ssl.pyd",
        "Lib/site-packages/psi4/__init__.py",
        "Lib/site-packages/psi4/driver/driver.py",
        "Lib/site-packages/psi4/core.cp312-win_amd64.pyd",
        "Library/bin/xc.dll",
        "Library/bin/blas.dll",
        "Library/share/psi4/basis/def2-tzvppd.gbs",
        "Library/share/psi4/basis/def2-universal-jkfit.gbs",
        "conda-meta/psi4.json",
    ):
        write(prefix, name)
    for package in (
        "optking",
        "qcengine",
        "qcelemental",
        "numpy",
        "pydantic",
        "pydantic_core",
        "msgpack",
    ):
        write(prefix, f"Lib/site-packages/{package}/__init__.py")
        write(prefix, f"Lib/site-packages/{package}-1.0.dist-info/METADATA")
    # Single-file and transitive dependencies must not disappear from the identity
    # because they have no directory named after their distribution.
    for name in (
        "typing_extensions.py",
        "pint/registry.py",
        "flexparser/flexparser.py",
        "yaml/__init__.py",
        "dotenv/main.py",
        "pydantic_settings/main.py",
    ):
        write(prefix, "Lib/site-packages/" + name)
    monkeypatch.setattr(runtime_identity, "psi4_prefix", lambda repository: prefix)
    return prefix


def identity(prefix):
    return runtime_identity.refinement_environment_identity(prefix, profile_id=PROFILE)


@pytest.mark.parametrize(
    "name",
    [
        "Lib/site-packages/optking/__init__.py",
        "Lib/site-packages/optking-1.0.dist-info/METADATA",
        "Lib/site-packages/typing_extensions.py",
        "Lib/site-packages/flexparser/flexparser.py",
        "Lib/site-packages/pydantic_settings/main.py",
        "Lib/site-packages/psi4/driver/driver.py",
        "Lib/site-packages/psi4/core.cp312-win_amd64.pyd",
        "Library/bin/xc.dll",
        "Library/share/psi4/basis/def2-tzvppd.gbs",
        "Library/share/psi4/basis/def2-universal-jkfit.gbs",
        "python.exe",
        "python312.dll",
        "Lib/pathlib.py",
        "DLLs/_ssl.pyd",
    ],
)
def test_refinement_identity_changes_with_result_relevant_installed_bytes(installed, name):
    before = identity(installed)
    write(installed, name, b"changed runtime bytes with different size")
    after = identity(installed)
    assert before["manifest_hash"] != after["manifest_hash"]
    assert after["backend_verified"] is False


def test_optimizer_changes_do_not_rebind_existing_hf_profiles(installed):
    before = {
        kind: runtime_identity.environment_identity(kind, installed)
        for kind in ("psi4_water", "psi4_molecular")
    }
    refinement_before = identity(installed)
    write(installed, "Lib/site-packages/optking/__init__.py", b"new optimizer implementation")
    for kind, previous in before.items():
        assert runtime_identity.environment_identity(kind, installed) == previous
        assert previous["version"] == "runtime-content/v1"
    assert identity(installed)["manifest_hash"] != refinement_before["manifest_hash"]


def test_legacy_identity_result_shape_and_manifest_are_unchanged(installed):
    value = runtime_identity.environment_identity("mock", installed)
    assert value == {
        "version": "runtime-content/v1",
        "prefix": str(Path(runtime_identity.sys.prefix).resolve()),
        "files": 0,
        "manifest_hash": content_hash({}),
        "cache_policy": "size-mtime-ctime; trusted local OS owner",
    }


def test_bytecode_is_excluded_but_new_dependency_tree_invalidates_refinement(installed):
    before = identity(installed)
    write(installed, "Lib/site-packages/optking/__pycache__/opt.cpython-312.pyc")
    write(installed, "Lib/pathlib.pyc")
    write(installed, "Lib/site-packages/optking/optking.log")
    write(installed, "Lib/site-packages/optking/.pytest_cache/state.json")
    write(installed, "Lib/site-packages/optking/test_scratch/calculation.dat")
    write(installed, "Lib/site-packages/optking/pytest-of-user/pytest-0/calculation.dat")
    assert identity(installed) == before
    write(installed, "Lib/site-packages/new_dependency/execution.py")
    assert identity(installed)["manifest_hash"] != before["manifest_hash"]


@pytest.mark.parametrize(
    "name",
    [
        "Lib/site-packages/optking/__init__.py",
        "Library/bin/xc.dll",
        "Lib/site-packages/psi4/core.cp312-win_amd64.pyd",
        "python312.dll",
        "Library/share/psi4/basis/def2-tzvppd.gbs",
    ],
)
def test_missing_required_runtime_is_not_a_valid_refinement_identity(installed, name):
    path = installed / name
    path.unlink()
    if name == "Lib/site-packages/optking/__init__.py":
        path.parent.rmdir()
    with pytest.raises(ValueError, match="WORKER_UNAVAILABLE"):
        identity(installed)


def test_explicit_registered_profile_required_before_files_are_read(tmp_path, monkeypatch):
    def unexpected_prefix(repository):
        pytest.fail("unsupported profile must fail before runtime discovery")

    monkeypatch.setattr(runtime_identity, "psi4_prefix", unexpected_prefix)
    with pytest.raises(ValueError, match="UNSUPPORTED_PROFILE"):
        runtime_identity.refinement_environment_identity(tmp_path, profile_id="psi4.hf.sto3g")


def test_basis_and_core_bytes_are_explicitly_identifiable(installed):
    value = identity(installed)
    assert value["version"] == "refinement-runtime-content/v1"
    assert value["profile_id"] == PROFILE
    assert value["basis_files"] == {
        "Library/share/psi4/basis/def2-tzvppd.gbs": runtime_identity.file_digest(
            installed / "Library/share/psi4/basis/def2-tzvppd.gbs"
        )
    }
    assert set(value["psi4_core_files"]) == {"Lib/site-packages/psi4/core.cp312-win_amd64.pyd"}
    assert value["required_components"]["optking"] == "Lib/site-packages/optking/__init__.py"
    assert value["manifest_hash"] == content_hash(value["entries"])
    assert value["files"] == len(value["entries"])
    assert value["entries"]["Library/bin/xc.dll"] == runtime_identity.file_digest(
        installed / "Library/bin/xc.dll"
    )


def test_alternative_data_root_and_auxiliary_data_are_bound(installed):
    (installed / "Library/share/psi4/basis/def2-tzvppd.gbs").unlink()
    write(installed, "share/psi4/basis/def2-tzvppd.gbs")
    before = identity(installed)
    assert set(before["basis_files"]) == {"share/psi4/basis/def2-tzvppd.gbs"}
    write(installed, "share/psi4/grids/new-grid.dat")
    assert identity(installed)["manifest_hash"] != before["manifest_hash"]


@pytest.mark.parametrize("reported_link_kind", ["symlink", "reparse_attribute"])
@pytest.mark.parametrize("name", ["Lib", "Lib/site-packages/optking", "Lib/site-packages/pint"])
def test_linked_root_or_dependency_fails_before_directory_is_skipped(
    installed, monkeypatch, reported_link_kind, name
):
    # Simulate the OS link-type report on real temporary directories, avoiding a
    # requirement for Windows Developer Mode or symbolic-link creation privilege.
    linked = installed / name
    if reported_link_kind == "symlink":
        original = Path.is_symlink
        monkeypatch.setattr(Path, "is_symlink", lambda self: self == linked or original(self))
    else:
        original_stat = Path.lstat

        class ReparseStat:
            def __init__(self, actual):
                self.actual = actual
                self.st_file_attributes = getattr(actual, "st_file_attributes", 0) | 0x400

            def __getattr__(self, name):
                return getattr(self.actual, name)

        def reported_lstat(self, *args, **kwargs):
            actual = original_stat(self, *args, **kwargs)
            return ReparseStat(actual) if self == linked else actual

        monkeypatch.setattr(Path, "lstat", reported_lstat)
    with pytest.raises(ValueError, match="WORKER_UNAVAILABLE: linked refinement runtime"):
        identity(installed)


def test_link_rejection_does_not_eagerly_enumerate_link_target(installed, monkeypatch):
    linked = installed / "Lib/site-packages/pint"
    original_glob = Path.rglob
    original_link = Path.is_symlink

    def guarded_glob(self, pattern):
        if self == installed / "Lib":
            yield linked
            pytest.fail("must reject a linked directory before requesting its descendants")
        else:
            yield from original_glob(self, pattern)

    monkeypatch.setattr(Path, "rglob", guarded_glob)
    monkeypatch.setattr(Path, "is_symlink", lambda self: self == linked or original_link(self))
    with pytest.raises(ValueError, match="WORKER_UNAVAILABLE: linked refinement runtime"):
        identity(installed)
