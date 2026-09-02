# Release checklist

This checklist separates a source publication from a Windows binary release.
Passing the source gates does not validate installers, real-model inference,
live connectors, or scientific readiness.

## Source publication

1. Confirm that the MIT license is present and consistently declared in
   `LICENSE`, `pyproject.toml`, `apps/proto-workbench/package.json`, and the
   README.
2. Run the Python and Workbench baselines:

   ```powershell
   .\.venv\Scripts\python.exe -B -m unittest discover -s tests -p "test_*.py" -q
   Set-Location apps\proto-workbench
   node scripts\verify-offline.mjs
   pnpm build:desktop
   ```

3. Review `git status --short`, the complete staged file list, and every staged
   file above 10 MiB. Confirm that no credential, user-specific path, material
   snapshot, quarantine record, model catalogue, or generated QA artifact is
   present.
4. Confirm that the sibling `..\\Proto CLI Materials` catalogue, `node_modules`,
   root `releases/`, Workbench `release*`, staged runtimes, sidecars, and local
   databases remain ignored.
5. Record skipped checks and unverified integrations without converting them
   into success claims.

## Windows binaries

Before attaching an installer or portable executable to a release, separately:

- build the sidecars and stage the reviewed, checksum-pinned llama.cpp runtime;
- run desktop build, packaging, packaged UI, and owned-process verification on
  fresh state roots;
- generate complete third-party notices for Python/PyInstaller, Electron/Node,
  llama.cpp, and any CUDA redistributables;
- review transitive dependency advisories and deprecation warnings;
- identify unsigned artifacts explicitly and never treat a digest as publisher
  identity.

Binary artifacts are release attachments, not Git source files.
