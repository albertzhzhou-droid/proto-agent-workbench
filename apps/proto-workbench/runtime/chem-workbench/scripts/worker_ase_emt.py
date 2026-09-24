"""ASE/EMT copper cell-scale batch worker (pinned profile ase.emt.cu.scan.v1).

Reads a resolved candidate batch as JSON, computes one EMT single point per
candidate on the scaled cell (fractional coordinates preserved exactly),
and writes energies as canonical decimal strings in eV and eV/atom.
Self-contained on purpose: only stdlib + ase + numpy.
"""

from __future__ import annotations

import json
import sys
from decimal import Decimal
from pathlib import Path


def canonical(value: object) -> str:
    decimal = Decimal(str(value)).normalize()
    rendered = format(decimal, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered or "0"


def main() -> int:
    input_path, output_path = sys.argv[1], sys.argv[2]
    with open(input_path, encoding="utf-8") as stream:
        request = json.load(stream)

    import ase
    import numpy as np
    from ase import Atoms
    from ase.calculators.emt import EMT

    candidates = request["candidates"]
    outcomes = []
    for candidate in candidates:
        vectors = [[float(value) for value in row] for row in candidate["lattice_angstrom"]]
        scaled = np.array(vectors)
        atoms = Atoms(
            symbols=[site["element"] for site in candidate["fractional_sites"]],
            scaled_positions=[
                [float(c) for c in site["coordinates"]] for site in candidate["fractional_sites"]
            ],
            cell=scaled,
            pbc=True,
        )
        atoms.calc = EMT()
        try:
            energy_ev = float(atoms.get_potential_energy())
            per_atom = energy_ev / len(atoms)
            outcomes.append(
                {
                    "candidate_hash": candidate["candidate_hash"],
                    "scale": candidate["scale"],
                    "energy_eV": canonical(energy_ev),
                    "energy_eV_per_atom": canonical(per_atom),
                    "convergence": "converged",
                }
            )
        except Exception as error:
            outcomes.append(
                {
                    "candidate_hash": candidate["candidate_hash"],
                    "scale": candidate["scale"],
                    "convergence": "failed",
                    "error": str(error)[:400],
                }
            )
    response = {
        "worker": "ase_emt",
        "normalization": "eV/atom",
        "outcomes": outcomes,
        "environment": {
            "python": sys.version.split()[0],
            "packages": {"ase": ase.__version__, "numpy": np.__version__},
        },
    }
    Path(output_path).write_text(json.dumps(response, sort_keys=True), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
