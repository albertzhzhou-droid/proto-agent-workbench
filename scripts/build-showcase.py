"""Build the offline presentation bundle from explicitly reviewed public files.

Run from any directory: python scripts/build-showcase.py
Writes only build/showcase-2026-09/, its ZIP, and its verification receipt.
Existing outputs are never overwritten or removed. No runtime is executed.
"""
from __future__ import annotations

import hashlib
import html
import json
from pathlib import Path, PurePosixPath
import sys
from urllib.parse import quote
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
NAME = "showcase-2026-09"
GALLERY = "docs/assets/workbench-2026-09"
FONTS = "apps/proto-workbench/src/renderer/assets/fonts/public"
DOCUMENTS = ("README.md", "docs/source-showcase-2026-09.md", "docs/typography.md", "docs/release-evidence/source-2026-09-23.json")
IMAGES = {"compute.jpg", "chat.jpg", "chem-reaction.jpg", "research-project.jpg", "protein-study.jpg"}
FONT_FILES = {
    "newsreader/Newsreader[opsz,wght].woff2",
    "newsreader/Newsreader-Italic[opsz,wght].woff2",
    "newsreader/OFL.txt",
    "hanken-grotesk/HankenGrotesk[wght].woff2",
    "hanken-grotesk/HankenGrotesk-Italic[wght].woff2",
    "hanken-grotesk/OFL.txt",
    "commit-mono/CommitMonoV143-VF.woff2",
    "commit-mono/LICENSE-FONT",
}
PR = "https://github.com/albertzhzhou-droid/proto-agent-workbench/pull/4"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def source_bytes(name: str) -> bytes:
    """Resolve allowlisted inputs without following redirected source paths."""
    path = ROOT / name
    if path.resolve().relative_to(ROOT).as_posix() != name:
        raise ValueError(f"Redirected showcase input: {name}")
    for item in (path, *path.parents):
        if item == ROOT:
            break
        if item.is_symlink() or getattr(item, "is_junction", lambda: False)():
            raise ValueError(f"Linked showcase input: {name}")
    return path.read_bytes()


def verified_records(manifest: dict, expected: set[str], directory: str) -> dict[str, bytes]:
    records = manifest.get("files")
    if not isinstance(records, list) or any(not isinstance(item, dict) for item in records):
        raise ValueError(f"Invalid files array: {directory}")
    names = [item.get("file") for item in records]
    if len(names) != len(expected) or set(names) != expected:
        raise ValueError(f"Manifest must list exactly the reviewed files: {directory}")
    result = {}
    for item in records:
        name = f"{directory}/{item['file']}"
        data = source_bytes(name)
        if item.get("sha256") != sha256(data) or item.get("bytes") != len(data):
            raise ValueError(f"Manifest byte length or SHA-256 mismatch: {name}")
        if item["file"].endswith(".woff2") and data[:4] != b"wOF2":
            raise ValueError(f"Expected original WOFF2 bytes: {name}")
        if item["file"].endswith(".jpg"):
            if item.get("mimeType") != "image/jpeg" or not data.startswith(b"\xff\xd8\xff"):
                raise ValueError(f"Expected JPEG bytes and media type: {name}")
            if not all(isinstance(item.get(key), str) and item[key].strip() for key in ("title", "caption", "captureDate", "surface", "typographyProfile")):
                raise ValueError(f"Missing capture description: {name}")
            if not all(isinstance(item.get(key), int) and item[key] > 0 for key in ("width", "height")):
                raise ValueError(f"Missing capture dimensions: {name}")
        elif item["file"].endswith(("OFL.txt", "LICENSE-FONT")):
            if b"SIL OPEN FONT LICENSE Version 1.1" not in data:
                raise ValueError(f"Missing upstream OFL text: {name}")
        result[name] = data
    return result


def index_html(captures: list[dict]) -> bytes:
    escape = html.escape
    faces = []
    for style, suffix in (("normal", ""), ("italic", "-Italic")):
        for family, filename, weight in (
            ("Newsreader", f"newsreader/Newsreader{suffix}[opsz,wght].woff2", "200 800"),
            ("Hanken Grotesk", f"hanken-grotesk/HankenGrotesk{suffix}[wght].woff2", "100 900"),
            ("Commit Mono", "commit-mono/CommitMonoV143-VF.woff2", "200 700"),
        ):
            url = quote(f"{FONTS}/{filename}", safe="/")
            faces.append(f'@font-face{{font-family:"{family}";src:url("{url}") format("woff2");font-weight:{weight};font-style:{style};font-display:swap}}')
    by_name = {item["file"]: item for item in captures}
    cards = []
    for name in ("compute.jpg", "chat.jpg", "chem-reaction.jpg", "research-project.jpg", "protein-study.jpg"):
        item = by_name[name]
        image = f"{GALLERY}/{name}"
        details = " · ".join(item[key] for key in ("captureDate", "surface", "typographyProfile"))
        cards.append(f'''<figure><a href="{image}"><img src="{image}" alt="{escape(item['title'])}" width="{item['width']}" height="{item['height']}" loading="lazy"></a>
<figcaption><h3>{escape(item['title'])}</h3><p>{escape(item['caption'])}</p><small>{escape(details)}</small></figcaption></figure>''')
    licenses = " · ".join(
        f'<a href="{FONTS}/{file}">{label} OFL</a>'
        for label, file in (("Newsreader", "newsreader/OFL.txt"), ("Hanken Grotesk", "hanken-grotesk/OFL.txt"), ("Commit Mono", "commit-mono/LICENSE-FONT"))
    )
    page = '''<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; font-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Proto Workbench — September 2026 source showcase</title>
<style>__FACES__
:root{color-scheme:light;background:#f5f3ee;color:#252520;font-family:"Hanken Grotesk",sans-serif;font-synthesis:none}
*{box-sizing:border-box}body{margin:0}main{max-width:1200px;margin:auto;padding:56px 32px 40px}
a{color:inherit;text-underline-offset:4px}a:hover{color:#716146}header{max-width:850px;margin-bottom:38px}
.eyebrow,small{font-size:13px;letter-spacing:.025em;color:#68685f}.eyebrow{text-transform:uppercase;letter-spacing:.13em}
h1,h2,h3{font-family:"Newsreader",serif;font-optical-sizing:auto;font-weight:500}h1{font-size:clamp(44px,7vw,76px);line-height:1.02;margin:18px 0}
h2{font-size:34px;margin-top:40px}h3{font-size:25px;margin:0 0 10px}p{font-size:17px;line-height:1.55;margin:12px 0}
.lead{font-size:21px;max-width:720px}.notice{padding:22px 26px;background:#eae7df;border-left:3px solid #7b715e;margin:26px 0}
nav{display:flex;gap:16px;flex-wrap:wrap;font-size:15px}code{font-family:"Commit Mono",monospace;font-size:.88em}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:25px}figure{margin:0;background:#fff;border:1px solid #dfdcd3;border-radius:12px;overflow:hidden}
figure:first-child{grid-column:1/-1}img{display:block;width:100%;height:auto}figcaption{padding:24px}figcaption p{font-size:16px}small{display:block;line-height:1.5}
.limits{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}.limits p{font-size:16px}footer{border-top:1px solid #d8d4c9;margin-top:40px;padding-top:25px}footer p{font-size:14px}
@media(max-width:650px){main{padding:30px 18px}.grid,.limits{grid-template-columns:1fr}figure:first-child{grid-column:auto}.notice{padding:18px}figcaption{padding:18px}}
</style><main>
<header><div class="eyebrow">September 2026 · source showcase</div><h1>Proto Workbench</h1>
<p class="lead">Local AI. Scientific workspaces. Inspectable evidence.</p>
<p>Explore a question, inspect the calculation, and retain sources, results and review decisions across Chat, Design and Compute.</p>
<nav><a href="README.md">Project README</a><a href="docs/source-showcase-2026-09.md">Source and evidence guide</a><a href="docs/typography.md">Typography profiles</a><a href="__PR__">Merged scientific workspace update ↗</a></nav></header>
<aside class="notice"><strong>This is an offline presentation bundle.</strong><p>It contains reviewed documentation, unchanged screenshots and public fonts. It does not install or execute Proto, Chem, model inference or a scientific runtime. The downloadable <code>0.2.0-rc.1</code> preview is an earlier binary; these current source additions have not been delivered as a new installer.</p></aside>
<section aria-labelledby="gallery"><h2 id="gallery">Explore the workspaces</h2><div class="grid">__CARDS__</div>
<p><a href="docs/assets/workbench-2026-09/README.md">Capture context</a> · <a href="docs/assets/workbench-2026-09/manifest.json">Capture manifest</a></p></section>
<section aria-labelledby="limits"><h2 id="limits">What this evidence supports</h2><div class="limits">
<div><h3>Source interface</h3><p>Source-browser captures demonstrate visible behavior at their recorded snapshots. Retained research-study captures use synthetic fixtures and their original local font appearance; they are not screenshots of a new installer.</p></div>
<div><h3>Scoped software checks</h3><p>Local checks, hosted CI, model trials and historical packaged checks have separate scopes. The source guide retains failures, skips, unknown usage and exact revision boundaries. The paired Harness campaign does not establish a completion or token-cost improvement.</p></div>
<div><h3>Scientific review</h3><p>Software success and a plotted result do not establish scientific correctness, experimental readiness or clean-machine runtime acceptance. Chemistry views retain model assumptions; the spatial reaction view is a population schematic, not an atomistic trajectory.</p></div></div></section>
<footer><p>Bundled public typography: Newsreader, Hanken Grotesk and Commit Mono. Original WOFF2 bytes and their upstream licenses are retained. No Anthropic font files, local run databases, raw model output, weights, runtime binaries or installer payloads are included.</p>
<p>__LICENSES__ · <a href="__FONT_MANIFEST__">Font provenance</a> · <a href="inventory.json">SHA-256 inventory</a></p>
<p>Hashes identify file bytes; they do not authenticate authorship or validate scientific results. This page and its gallery work offline. GitHub links require a network connection; Markdown documents remain the original source text.</p></footer></main></html>
'''
    return (page.replace("__FACES__", "\n".join(faces)).replace("__PR__", PR)
            .replace("__CARDS__", "\n".join(cards)).replace("__LICENSES__", licenses)
            .replace("__FONT_MANIFEST__", f"{FONTS}/manifest.json")).encode("utf-8")


def main() -> None:
    payload = {name: source_bytes(name) for name in (*DOCUMENTS, f"{GALLERY}/README.md", f"{GALLERY}/manifest.json", f"{FONTS}/manifest.json")}
    gallery = json.loads(payload[f"{GALLERY}/manifest.json"])
    if gallery.get("schemaVersion") != "proto-workbench.showcase-captures.v1":
        raise ValueError("Unsupported showcase capture manifest schema")
    fonts = json.loads(payload[f"{FONTS}/manifest.json"])
    if fonts.get("schemaVersion") != 1 or fonts.get("fontByteModifications") is not False:
        raise ValueError("Expected original public font manifest")
    payload.update(verified_records(gallery, IMAGES, GALLERY))
    payload.update(verified_records(fonts, FONT_FILES, FONTS))
    payload["index.html"] = index_html(gallery["files"])
    inventory = {"schemaVersion": "proto-workbench.showcase-inventory.v1", "scope": "Offline source presentation; no runtime or installer", "pullRequest": PR,
                 "files": [{"file": name, "bytes": len(data), "sha256": sha256(data)} for name, data in sorted(payload.items())],
                 "selfExclusion": "This inventory lists every other bundle file. Its own bytes are verified during ZIP reopening and bound by the external receipt."}
    payload["inventory.json"] = json_bytes(inventory)

    # Refuse redirected build roots and any existing target; never remove user work.
    build = ROOT / "build"
    if build.resolve() != build or build.is_symlink() or getattr(build, "is_junction", lambda: False)():
        raise ValueError("Showcase output must stay in the repository build directory")
    output, archive, receipt_path = build / NAME, build / f"{NAME}.zip", build / f"{NAME}.receipt.json"
    if any(path.exists() or path.is_symlink() for path in (output, archive, receipt_path)):
        raise ValueError("Showcase output already exists; preserve it and choose a fresh checkout for another build")
    output.mkdir(parents=True)
    for name, data in sorted(payload.items()):
        target = output.joinpath(*PurePosixPath(name).parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        if sha256(target.read_bytes()) != sha256(data):
            raise ValueError(f"Copied output digest mismatch: {name}")
    with ZipFile(archive, "x", ZIP_DEFLATED) as bundle:
        for name, data in sorted(payload.items()):
            bundle.writestr(f"{NAME}/{name}", data)
    with ZipFile(archive) as bundle:
        expected = {f"{NAME}/{name}" for name in payload}
        if len(bundle.namelist()) != len(expected) or set(bundle.namelist()) != expected or bundle.testzip() is not None:
            raise ValueError("Reopened ZIP member or CRC verification failed")
        for name, data in payload.items():
            reopened = bundle.read(f"{NAME}/{name}")
            if len(reopened) != len(data) or sha256(reopened) != sha256(data):
                raise ValueError(f"Reopened ZIP digest mismatch: {name}")
    archive_bytes = archive.read_bytes()
    receipt = {"schemaVersion": "proto-workbench.showcase-receipt.v1", "profile": "public", "index": f"build/{NAME}/index.html",
               "archive": f"build/{NAME}.zip", "archiveBytes": len(archive_bytes), "archiveSha256": sha256(archive_bytes),
               "inventorySha256": sha256(payload["inventory.json"]), "bundleFiles": len(payload), "zipReopenedAndHashVerified": True,
               "containsRuntimeOrInstaller": False, "containsAnthropicFontBytes": False}
    with receipt_path.open("xb") as stream:
        stream.write(json_bytes(receipt))
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Showcase build failed: {error}", file=sys.stderr)
        raise SystemExit(1)
