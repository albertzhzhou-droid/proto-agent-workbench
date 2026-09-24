"""Run one host-bound molecular refinement request in the isolated Psi4 runtime."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" if (ROOT / "src").is_dir() else ROOT.parents[1]))

from chem_workbench.refinement_backend import run  # noqa: E402
from chem_workbench.refinement_execution.worker_subject_replay import load_json  # noqa: E402


def main() -> int:
    if len(sys.argv) != 3:
        raise ValueError("INVALID_ARGUMENT: exact input and output paths required")
    input_path, output_path = [Path(value).resolve() for value in sys.argv[1:3]]
    if input_path.parent != output_path.parent or not output_path.is_relative_to(ROOT):
        raise ValueError("INVALID_ARGUMENT: refinement paths outside owned run root")
    if input_path.stat().st_size > 20 * 1024**2 or output_path.exists():
        raise ValueError("INVALID_ARGUMENT: input limit or existing output")
    with input_path.open("rb") as stream:
        raw = stream.read(20 * 1024**2 + 1)
    request = load_json(raw)
    if request.get("version") == "refinement-worker-request/v2":
        from chem_workbench.refinement_execution.worker_entry import run_v2

        report = run_v2(request, input_path=input_path, output_path=output_path, root=ROOT)
        # The lifecycle exclusively retains the result and its failure evidence.
        return 0 if report["runner_outcome"] == "completed" else 1
    result = run(request, output_path, ROOT)
    with output_path.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, sort_keys=True, allow_nan=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
