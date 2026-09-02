# Contributing

Proto Agent Toolchain is experimental `0.1.x` software. Contributions should
preserve its local-first, fail-closed, and human-review-required boundaries.

## Development setup

Python CLI:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .
python -B -m unittest discover -s tests -p "test_*.py"
```

Windows Workbench:

```powershell
Set-Location apps\proto-workbench
pnpm install --frozen-lockfile
node scripts\verify-offline.mjs
```

The Workbench currently targets Node.js 24 and pnpm 11.19.0. The offline
verifier installs Node-level network guards; it is not an OS-isolation claim.

## Design changes

Never invent biological part identifiers. Search and materialize an eligible
selection before referencing parts. After every `.proto` edit:

```powershell
proto-agent check <file> --json
proto-agent compile <file> --out build\<name>.ir.json
```

For end-to-end evidence, use `proto-agent workflow run <file>` followed by
`proto-agent review run <file>`. Generated artifacts belong under `build/` and
must not be committed.

Bundled parts and sequences are software-development fixtures. Contributions
must not add wet-lab execution instructions or imply orderability, biosafety,
regulatory approval, clinical use, or experimental readiness.

## Pull requests

- Keep changes focused and explain the trust boundary they affect.
- Include the exact validation commands and results.
- Do not commit model weights, dynamic material snapshots, raw quarantine data,
  runtime binaries, installers, caches, databases, logs, or local QA captures.
  The only database exception is a deterministic bundle under
  `materials/bundles/` produced by `tools/export_public_materials.py`; it must
  pass bundle verification, rights checks, privacy scanning, and the fixed-size
  review gate before inclusion.
- Keep fixture/cache validation distinct from live connector verification.
- Report suspected vulnerabilities through the private process in
  [`SECURITY.md`](SECURITY.md), not a public issue.

## Licensing

The project software is licensed under the [MIT License](LICENSE). By
submitting a software contribution, you agree that it may be distributed under
that license. Third-party biological records retain their per-record licenses;
MIT does not relicense data in `materials/bundles/`.
