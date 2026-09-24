"""One approved organic RHF/STO-3G fixed-geometry calculation, with honest failure records."""

from __future__ import annotations

import hashlib
import json
import sys
from decimal import Decimal
from pathlib import Path


def digest(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def canonical(value: object) -> str:
    decimal = Decimal(str(value))
    if not decimal.is_finite():
        raise ValueError("Non-finite energy is not an accepted result")
    rendered = format(decimal.normalize(), "f")
    return rendered.rstrip("0").rstrip(".") if "." in rendered else rendered


def main() -> int:
    input_path, output_path = map(Path, sys.argv[1:3])
    request = json.loads(input_path.read_text(encoding="utf-8"))

    import psi4
    import qcelemental
    import qcengine

    geometry = request["geometry"]
    factor = float(request["angstrom_to_bohr"])
    molecule = qcelemental.models.Molecule(
        symbols=[a[0] for a in geometry["atoms"]],
        geometry=[float(c) * factor for a in geometry["atoms"] for c in a[1:]],
        molecular_charge=geometry["charge"],
        molecular_multiplicity=geometry["multiplicity"],
        fix_com=True,
        fix_orientation=True,
    )
    calculation = qcelemental.models.AtomicInput(
        molecule=molecule,
        driver="energy",
        model={"method": request["method"], "basis": request["basis"]},
        keywords=request["scf_settings"],
    )
    result = qcengine.compute(
        calculation, "psi4", raise_error=False, task_config={"ncores": 1, "memory": 1}
    )
    succeeded = result.success is True
    error = getattr(result, "error", None)
    error_type = str(getattr(error, "error_type", "backend_error"))
    error_message = str(getattr(error, "error_message", ""))[:2000]
    response = {
        "worker": "psi4_molecular",
        "input_binding_hash": digest(request),
        "geometry_hash": digest(geometry),
        "success": succeeded,
        "convergence": "converged"
        if succeeded
        else ("not_converged" if "converg" in error_type.lower() else "failed"),
        "energy_hartree": canonical(result.return_result) if succeeded else None,
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
        "error": None if succeeded else {"type": error_type, "message": error_message},
    }
    output_path.write_text(json.dumps(response, sort_keys=True, allow_nan=False), encoding="utf-8")
    return 0  # A valid failure record is a completed worker, not a successful calculation.


if __name__ == "__main__":
    raise SystemExit(main())
