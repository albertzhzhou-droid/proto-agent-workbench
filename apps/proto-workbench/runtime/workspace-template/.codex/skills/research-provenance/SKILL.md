---
name: research-provenance
description: Record software checks, inputs, artifacts, evidence, decisions, failed paths, and human-review boundaries in content-addressed workflow and review manifests. Use at the end of a design or research iteration; do not rewrite history or promote unsupported claims.
---

# Research Provenance

Run the workflow first, preserve structured diagnostics including negative results, and create the review packet from the verified workflow manifest. Content-address the workflow manifest and review packet together with the input and artifact paths each manifest explicitly declares, and record connector assumptions, the Skill catalogue digest, and unresolved evidence gaps.

Verification recomputes each bounded digest claim declared in the supplied provenance statement. It does not scan or attest every file under `build/`, prove that unlisted artifacts are complete, or establish author identity. Distinguish user decisions, software-derived observations, external-source claims, and hypotheses. The final record must say what was executed, what merely resolved as available, what failed, and which decisions remain human-only.
