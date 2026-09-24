"""Water HF/STO-3G worker (pinned profile qcengine.psi4.hf_sto3g.smoke.v1).

Runs in the isolated Psi4 environment through the documented launcher. Reads
the approved geometry and settings, executes one fixed-geometry energy
calculation through QCEngine/Psi4 with one core and 1 GiB requested memory,
and writes the energy as a canonical decimal string in hartree plus the raw
QCSchema records. Self-contained: stdlib + qcelemental + qcengine only.
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

    import psi4
    import qcelemental
    import qcengine

    geometry = request["geometry"]
    molecule = qcelemental.models.Molecule.from_data(
        f"{geometry['charge']} {geometry['multiplicity']}\n"
        + "\n".join(f"{atom[0]} {atom[1]} {atom[2]} {atom[3]}" for atom in geometry["atoms"])
        + "\nunits angstrom"
    )
    calculation = qcelemental.models.AtomicInput(
        molecule=molecule,
        driver="energy",
        model={"method": request["method"], "basis": request["basis"]},
        keywords={
            "scf_type": "pk",
            "e_convergence": 1e-8,
            "d_convergence": 1e-8,
        },
    )
    result = qcengine.compute(
        calculation,
        request["engine"],
        raise_error=True,
        task_config={"ncores": 1, "memory": 1},
    )
    energy = float(result.return_result)
    response = {
        "worker": "psi4_water",
        "energy_hartree": canonical(energy),
        "success": bool(result.success),
        "environment": {
            "python": sys.version.split()[0],
            "packages": {
                "qcelemental": qcelemental.__version__,
                "qcengine": qcengine.__version__,
                "psi4": psi4.__version__,
            },
        },
        "raw_input": calculation.json(),
        "raw_result": result.json(),
    }
    Path(output_path).write_text(json.dumps(response, sort_keys=True), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
