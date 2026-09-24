"""Small real installation checks; does not enable Workbench compute adapters."""

import argparse
import importlib.metadata as metadata
import io
import json
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--psi4", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "distributions": sorted(
            [
                {
                    "name": d.metadata["Name"],
                    "version": d.version,
                    "license": d.metadata.get("License-Expression") or d.metadata.get("License"),
                }
                for d in metadata.distributions()
            ],
            key=lambda d: d["name"].lower(),
        )
    }
    if args.psi4:
        import qcelemental as qcel
        import qcengine as qcng

        report["conda_packages"] = [
            {
                key: record.get(key)
                for key in ("name", "version", "build", "channel", "url", "sha256", "license")
            }
            for path in sorted((Path(sys.prefix) / "conda-meta").glob("*.json"))
            for record in [json.loads(path.read_text(encoding="utf-8"))]
        ]

        molecule = qcel.models.Molecule.from_data(
            "0 1\nO 0 0 0\nH 0 0 0.9572\nH 0.92662721 0 -0.23998721\nunits angstrom"
        )
        calculation = qcel.models.AtomicInput(
            molecule=molecule,
            driver="energy",
            model={"method": "hf", "basis": "sto-3g"},
            keywords={"scf_type": "pk", "e_convergence": 1e-8, "d_convergence": 1e-8},
        )
        result = qcng.compute(
            calculation, "psi4", raise_error=True, task_config={"ncores": 1, "memory": 1}
        )
        energy = float(result.return_result)
        assert result.success and -75.1 < energy < -74.8, energy
        report["water_hf_sto3g"] = {"energy_hartree": energy, "success": result.success}
        args.output.with_suffix(".input.json").write_text(calculation.json(), encoding="utf-8")
        args.output.with_suffix(".result.json").write_text(result.json(), encoding="utf-8")
    else:
        import basis_set_exchange as bse
        import numpy as np
        import qcelemental as qcel
        import qcengine as qcng
        from ase.build import bulk
        from ase.calculators.emt import EMT
        from pymatgen.core import Structure
        from pymatgen.io.ase import AseAtomsAdaptor
        from rdkit import Chem

        atoms = bulk("Cu", "fcc", a=3.6)
        atoms.calc = EMT()
        energy = float(atoms.get_potential_energy())
        forces = atoms.get_forces()
        assert -0.1 < energy < 0.1 and np.max(np.abs(forces)) < 1e-8
        structure = AseAtomsAdaptor.get_structure(atoms)
        cif = structure.to(fmt="cif")
        restored = Structure.from_str(cif, fmt="cif")
        assert restored.composition == structure.composition
        assert np.isclose(restored.volume, structure.volume, rtol=1e-8)
        molecule = Chem.MolFromSmiles("O")
        inchi = Chem.MolToInchi(molecule)
        assert Chem.MolFromInchi(inchi) is not None
        assert Chem.MolFromMolBlock(Chem.MolToMolBlock(molecule)) is not None
        sdf_buffer = io.StringIO()
        with Chem.SDWriter(sdf_buffer) as writer:
            writer.write(molecule)
        sdf = sdf_buffer.getvalue()
        loaded = list(Chem.ForwardSDMolSupplier(io.BytesIO(sdf.encode("utf-8"))))
        assert len(loaded) == 1 and loaded[0] is not None
        assert Chem.MolToInchi(loaded[0]) == inchi
        args.output.with_suffix(".sdf").write_text(sdf, encoding="utf-8")
        water = qcel.models.Molecule.from_data("O 0 0 0\nH 0 0 1\nH 1 0 0")
        assert len(water.symbols) == 3
        basis = bse.get_basis("sto-3g", elements=[1, 8])
        assert set(basis["elements"]) == {"1", "8"}
        report["checks"] = {
            "copper_emt_energy_eV_per_atom": energy,
            "max_force_eV_per_angstrom": float(np.max(np.abs(forces))),
            "cif_roundtrip": True,
            "sdf_roundtrip": True,
            "smiles_inchi_molblock": inchi,
            "qcschema": True,
            "sto3g_basis_H_O": True,
            "qcengine_available_programs": sorted(qcng.list_available_programs()),
        }
        args.output.with_suffix(".cif").write_text(cif, encoding="utf-8")
    args.output.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    print(
        json.dumps(
            {k: v for k, v in report.items() if k not in {"distributions", "conda_packages"}},
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
