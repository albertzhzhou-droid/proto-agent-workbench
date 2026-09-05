"""Extract the official full 7-Zip decoder without invoking MSI installation.

Uses read-only Windows Installer database/stream APIs, then the existing limited
7za's CAB decoder. All outputs are new files in a repository build/tools child.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import pathlib
import subprocess
import urllib.request
from datetime import datetime, timezone

VERSION = "26.03"
API_URL = f"https://api.github.com/repos/ip7z/7zip/releases/tags/{VERSION}"
ASSET = "7z2603-x64.msi"


def digest(path: pathlib.Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bootstrap-7za", required=True, type=pathlib.Path)
    parser.add_argument("--out", required=True, type=pathlib.Path)
    args = parser.parse_args()
    repository = pathlib.Path(__file__).resolve().parents[3]
    out = args.out.resolve()
    allowed = (repository / "build" / "tools").resolve()
    if not out.is_relative_to(allowed) or out == allowed:
        raise ValueError("Verifier output must be a new repository build/tools child.")
    out.mkdir(parents=True, exist_ok=False)
    with urllib.request.urlopen(API_URL, timeout=30) as response:
        metadata_bytes = response.read(2 * 1024 * 1024)
    metadata = json.loads(metadata_bytes)
    asset = next(asset for asset in metadata["assets"] if asset["name"] == ASSET)
    expected = asset.get("digest", "")
    if not expected.startswith("sha256:") or len(expected) != 71:
        raise ValueError("Official release metadata has no SHA-256 asset digest.")
    url = asset["browser_download_url"]
    if url != f"https://github.com/ip7z/7zip/releases/download/{VERSION}/{ASSET}":
        raise ValueError("Unexpected official asset URL.")
    with urllib.request.urlopen(url, timeout=30) as response:
        payload = response.read(16 * 1024 * 1024 + 1)
    if len(payload) != asset["size"] or hashlib.sha256(payload).hexdigest() != expected[7:]:
        raise ValueError("Downloaded MSI differs from the published release asset digest/size.")
    package = out / ASSET
    package.write_bytes(payload)
    (out / "official-release.json").write_bytes(metadata_bytes)

    # No MsiInstallProduct, msiexec, custom actions, registry or system install.
    msi = ctypes.WinDLL("msi", use_last_error=True)
    handle = ctypes.c_uint
    msi.MsiOpenDatabaseW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.POINTER(handle)]
    msi.MsiDatabaseOpenViewW.argtypes = [handle, ctypes.c_wchar_p, ctypes.POINTER(handle)]
    msi.MsiViewExecute.argtypes = [handle, handle]
    msi.MsiViewFetch.argtypes = [handle, ctypes.POINTER(handle)]
    msi.MsiRecordGetStringW.argtypes = [handle, ctypes.c_uint, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_uint)]
    msi.MsiRecordReadStream.argtypes = [handle, ctypes.c_uint, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint)]
    msi.MsiCloseHandle.argtypes = [handle]
    handles: list[handle] = []

    def checked(result: int) -> None:
        if result != 0:
            raise OSError(f"Read-only MSI database API failed: {result}")

    def rows(database: handle, query: str):
        view = handle()
        checked(msi.MsiDatabaseOpenViewW(database, query, ctypes.byref(view)))
        handles.append(view)
        checked(msi.MsiViewExecute(view, 0))
        while True:
            record = handle()
            code = msi.MsiViewFetch(view, ctypes.byref(record))
            if code == 259:
                return
            checked(code)
            handles.append(record)
            yield record

    def string(record: handle, field: int) -> str:
        size = ctypes.c_uint(32768)
        buffer = ctypes.create_unicode_buffer(size.value)
        checked(msi.MsiRecordGetStringW(record, field, buffer, ctypes.byref(size)))
        return buffer.value

    database = handle()
    checked(msi.MsiOpenDatabaseW(str(package), None, ctypes.byref(database)))
    handles.append(database)
    try:
        cabinets = [string(record, 1) for record in rows(database, "SELECT `Cabinet` FROM `Media`")]
        if len(cabinets) != 1 or not cabinets[0].startswith("#"):
            raise ValueError("Expected one embedded CAB in the official MSI.")
        stream = cabinets[0][1:]
        if not stream or any(character in stream for character in "'\\/:"):
            raise ValueError("Unsupported cabinet stream name.")
        records = list(rows(database, f"SELECT `Data` FROM `_Streams` WHERE `Name`='{stream}'"))
        if len(records) != 1:
            raise ValueError("Embedded CAB stream is not unique.")
        cabinet = out / "payload.cab"
        with cabinet.open("xb") as target:
            while True:
                size = ctypes.c_uint(32768)
                buffer = ctypes.create_string_buffer(size.value)
                checked(msi.MsiRecordReadStream(records[0], 1, buffer, ctypes.byref(size)))
                if not size.value:
                    break
                target.write(buffer.raw[:size.value])
                if target.tell() > 16 * 1024 * 1024:
                    raise ValueError("MSI cabinet exceeds extraction bounds.")
        file_map = {string(record, 1): string(record, 2).split("|")[-1] for record in rows(database, "SELECT `File`, `FileName` FROM `File`")}
    finally:
        for opened in reversed(handles):
            msi.MsiCloseHandle(opened)

    selected = {key: name for key, name in file_map.items() if name.lower() in {"7z.exe", "7z.dll", "license.txt", "readme.txt"}}
    if set(name.lower() for name in selected.values()) != {"7z.exe", "7z.dll", "license.txt", "readme.txt"}:
        raise ValueError("Official MSI does not contain the expected decoder and notices.")
    if any(any(character in key for character in "\\/:*") or key in {".", ".."} for key in selected):
        raise ValueError("Unsupported MSI file identifier.")
    extracted = out / "cab-files"
    extracted.mkdir()
    result = subprocess.run([str(args.bootstrap_7za.resolve()), "e", "-y", "-bd", f"-o{extracted}", str(cabinet), *selected],
                            check=True, capture_output=True, text=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
    (out / "cab-extraction.log").write_text(result.stdout + result.stderr, encoding="utf-8")
    binary = out / "bin"
    binary.mkdir()
    for key, name in selected.items():
        (binary / name).write_bytes((extracted / key).read_bytes())
    inventory = subprocess.run([str(binary / "7z.exe"), "i"], check=True, capture_output=True, text=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)
    if "Nsis" not in inventory.stdout:
        raise ValueError("Extracted decoder does not expose NSIS support.")
    (out / "formats.txt").write_text(inventory.stdout, encoding="utf-8")
    report = {"schemaVersion": "proto-workbench.archive-tool.v1", "version": VERSION,
              "createdAt": datetime.now(timezone.utc).isoformat(), "officialDownloadPage": "https://www.7-zip.org/download.html",
              "metadataUrl": API_URL, "downloadUrl": url, "publishedSha256": expected[7:], "downloadSha256": digest(package),
              "publishedDigestVerified": True, "systemInstall": False, "extraction": "read-only MSI database streams and CAB decoding; no installer execution",
              "files": [{"path": str(path), "sha256": digest(path)} for path in sorted(binary.iterdir())]}
    (out / "archive-tool.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
