# Repository publication boundaries

The upgrade publishes runnable source, tests, dependency locks, documentation,
third-party notices, schemas, reviewed public biological records and the audited
public database bundles. The software MIT license does not replace upstream
biological-data licenses.

| Include in Git | Keep local / ignored |
|---|---|
| Python CLI/MCP and Electron source, tests and build scripts | `build/`, `dist/`, packaged EXEs, ASAR files and extracted payloads |
| Package manifests, lockfiles and dependency notices | `node_modules/`, Python environments and downloaded runtimes |
| Reviewed DNA/protein JSON, promotion audit and source digest ledger | Raw upstream response bodies and resumable iGEM/UniProt crawler state |
| `materials/bundles/public/public-reviewed-2026.09/`: SQLite, records, licensed sequence objects, provenance and checksums | External live `Proto CLI Materials` catalog, active state, local snapshots and caches |
| Separate `materials/bundles/quarantine/public-quarantine-metadata-2026.09/`: sanitized metadata only | Quarantine sequences, administrator state and activation/rollback logs |
| Four explicitly reviewed native screenshots in `docs/assets/workbench-0.2.0/` and a path-free evidence summary | Raw screenshots, model conversations, receipt databases, process/profile records and recovery copies |
| Reusable repository Skills | Local agent/application settings, credentials, tokens and model weights |

Database files are ignored globally, with explicit exceptions for the existing
generator-produced public material databases. The public catalog has 1,066
reviewed records: 1,046 DNA parts and 20 proteins. It is inactive until a separate
human activation. The 1,795 quarantine metadata rows have activation denied and
remain unavailable to model-facing MCP.

Before this push, both bundle profiles passed verification and were independently
rebuilt under an ignored evidence directory for byte comparison. No live external
database was copied into Git. Raw upstream response bodies can include contributor
identity; a digest ledger is published in their place. Verifying and installing
the checked public bundles does not require private crawl inputs.

The demo captures are unchanged copies of actual validation screenshots. Their
visible contents and PNG metadata were checked before inclusion. Local evidence
paths, user profiles, process identities and raw model output are excluded from
the public summary. See [upgrade verification](upgrade-verification.md).

Candidate installers remain local build artifacts. The source push does not
publish a GitHub Release, upload unsigned binaries, or establish installation,
upgrade, uninstallation or Windows reputation acceptance.
