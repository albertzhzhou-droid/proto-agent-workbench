from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from proto_agent.compiler import compile_design
from proto_agent.sequence import validate_sequences


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: summarize_design.py <design.proto>", file=sys.stderr)
        return 2

    design_path = sys.argv[1]
    run_dir = Path(os.environ["PROTO_AGENT_RUN_DIR"])
    ir, diagnostics = compile_design(design_path)
    sequence_report, sequence_diagnostics = validate_sequences(design_path)
    all_diagnostics = [item.to_dict() for item in diagnostics + sequence_diagnostics]

    payload = {
        "design": design_path,
        "ok": ir is not None and sequence_report["ok"] and not any(item["severity"] == "error" for item in all_diagnostics),
        "design_id": ir.get("design_id") if ir else None,
        "chassis": ir.get("chassis") if ir else None,
        "construct_count": len(ir.get("constructs", [])) if ir else 0,
        "sequence_validation": sequence_report,
        "diagnostics": all_diagnostics,
    }
    (run_dir / "summary.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    lines = [
        f"# Design Summary: {payload['design_id'] or design_path}",
        "",
        f"- OK: {payload['ok']}",
        f"- Chassis: {payload['chassis']}",
        f"- Constructs: {payload['construct_count']}",
        f"- Sequence validation: {sequence_report['summary']}",
    ]
    (run_dir / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps(payload, indent=2))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
