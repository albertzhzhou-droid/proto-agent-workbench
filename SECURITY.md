# Proto Agent Security Policy

## Supported code

Security fixes target the current `0.1.x` source tree. Generated `build/`,
`out/`, `release*/`, virtual-environment, package-store, and vendored runtime
binary trees are not source-review targets; their manifests, locks, checksums,
packaging rules, and executable-selection logic remain in scope.

Use GitHub's **Report a vulnerability** flow in the repository Security tab.
Do not open a public issue for an undisclosed vulnerability. Include the affected command or IPC route, the smallest safe
reproduction, expected and observed boundaries, and whether network, a child
process, or a symlink/junction was involved. Do not include credentials, private
biological data, or a destructive proof of concept.

## Trust boundaries

The following are security invariants, not convenience defaults:

- Renderer content, model output, MCP arguments, workspace files, notebooks,
  analysis scripts, model metadata, connector responses, and imported test
  corpora are untrusted.
- Privileged Electron IPC is accepted only from the one expected top-level
  renderer and expected local origin. Packaged builds do not load an
  environment-selected renderer URL.
- MCP file capabilities are rooted in a canonical workspace selected by the
  main process. Reads reject absolute, UNC/device, traversal, symlink, junction,
  non-regular, oversized, and out-of-root targets. Generated writes are confined
  to the canonical `build/` tree.
- Network access is denied unless a specific connector call is approved. Cache,
  fixture, and CA-bundle paths are separate capabilities and never become
  implicit side effects of network approval.
- Model or MCP input never grants unrestricted host code execution. Untrusted
  Python, notebook, and R execution is disabled unless a configured OCI sandbox
  satisfies the runtime policy. Direct host execution is a separate, explicit
  CLI-only unsafe mode and is never enabled by MCP or the desktop renderer.
- Every child request has bounded input, output, time, concurrency, and pending
  work. Cancellation belongs to the originating run and may terminate only its
  owned process tree; wildcard or name-based process termination is forbidden.
- Approvals authorize one immutable call in one workspace, thread, and live run
  for a short period. Service recreation, expiry, argument changes, or resource
  digest changes invalidate the approval.
- Secrets and the ambient environment are not inherited by sidecars or analysis
  workers. Explicit allowlists carry only variables required for local runtime
  operation.

## Stress-test isolation

Repository stress tests must remain offline and deterministic unless a human
explicitly approves a separately documented integration test. A stress run must:

1. Use a new temporary workspace, output root, cache root, and deterministic
   seed.
2. Avoid launching GUI applications, real model servers, emulators, browsers,
   shells, or any unrelated executable.
3. Avoid network calls and user-profile scans. Corpus data must already be
   pinned, licensed, checksummed, and stored in the repository.
4. Enforce total-case, per-case, input-byte, output-byte, and wall-clock budgets.
5. Track only children created by that run and never enumerate or terminate
   processes by a broad name pattern.
6. Emit a structured manifest under `build/` and verify leak sentinels before
   reporting success.

A test that violates one of these rules is an integration experiment, not a
normal stress test, and must not run automatically.

## Scientific safety

Bundled biological parts and sequences are toy development fixtures. Software
validation, provenance, and security checks do not certify wet-lab readiness,
orderability, biosafety, regulatory compliance, or scientific validity. The CLI
must not generate wet-lab execution instructions.

## Known limitations

- The local provenance format is SHA-256 content-addressed but unsigned; it
  detects post-run changes but does not establish an external identity.
- OCI runtimes and pinned worker images are not bundled. Absence or policy
  mismatch fails closed.
- Explicit CLI host execution grants the invoked code the user's host authority;
  process-tree cleanup and a minimal environment reduce fallout but are not an
  OS sandbox.
- Toy parsers and exporters are intentionally not standards-conformance claims.
