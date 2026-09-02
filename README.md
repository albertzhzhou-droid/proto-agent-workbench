# Proto Agent Toolchain

> Experimental `0.1.x` software. The Python CLI (`0.1.0`) and Windows
> Workbench (`0.1.2`) are versioned independently. All bundled biological
> records are development fixtures, and every scientific result remains
> human-review-required.

See [`CHANGELOG.md`](CHANGELOG.md) for the reconstructed version history,
retained Stage 16 build, validation boundaries, and retired build lineage.

This repository is a local-first development scaffold for making Proto-like synthetic biology design files usable by AI hosts through a strict tool loop:

1. Edit `.proto` design files.
2. Run `proto-agent check`.
3. Compile to typed JSON IR.
4. Export exchange artifacts.
5. Run a local-first workflow that writes an audit manifest.
6. Build evidence cards and a review packet for human/AI handoff.
7. Let Codex read structured diagnostics and iterate.

The current implementation is intentionally conservative: it uses a tiny Proto-like DSL, a JSON parts library, JSON diagnostics, and toy exporters. It is a development scaffold, not a wet-lab protocol generator.

## Biological Materials Catalogue

The repository keeps the six-record `parts/ecoli_k12_library.json` toy fixture unchanged. A separate materials catalogue defaults to the project sibling `..\Proto CLI Materials` and can be overridden with `PROTO_AGENT_MATERIALS_ROOT`; only a small seed of software-only templates is shipped with the repository/installer. Initialise and inspect it with `proto-agent materials init`, `materials status`, and `materials search`. Source synchronisation always creates an inactive staging snapshot; human activation and rollback are explicit. The active catalogue has a normal SQLite/FTS index plus a physically separate quarantine database and content-addressed compressed sequence objects. Model-facing MCP tools expose only bounded `DESIGN_ELIGIBLE` summaries and eligible materialization; they never expose quarantine or perform sync/activation. See [`docs/materials_library.md`](docs/materials_library.md) for the schema, rights boundaries, import formats, and source policy.

The workbench layer is inspired by public descriptions of Claude Science-style scientific workflows: consolidate fragmented tools, keep execution local, declare connectors explicitly, and preserve an auditable run ledger. See `docs/claude_science_patterns.md`.

## Local Setup

Use Python 3.10+.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .
python -B -m unittest discover -s tests -p "test_*.py"
```

Python must be available on `PATH`, or supplied explicitly by the local host that runs the toolchain.

## Quick Start

```powershell
proto-agent parts search promoter --chassis ecoli_k12
proto-agent check designs\toggle_switch.proto --json
proto-agent compile designs\toggle_switch.proto --out build\toggle_switch.ir.json
proto-agent connectors check
proto-agent workflow run designs\toggle_switch.proto
proto-agent review run designs\toggle_switch.proto
proto-agent mcp --once-file examples\mcp\tools_list.request.json
```

The fixture-only path above is local and deterministic. Materials snapshots,
live literature connectors, GGUF inference, and code-execution adapters have
separate configuration and approval boundaries; see the linked documentation
before enabling them. Unsafe host execution is intentionally not part of the
quick start.

Without installing:

```powershell
$env:PYTHONPATH="src"
python -m proto_agent.cli check designs\toggle_switch.proto --json
```

## Proto-like DSL

```proto
design toggle_switch_v1 chassis ecoli_k12

construct repressor_a_unit:
  promoter pLac
  rbs B0034
  cds tetR
  terminator B0015

constraint avoid_restriction_site enzyme=BsaI
constraint gc_content min=0.35 max=0.65
```

Each construct may declare exactly one `topology linear` or `topology circular`
line inside its block. If the line is omitted, the AST and compiled IR retain
`topology: "unknown"`; `unknown` is not an explicit DSL value. Unsupported,
malformed, duplicate, or out-of-block topology declarations fail closed with
structured diagnostics.

## Future Hardening

- Replace the tiny Proto-like parser with the real Proto grammar when available.
- Validate SBOL exports with `pySBOL3` / `SBOL-utilities` before making interoperability claims.
- Replace reviewable sequence optimization suggestions with a full DNA Chisel-backed optimizer when that dependency is available and reviewed.
- Add benchmark tasks for Codex/GPT design iteration quality.

## Workbench Layer

The local workbench has three parts:

- `connectors/proto_workbench.json` declares available integrations such as the Proto DSL, local parts library, PubMed, Jupyter-lite, optional R runtime, SBOL, and DNA Chisel-style sequence optimization.
- `literature/seed_sources.json` stores local source notes for auditable design rationale.
- `proto-agent literature pubmed` searches PubMed through NCBI E-utilities and caches metadata under `build/cache/pubmed`.
- `certifi` is used for TLS verification when available. A custom CA must be passed as a bounded workspace-relative `--cafile <cert.pem>` on the direct CLI; MCP requests cannot select CA or cache paths.
- `workflows/design_review.json` defines the current local-first review loop.
- `proto-agent workflow run <design.proto>` executes check, compile, score, export, and writes a manifest under `build/runs/`.
- Every workflow run also writes a SHA-256 provenance statement. Paths in public results are workspace-relative rather than host-absolute.
- `proto-agent review run <design.proto>` verifies the workflow provenance before consuming it, then builds evidence cards, a Markdown packet, a checklist, and a second provenance statement under `build/reviews/`.
- `proto-agent provenance create|verify|compare` exposes the bounded provenance ledger to people and automation; `proto_provenance_verify` exposes read-only verification through MCP.
- `proto-agent security stress` runs only the pinned offline parser/path/schema corpus. A source checkout defaults to `tests/security_corpus`; installed or packaged callers must pass `--corpus-dir` for an explicitly reviewed copy because the corpus is not bundled. The harness starts no child process, opens no socket, restores the caller environment, and writes an optional bounded report only under `build/`.
- `proto-agent sequence validate <design.proto>` checks assembled constructs against local sequence constraints before export.
- `proto-agent sequence optimize <design.proto>` generates reviewable sequence optimization suggestions and detects a DNA Chisel backend when installed.
- `proto-agent sbol validate <design.ttl>` checks local minimal SBOL3 Turtle structure.
- Python, notebook, and R execution is denied by default. Configure Docker/Podman with a digest-pinned image for the isolated path; direct CLI users may explicitly choose `--unsafe-host-execution` for a trusted fixture, which is recorded as non-sandboxed and is never available through MCP/Desktop.
- `proto-agent analysis run <script.py> ...` writes a bounded manifest under `build/analysis/` only when an allowed execution mode is active.
- `proto-agent notebook run <notebook.ipynb>` validates notebook and cell limits before using the same broker under `build/notebooks/`.
- `proto-agent r status` reports host discovery separately from sandbox readiness; R execution uses `--vanilla`.
- `proto-agent mcp` exposes the same capabilities to MCP-compatible hosts. See `docs/mcp_usage.md`.
- MCP scientific connectors default to offline/cache-only access. A live desktop
  call requires an exact per-call approval and a short-lived, argument-bound,
  one-time capability issued by the trusted main process; there is no
  sidecar-wide network-enable switch.

### Workbench development

Proto Workbench targets Windows and is currently verified with Node.js 24 and
pnpm 11.19.0.

```powershell
Set-Location apps\proto-workbench
pnpm install --frozen-lockfile
node scripts\verify-offline.mjs
pnpm dev:desktop
```

The offline verifier applies Node-level DNS/socket guards and deterministic
fixtures; it is not an operating-system network-isolation claim. Packaging,
real-model inference, and live connector checks are separate release gates.

Example:

```powershell
proto-agent workflow run designs\toggle_switch.proto
proto-agent review run designs\toggle_switch.proto
```

The output includes workspace-relative `manifest_path` and `provenance_path` fields. The manifest records inputs, steps, diagnostics, artifacts, score, metrics, and `review_status: human_review_required`.
The review packet adds `evidence.cards.json`, `review_packet.md`, and `human_review_checklist.md` so a human reviewer or AI host can see which claims are supported, failed, or still need review.

See `docs/security_architecture.md` for the trust boundaries and `docs/security_stress.md` for the deliberately limited stress model.

## Safety Boundary

This repository can validate software structure and produce development artifacts. It does not certify wet-lab readiness, orderability, biosafety, or regulatory compliance. All current sequences are toy fixtures.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the required validation loop,
generated-file policy, and safety boundaries.

## License

No project license has been selected yet. Until a `LICENSE` file is added,
public visibility does not grant permission to copy, modify, or redistribute
this code.
