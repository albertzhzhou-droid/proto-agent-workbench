"""Real-backend acceptance checks for the M0 environment (skip when absent).

A skip in ordinary core CI reports a missing optional backend. A failure in an
environment that claims backend support is a failed acceptance gate, not a
skip. Reference values below were generated with the pinned backends on
2026-09-05 and recorded in docs/compatibility-spikes/2026-09-05-m0-backend-
acceptance.md; they are installation smoke references, not accuracy claims.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
FCC_COPPER_CIF = REPOSITORY_ROOT / "examples" / "crystals" / "structures" / "fcc-copper.cif"
SILICON_CIF = REPOSITORY_ROOT / "examples" / "crystals" / "structures" / "silicon.cif"
VERIFY_CHEMISTRY = REPOSITORY_ROOT / "scripts" / "verify_chemistry_environment.py"
PSI4_PYTHON = REPOSITORY_ROOT / ".chem-backends" / "psi4" / "python.exe"
PSI4_LAUNCHER = REPOSITORY_ROOT / "scripts" / "run_psi4_python.ps1"
XDL_PYTHON = REPOSITORY_ROOT / ".chem-backends" / "xdl" / "Scripts" / "python.exe"

WATER_INCHI = "InChI=1S/H2O/h1H2"
COPPER_EMT_PER_ATOM_EV = -0.004952520525836501


def _installed(module: str) -> bool:
    return importlib.util.find_spec(module) is not None


requires_rdkit = pytest.mark.skipif(not _installed("rdkit"), reason="rdkit is not installed")
requires_pymatgen = pytest.mark.skipif(
    not _installed("pymatgen"), reason="pymatgen is not installed"
)
requires_ase = pytest.mark.skipif(not _installed("ase"), reason="ase is not installed")
requires_qcelemental = pytest.mark.skipif(
    not _installed("qcelemental"), reason="qcelemental is not installed"
)
requires_psi4 = pytest.mark.skipif(
    not PSI4_PYTHON.is_file() or not PSI4_LAUNCHER.is_file(),
    reason="the isolated Psi4 backend environment is not installed",
)
requires_xdl = pytest.mark.skipif(
    not XDL_PYTHON.is_file(), reason="the isolated XDL environment is not installed"
)


@requires_rdkit
def test_rdkit_round_trips_the_water_identity() -> None:
    from rdkit import Chem

    molecule = Chem.MolFromSmiles("O")
    inchi = Chem.MolToInchi(molecule)

    assert inchi == WATER_INCHI
    assert Chem.MolToInchi(Chem.MolFromMolBlock(Chem.MolToMolBlock(molecule))) == WATER_INCHI


@requires_pymatgen
def test_pymatgen_reads_the_bundled_cif_fixtures() -> None:
    from pymatgen.core import Structure

    copper = Structure.from_file(str(FCC_COPPER_CIF))
    assert copper.composition.reduced_formula == "Cu"
    assert len(copper) == 4
    assert abs(copper.lattice.a - 3.6149) < 1e-9

    silicon = Structure.from_file(str(SILICON_CIF))
    assert silicon.composition.reduced_formula == "Si"
    assert len(silicon) == 8
    assert abs(silicon.lattice.a - 5.431) < 1e-9


@requires_ase
def test_ase_emt_reproduces_the_copper_fixture_reference() -> None:
    import numpy as np
    from ase.calculators.emt import EMT
    from ase.io import read as ase_read

    atoms = ase_read(str(FCC_COPPER_CIF), format="cif")
    assert len(atoms) == 4
    assert set(atoms.get_chemical_symbols()) == {"Cu"}
    atoms.calc = EMT()
    per_atom = float(atoms.get_potential_energy()) / len(atoms)

    assert abs(per_atom - COPPER_EMT_PER_ATOM_EV) < 1e-8
    assert float(np.max(np.abs(atoms.get_forces()))) < 1e-10


@requires_qcelemental
def test_qcelemental_builds_water_qcschema() -> None:
    import qcelemental as qcel

    molecule = qcel.models.Molecule.from_data("O 0 0 0\nH 0 0 1\nH 1 0 0")

    assert tuple(molecule.symbols) == ("O", "H", "H")
    assert molecule.molecular_charge == 0
    assert molecule.geometry.shape == (3, 3)


@requires_psi4
def test_psi4_backend_reproduces_water_hf_sto3g(tmp_path: Path) -> None:
    report_path = tmp_path / "psi4.json"
    completed = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(PSI4_LAUNCHER),
            str(VERIFY_CHEMISTRY),
            "--psi4",
            "--output",
            str(report_path),
        ],
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr[-2000:]
    report = json.loads(report_path.read_text(encoding="utf-8"))
    energy = float(report["water_hf_sto3g"]["energy_hartree"])
    assert report["water_hf_sto3g"]["success"] is True
    assert -75.1 < energy < -74.8


@requires_xdl
def test_xdl_stays_confined_to_its_isolated_environment() -> None:
    completed = subprocess.run(
        [str(XDL_PYTHON), "-c", "import xdl; print(xdl.__version__)"],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr[-2000:]
    assert completed.stdout.strip().startswith("2.1")
    assert not _installed("xdl"), "the workbench environment must not import xdl"
