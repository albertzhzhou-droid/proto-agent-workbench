# Windows desktop preview

The local preview uses Electron 43.4.0 with a sandboxed renderer, context
isolation, no Node integration, denied permission requests and a loopback-only
Python service. The interface is English and includes live 3D coordinates.

Build from the configured development environment:

```powershell
.venv/Scripts/python.exe scripts/package_desktop.py --electron <electron-dist> --python .venv/Scripts/python.exe --psi4 .chem-backends/psi4
$preview = Get-Content build/desktop-latest.json | ConvertFrom-Json
Start-Process -FilePath $preview.executable -WindowStyle Hidden
```

Each build uses a process lock and a new staging directory, checks source
stability while copying, then verifies every staged file against its manifest.
Do not modify a stage to update the application: build a new one. Project
records and logs live in that stage's `workspace/build/` directory.

This is a configured local preview, not a portable installer. `runtime.json`
explicitly references existing Python and Psi4 environments. They must remain
installed at those paths. LM Studio must separately serve the selected Gemma
4 E4B model on `127.0.0.1:1234` for model proposals; direct calculations do not
require a model. No model weights or scientific environments are bundled.

For acceptance, prepare a bundled copper example, inspect the resolved plan,
approve, then run. Save a project revision and reopen it. Select the water
example, compile it, choose the water profile and inspect the explicit fixture
coordinates before preparing and approving. Results and their input identities
can be exported as JSON. Imported or constructed structures remain geometries;
the UI does not claim every structure has an admitted calculator.

Desktop downloads are saved under the stage's `workspace/build/exports/`
with unique filenames. Browser-mode downloads use the browser's download flow.

The trusted local operating-system user controls the file store. Job Objects
enforce bounded worker lifetime and resources; they are not a network or
filesystem sandbox. This preview does not claim multi-user server isolation.
