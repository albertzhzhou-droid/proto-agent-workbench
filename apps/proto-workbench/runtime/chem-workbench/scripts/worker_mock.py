"""Mock governed-execution worker. Fabricated numbers; never scientific evidence.

Reads {input_path} JSON, optionally sleeps, and writes bounded marker output.
The host records mock outputs with evidence_eligible=false by construction.
"""

from __future__ import annotations

import json
import sys
import time


def main() -> int:
    input_path, output_path = sys.argv[1], sys.argv[2]
    with open(input_path, encoding="utf-8") as stream:
        request = json.load(stream)
    time.sleep(float(request.get("sleep_seconds", 0)))
    response = {
        "worker": "mock",
        "marker": request.get("marker", "mock"),
        "values": {"energy": "-1.5"},
        "convergence": "success",
        "environment": {"python": sys.version.split()[0], "packages": []},
    }
    with open(output_path, "w", encoding="utf-8") as stream:
        json.dump(response, stream, sort_keys=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
