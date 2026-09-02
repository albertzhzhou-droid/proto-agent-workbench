# Architecture Upgrade Research Ledger

This ledger records the public, primary-source material used for the current
upgrade and the concrete decision taken in Proto Agent. It is an engineering
input, not a claim that Proto Agent conforms to every referenced standard.

## Integrated decisions

| Source | Relevant mechanism | Proto Agent decision |
| --- | --- | --- |
| [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security) | Context isolation, renderer sandboxing, restrictive CSP, navigation controls, IPC sender validation, and a narrow preload surface | Treat the renderer as untrusted. Packaged builds load only packaged content; every privileged handler validates the expected window, frame, and origin. |
| [MCP roots](https://modelcontextprotocol.io/specification/2025-06-18/client/roots) | Client-declared filesystem roots and root-change semantics | A main-process-selected canonical workspace is the sole MCP filesystem root. Tool arguments cannot create new host capabilities. |
| [MCP cancellation](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation) and [progress](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress) | Request IDs, cancellation notifications, and bounded progress reporting | Carry deadlines and cancellation from the desktop request to the sidecar operation; reject late results and cap progress/output. |
| [MCP authorization guidance](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) | Authorization is distinct from tool arguments and must be audience/resource scoped | Keep standalone MCP offline. After a user approves one live connector call, the desktop main process issues a short-lived HMAC capability bound to tool, canonical arguments, run, approval, expiry, and one-time nonce; the model cannot mint or replay it. |
| [OCI runtime specification](https://github.com/opencontainers/runtime-spec/blob/main/config.md), [Docker run](https://docs.docker.com/reference/cli/docker/container/run/), and [Podman run](https://docs.podman.io/en/latest/markdown/podman-run.1.html) | Namespaces, read-only filesystems, capability removal, no-new-privileges, network and resource controls | Untrusted code execution fails closed unless an explicitly configured, digest-pinned OCI worker can run with no network, read-only inputs, a dedicated output mount, dropped capabilities, and CPU/memory/PID/time/output limits. |
| [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) | Grouped process accounting and terminate-on-close lifecycle | Use owned-process-tree containment where available. A direct child timeout alone is not considered sufficient isolation. |
| [uv locking and syncing](https://docs.astral.sh/uv/concepts/projects/sync/) | Exact resolution in `uv.lock`, `--locked` verification, and export formats | Check in a generated Python lock, validate it without mutation, and keep optional workbench dependencies explicit. |
| [SLSA provenance](https://slsa.dev/spec/v1.2/provenance) and [in-toto Statement](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md) | Subjects, resolved inputs, digests, invocation identity, and verifiable production records | Add a smaller `proto-agent.provenance.v1` statement that records bounded, root-relative SHA-256 materials and artifacts. It is intentionally unsigned and does not claim SLSA/in-toto conformance. |
| [OpenTelemetry Python instrumentation](https://opentelemetry.io/docs/languages/python/instrumentation/) | Structured spans, duration, status, attributes, and metrics | Keep local JSON run metrics with stable operation IDs, monotonic durations, counts, budgets, and status fields. Exporters remain optional so core/offline runs gain no network path. |
| [Big List of Naughty Strings](https://github.com/minimaxir/big-list-of-naughty-strings) | Adversarial Unicode, escaping, control characters, and parser inputs | Import a small fixed-commit, licensed subset into the offline security corpus with upstream and local digests. |
| [JSONTestSuite](https://github.com/nst/JSONTestSuite) | Cross-parser accepted, rejected, and implementation-defined JSON cases | Import a fixed-commit, licensed subset and classify expectations explicitly; implementation-defined cases never become permissive security oracles. |
| [Hypothesis](https://github.com/HypothesisWorks/hypothesis) | Property-based generation, shrinking, and reproducible examples | Keep the initial stress engine dependency-free and deterministic. Hypothesis is a future optional developer layer after the fixed corpus establishes stable regression semantics. |

## Feature and function upgrades

The architecture work deliberately adds user-visible functions, not only
mitigations:

- `doctor --json` explains runtime, dependency, workspace, connector, and policy
  readiness without starting a model or analysis worker.
- `capabilities --json` makes enabled, unavailable, approval-gated, and
  sandbox-required functions machine-readable for desktop and MCP hosts.
- `sandbox status --json` distinguishes a valid OCI worker from explicit unsafe
  host mode and from the default disabled state.
- `security stress` runs deterministic offline parser/path/schema workloads
  through production path/JSON/schema boundaries and produces comparable
  manifests with seed, corpus provenance, preprocessing/case budgets, metrics,
  and leak sentinels.
- Provenance creation and verification make workflow artifacts tamper-evident
  and prepare resumable/remote-review workflows without adding remote execution.
- Connector status becomes capability-aware: an adapter being present is not
  reported as executable unless its isolation policy is satisfiable.
- Workflow and review outputs gain stable hashes and resource telemetry so a
  later run can compare inputs and results instead of trusting filenames.

## Deferred work

These items remain explicit future work rather than hidden assumptions:

- Signed attestations and trusted signing identities.
- A maintained, digest-pinned OCI analysis-worker image and image update policy.
- Full SBOL conformance through reviewed pySBOL/SBOL tooling.
- Optional OpenTelemetry exporters with a separately approved network endpoint.
- Property-based developer testing after the dependency and corpus review gate.
- A custom Electron application protocol to replace `file://` once packaging and
  updater behavior are covered by integration tests.
