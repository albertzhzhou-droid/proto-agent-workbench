"""Build a locked, immutable Windows desktop preview using an explicit Electron runtime."""

from __future__ import annotations

import argparse
import hashlib
import json
import msvcrt
import shutil
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--electron", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--psi4", type=Path, required=True)
    args = parser.parse_args()
    if not (args.electron / "electron.exe").is_file() or not args.python.is_file() or not (args.psi4 / "python.exe").is_file():
        raise SystemExit("Explicit installed Electron, Python and Psi4 paths are required")
    build = ROOT / "build"
    build.mkdir(exist_ok=True)
    with (build / "desktop-package.lock").open("a+b") as lock:
        lock.write(b"0"); lock.flush(); lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        try:
            stage = build / ("desktop-" + uuid.uuid4().hex)
            shutil.copytree(args.electron, stage)
            (stage / "electron.exe").rename(stage / "ChemWorkbench.exe")
            workspace = stage / "workspace"
            source_paths = []
            for folder in ("src", "scripts", "schemas", "examples", "desktop", "third_party", "docs", "evaluations"):
                base = ROOT / folder
                if base.exists():
                    source_paths.extend(p for p in base.rglob("*") if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc")
            source_paths.extend(ROOT / name for name in ("README.md", "LICENSE", "pyproject.toml", "uv.lock"))
            before = {str(p): digest(p) for p in source_paths}
            for path in source_paths:
                destination = workspace / path.relative_to(ROOT)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, destination)
            if any(digest(p) != before[str(p)] for p in source_paths):
                raise RuntimeError("SOURCE_CHANGED_DURING_STAGING: package rejected")
            app = stage / "resources/app"
            app.mkdir(exist_ok=True)
            for name in ("main.cjs", "package.json"):
                shutil.copyfile(workspace / "desktop" / name, app / name)
            (app / "runtime.json").write_text(json.dumps({"workspace": "../../workspace", "python": str(args.python.resolve()), "psi4": str(args.psi4.resolve())}, indent=2)+"\n")
            entries = {p.relative_to(stage).as_posix(): digest(p) for p in stage.rglob("*") if p.is_file()}
            manifest = {"version": "desktop-preview-manifest/v1", "electron_version": (args.electron / "version").read_text().strip(), "files": entries,
                        "profile": "Windows local desktop preview; explicitly configured existing scientific runtimes, no bundled weights or scientific backends"}
            (stage / "release-manifest.json").write_text(json.dumps(manifest, indent=2)+"\n")
            for name, expected in entries.items():
                if digest(stage / name) != expected:
                    raise RuntimeError("STAGING_INTEGRITY_FAILED")
            (build / "desktop-latest.json").write_text(json.dumps({"directory": str(stage), "executable": str(stage / "ChemWorkbench.exe")}, indent=2)+"\n")
            print(stage, flush=True)
        finally:
            lock.seek(0); msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


if __name__ == "__main__":
    main()
