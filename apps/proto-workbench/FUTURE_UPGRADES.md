# Proto Workbench Future Upgrade Roadmap

Updated: 2026-09-01

This document records only upgrades that have not yet been implemented. Development stopped after Stage 16 was completed. When work resumes, re-audit the current state from this document; do not treat the roadmap as evidence that any item has been completed.

## Invariant Boundaries

- Offline by default, least privilege, and fail closed. Preview data, cached data, fixtures, and real external connections must be described separately.
- Do not provide wet-lab execution instructions. Biological materials may enter model-facing workflows only through `DESIGN_ELIGIBLE` records in the external materials root; quarantine remains admin-only.
- Do not automatically sign, generate keys, activate trust, replace roots, advance witness state, authorize an effect, or execute a release.
- Do not run stress tests until the user explicitly authorizes them again. Later stages may run only focused, static, type, build, interaction, and single-concurrency non-stress regressions.
- Every stage must retain content-addressed inputs, structured diagnostics, provenance, digests, timestamps, and human-review boundaries.

## Recommended Resumption Order

### Stage 17: Evidence Relationship Graph and Cross-Center Deep Links

Goal: Connect the Decision Bundle, Trust Policy, Signature Evidence, TUF Root Candidate, and Transparency Witness Pack into a traceable evidence graph instead of five independent directories.

To implement:

- Create read-only edges using digests, bundle IDs, policy IDs, log leaf hashes, and checkpoint body digests.
- From the Signature Evidence Center, provide one-click navigation to the matching inclusion proof, checkpoint, and witness quorum.
- Report separate diagnostics for broken links, duplicate claims, identical digests with different semantics, and different roots at the same checkpoint height.
- Add path explanations for "why trusted / why incomplete / why rejected," and allow export of a machine-readable graph snapshot.

Acceptance evidence: Tested cross-center navigation, cycle/orphan/conflict fixtures, a content-addressed graph digest, responsive-layout screenshots, and no console errors.

### Stage 18: Official Witness Policy Lifecycle

Goal: After Sigstore officially distributes the Rekor witness set and M-of-N policy through TUF, replace the current release-pinned review policy with sequential TUF updates.

To implement:

- Verify the witness policy target's length, SHA-256, version, expiry, old and new thresholds, and rollback protection.
- Support witness key rotation, overlap periods, revocation, and historical checkpoint verification.
- Support independent anchors for multiple Rekor shards/origins; do not treat a staging witness as production authority.
- Preserve human review and offline import; do not add an online automatic updater.

Start condition: An official, auditable TUF target has been published, and its semantics can be confirmed from Sigstore documentation or the root-signing repository.

### Stage 19: Offline Distributor and Multi-Source Checkpoint Reconciliation

Goal: Import checkpoint sets from the log, public distributors, organizational mirrors, and independent observers to detect stale views and split views.

To implement:

- Design a content-addressed distributor snapshot pack and canonical manifest.
- Reconcile root sets for the same origin and size; verify consistency chains across different sizes.
- Display source independence, observation time, the intersection of witness coverage, and the minimum quorum.
- Generate a transferable tamper-incident packet, but do not automatically report it or send external messages.

Public references:

- https://github.com/transparency-dev/distributor
- https://github.com/transparency-dev/witness
- https://github.com/C2SP/C2SP/blob/main/tlog-witness.md

### Stage 20: Guided Import and Failure-Recovery Guidance

Goal: Enable users without a cryptography background to prepare and diagnose offline evidence packs correctly without creating trust material inside the application.

To implement:

- Provide a six-step import preflight: directory, file set, checksum, policy anchor, checkpoint, and proof.
- Before copying, display exact differences and maximum byte limits. Provide actionable but non-bypass guidance for symlinks, junctions, hardlinks, and TOCTOU.
- Provide contextual help for rollback, fork, missing quorum, future timestamps, and unsupported kinds/versions.
- Add copyable structured diagnostic JSON and a minimal remediation checklist; do not provide an "Ignore errors" button.

### Stage 21: Advanced Review UI and Accessibility

Goal: Improve usability for long lists, keyboard users, and low-vision users while retaining the current high-density desktop audit language.

To implement:

- Add a Global Evidence Command Palette, cross-center breadcrumbs, historical selection restoration, and shareable local filter state.
- Use virtual lists for large directories; provide column-level sorting and copy feedback for digests, origins, key IDs, and tree sizes.
- Complete acceptance testing for screen-reader order, focus return, contrast, 200% zoom, Windows High Contrast themes, and reduced motion.
- Add a bilingual Chinese-English UI copy layer without changing machine-readable schemas, code, or diagnostic IDs.

### Stage 22: Release Evidence and Installer Closure

Goal: Combine the desktop build, module manifest, third-party declarations, installer digest, and offline verification results into an independently reviewable release dossier.

To implement:

- Bind the installer, portable package, module manifest, runtime trust, connector registry, and license digest.
- Perform real local verification of signed installers. Unsigned builds must be clearly labeled; do not equate a hash with publisher identity.
- Retain TUF review packs and an operator checklist for upgrades and rollbacks; do not implement unattended trust replacement.
- Record focused validation, single-concurrency non-stress regression, desktop build, and the formal offline release gate separately.

## Cross-Cutting Harness Backlog

- Extract the signed-note, Merkle, and witness policy parsers into a versioned pure-verification library that can be fuzz-tested while keeping stress tests disabled by default.
- Add boundary vectors: maximum uint64, 63/64 proof hashes, duplicate signatures, unknown keys, bad signatures with matching key IDs, extension lines, non-canonical base64/decimal encodings, and zero-size trees.
- Generate a schema inventory for every IPC and verify one-to-one correspondence between preload exposures and main handlers.
- Add browser fixture state contracts to ensure preview-only data never enters the packaged renderer.
- Continue strengthening owned-process capabilities, workspace containment, and artifact single-link checks without touching unrelated processes.

## First Step When Work Resumes

First, re-read this document, `connectors/proto_workbench.json`, the current `design-qa.md`, and the latest test output. Confirm whether the official witness policy has changed, then decide whether to enter Stage 17 or prioritize Stage 18.
