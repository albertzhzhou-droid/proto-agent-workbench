from __future__ import annotations

import json
import sys
from typing import Any


_RETIRED = {
    "ok": False,
    "code": "LEGACY_WORKBENCH_SIDECAR_RETIRED",
    "message": (
        "This compatibility entry is permanently retired and cannot inspect or load models. "
        "Proto Workbench uses the operator-managed LM Studio API exclusively."
    ),
    "replacement": {
        "provider": "lmstudio",
        "endpoint": "http://127.0.0.1:1234",
        "documentation": "apps/proto-workbench/README.md",
        "verifier": "apps/proto-workbench/scripts/verify-inference.mjs",
    },
}


def main(argv: list[str] | None = None) -> int:
    """Fail closed without parsing, reading, or echoing legacy arguments."""

    del argv
    _write_json(_RETIRED, stream=sys.stderr)
    return 2


def _write_json(payload: dict[str, Any], *, stream: Any) -> None:
    print(json.dumps(payload, separators=(",", ":"), ensure_ascii=True), file=stream, flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
