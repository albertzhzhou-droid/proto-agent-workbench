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
| Reviewed captures in `docs/assets/workbench-0.2.0/` and `docs/assets/workbench-2026-09/`, with separate dated manifests | Raw screenshots, model conversations, receipt databases, process/profile records and recovery copies |
| Frozen Chem source snapshot, integration sources and hash-bound evaluation inputs | Generated `runtime/chem-ui/` overlays and raw evaluation outputs |
| OFL font assets, license notices and separate local-font provenance | User-supplied Anthropic OTF files without redistribution permission |
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

The demo captures are unchanged copies of actual application screenshots. Their
visible contents and image metadata were checked before inclusion. Local evidence
paths, user profiles, process identities and raw model output are excluded from
the public summary. See the [current gallery](assets/workbench-2026-09/README.md),
[source evidence](source-showcase-2026-09.md) and
[historical package verification](upgrade-verification.md). Browser screenshots,
synthetic studies and native package checks keep separate scope labels.

Git attributes preserve original bytes for the sealed Chem snapshot and
digest-bound fixtures. Their checksums must not be silently regenerated to hide
newline conversion. Machine-local `.claude/`, sandbox and extension-trust state
remain ignored. Public screenshot copies use extensions matching the actual
encoded format; extension correction does not alter their image bytes.

Installer binaries remain excluded from Git history. A separately authorized
[v0.2.0-rc.1 prerelease](https://github.com/albertzhzhou-droid/proto-agent-workbench/releases/tag/v0.2.0-rc.1)
distributes the exact validated unsigned Portable and Setup as Release assets,
with SHA-256 checksums and a path-free evidence summary. Distribution does not
establish installation, upgrade, uninstallation or Windows reputation acceptance.
