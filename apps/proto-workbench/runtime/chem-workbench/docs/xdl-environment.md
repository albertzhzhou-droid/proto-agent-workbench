# Standalone XDL environment

Installed and checked on 2026-09-05 after the user's explicit request to add XDL.
This is Cronin Group's chemical description language, installed from its
[official repository](https://gitlab.com/croningroup/chemputer/xdl), following
the upstream [source-installation route](https://croningroup.gitlab.io/chemputer/xdl/install.html).

- XDL version: `2.1.0`.
- Official tag commit: `6d60e8da7218a589b9c8715a239956601b17cd07`.
- Interpreter: CPython `3.13.3` on Windows.
- Environment: `.chem-backends/xdl` (ignored by Git).
- Exact dependency pins: `xdl-requirements.lock.txt`.
- Input requirements: `xdl-requirements.in`.

## Use and reproduce

From the project root in PowerShell:

```powershell
.\.chem-backends\xdl\Scripts\python.exe scripts\verify_xdl_environment.py
.\.chem-backends\xdl\Scripts\python.exe -c "import xdl; print(xdl.__version__)"
```

To reconstruct the environment:

```powershell
uv venv .chem-backends\xdl --python .venv\Scripts\python.exe --cache-dir build\uv-cache
uv pip sync docs\xdl-requirements.lock.txt --python .chem-backends\xdl\Scripts\python.exe --cache-dir build\uv-cache
```

Add `--offline` to the sync command when the cached artifacts are available.
The offline sync was verified successfully after installation.

For file inspection, supply the built-in placeholder platform explicitly:

```python
from xdl import XDL
from xdl.platforms import PlaceholderPlatform

document = XDL("procedure.xdl", platform=PlaceholderPlatform)
document.save("procedure-copy.xdl")
```

## Verified scope

The check imports the real package, parses a one-step `Wait` fixture, exports
XML and JSON, and reopens both outputs with `PlaceholderPlatform`. It verifies
that the step and its time survive both round trips and that the document
remains uncompiled. It does not execute the step.

All these checks passed. All 14 installed distributions also passed
`uv pip check`. Evidence, input/output files, file hashes, the installed commit,
and the version inventory are saved under `build/xdl-environment/`.

XDL pins `python-socketio==4.6.0`, whose permissive dependency range otherwise
selected Engine.IO 4.x. The installation explicitly constrains Engine.IO to
3.x, as required by the upstream
[protocol compatibility table](https://python-socketio.readthedocs.io/en/latest/intro.html#version-compatibility).
The installed pair is Socket.IO `4.6.0` and Engine.IO `3.14.2`. Constructing a
threading-mode server object passed without opening a listening socket.
Network transports and remote controllers were not exercised.

## Project and licensing boundary

The main Workbench package and its adapter registry do not import this
environment. This installation adds a local inspection tool; it does not
complete M10 or enable a laboratory controller, compilation backend, or
device execution. Chemputer-specific extras were not installed.

The upstream `LICENSE.txt`, `COPYING.txt`, and `NOTICE.txt` were inspected.
They contain AGPL-related and additional distribution/commercial terms. Their
original copies remain in the installed distribution. This record is an
installation inventory, not a formal decision about linking or redistributing
XDL with Chem Workbench. The plan's separate integration/distribution review
remains outstanding.

Pinned source notices:

- [LICENSE.txt](https://gitlab.com/croningroup/chemputer/xdl/-/blob/6d60e8da7218a589b9c8715a239956601b17cd07/LICENSE.txt)
- [COPYING.txt](https://gitlab.com/croningroup/chemputer/xdl/-/blob/6d60e8da7218a589b9c8715a239956601b17cd07/COPYING.txt)
- [NOTICE.txt](https://gitlab.com/croningroup/chemputer/xdl/-/blob/6d60e8da7218a589b9c8715a239956601b17cd07/NOTICE.txt)
