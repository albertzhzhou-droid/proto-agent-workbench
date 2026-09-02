from __future__ import annotations

import argparse
import json
from typing import Any

from .model_catalog import scan_model_root


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="proto-workbench-sidecar")
    subparsers = parser.add_subparsers(dest="command", required=True)
    scan_parser = subparsers.add_parser("scan-models")
    scan_parser.add_argument("root")
    scan_parser.add_argument("--cache")
    args = parser.parse_args(argv)

    if args.command == "scan-models":
        _write_json({"ok": True, "models": scan_model_root(args.root, args.cache)})
        return 0
    return 2


def _write_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":"), ensure_ascii=True), flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
