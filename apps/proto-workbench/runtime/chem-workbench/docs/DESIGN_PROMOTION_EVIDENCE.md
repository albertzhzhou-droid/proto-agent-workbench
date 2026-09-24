# Design promotion evidence contract

`scripts/assess_design_promotion.py` assesses retained evidence without inference, calculator
execution, changing the default model, or scientific approval. Use `--evidence <manifest.json>
--root <repository> --output <new-assessment.json>`. Output must be new and outside the
immutable run directories. Exit 0 means all acceptance gates are supported; exit 2 means
one or more gates are failed or not checked. The assessment makes no whole-goal completion claim.

## Artifact bindings and runs

Every reference contains exactly `path` and `sha256`: a path relative to the evidence root
and the 64-character SHA-256 digest of the actual file bytes. Changed bytes, external paths,
unknown checklist fields, and malformed references are rejected. JSON envelopes also use
`chem_workbench.visualization.content_hash` over every field except their own hash field.
This canonical JSON hash is distinct from a file-byte digest.

The manifest has version `design-promotion-evidence/v1`, `manifest_hash`, and these fields:

| Field | Contract |
| --- | --- |
| `candidate_runs` | At least two distinct entries for one candidate; every repeat passes local acceptance. |
| `baseline_run` | A preserved, complete Gemma E2B run using the exact same fixtures. Baseline failures remain observations. |
| `fresh_suite_review` | Reference to the independent suite review below. |
| `abstention_review` | Reference to the independent explanation review below. |
| `external_reviews` | Map from supported gate names to independent observation-review references. |

Each run entry contains `report`, `identity_before`, and `identity_after` references. The real
design inspector replays every raw row, fixture, oracle, binding, and summary. Report hashes
and run IDs must differ across repeats. Fixture, controller/tool source, dependency-lock,
hardware-accounting, and decoding identities must match across candidate and baseline.
Frozen controller source binds the stage, repair, latency, and token-budget policy.
Metrics remain separate for every repeat; averages cannot conceal a failed repeat.

Identity references use the existing `model-runtime-identity/v1` capture format and bracket
the run's `frozen_at_utc` and `completed_at_utc`. Checks cover reported configuration, weights,
tokenizer metadata, active template text/file hashes, actual engine-image binding, and runtime
binary bindings. Pinned bytes and configuration must agree before/after and across candidate
repeats. Process IDs, observation times, mtimes, and temporary template paths may differ.
This binds recorded on-disk identities and process observations, not resident tensor or
loaded-memory byte equality.

## Independent suite and explanation review

`design-held-out-review/v1` contains `review_hash`, `suite_hash`, `fixtures_hash`,
`suite_author_id`, `controller_author_ids`, `reviewer_id`,
`review_kind: independent_agent_observation_review`, `authored_at`, `reviewed_at`,
`evidence_refs`, and `case_reviews`. Authoring and review precede inference. Author and
reviewer differ from controller authors and from each other. Every suite case appears once
with `case_id`, canonical `case_hash`, `determination: held_out`, and a concrete `rationale`.
References retain the observations supporting the suite's independent authoring and review.

`design-abstention-review/v1` contains `review_hash`, `suite_hash`, `reviewer_id`, the same
`review_kind`, and `reviews`. Every negative case in every candidate repeat appears once.
Each row supplies `report_hash`, `case_id`, `row_hash`, `response_hash` (canonical hash of the
last raw response text, or null), `expected_reason`, `observed_reason`, and `verdict`
(`correct`, `incorrect`, or `unreviewable`). A correct reason counts only when the sampled
abstention and safe-stop check also passed. At least 95% of all 90 negatives must be correct
in **each** repeat. Missing and failed observations remain in the denominator.

These records support independent agent review of actual requests, responses, and tool
observations. They do not add mandatory human model-promotion approval or cryptographic
signing. The composer verifies coverage and bindings; semantic judgments remain attributed
to the identified independent reviewer. Scientific attestation remains separate and unreviewed.

## External observation reviews

`design-external-evidence-review/v1` contains `review_hash`, `gate`, `reviewer_id`, the same
`review_kind`, `code_identity_hash`, `candidate_report_hashes`, `findings`, and `artifacts`.
Each required criterion appears once in `findings`, with `criterion`, a concrete
`observation`, `outcome` (`supported`, `contradicted`, or `unresolved`), and nonempty
`evidence_refs`. Existing raw tool receipts, screenshots, and exported files can be cited
directly. Boolean checklists cannot replace observations. All findings and applicable
machine checks must pass. `artifacts` maps the roles below to ordinary file references.

| Gate | Required criteria | Additional machine checks / artifact roles |
| --- | --- | --- |
| `ui_acceptance` | `actual_workflows`, `invalid_inputs`, `source_bound_visuals` | Independent review of actual interaction receipts and captured visuals. |
| `packaged_acceptance` | `actual_native_launch`, `export_reopen`, `package_scope` | `release_manifest`: rehash package files, require native launch files, and match packaged frozen source. Report preview, unsigned, runtime, and installation scope accurately. |
| `deterministic_regressions` | `full_suite_and_required_checks` | `junit`: actual test cases, no failures/errors, and at least one executed case. Reviewer checks full-suite and required static-check coverage. |
| `windows_supervisor` | `owned_child_containment`, `resource_limits`, `owned_cleanup` | Independent review of actual Windows supervisor observations. |
| `bounded_contention` | `one_bounded_model_and_psi4_job`, `resources_and_cleanup` | `report`: existing contention report and raw hashes; exactly one request/job, identities, cleanup, observed overlap, and resource assessment. |
| `committed_source` | `author_and_committer_identity`, `frozen_source_commit` | `commit_record`: JSON containing a 40-character `commit`; `git show` checks every frozen source/lock path. Reviewer checks author/committer observations. |
| `existing_structure_acceptance` | `fresh_independent_complex_suite`, `actual_end_to_end`, `full_original_acceptance` | `report` and `execution`: real Structure v4 replay, full coverage/numeric gates, exact 40 admitted cases, at least 36 completions, source/parity/row bindings, and molecular result bytes. Development 20/20 is insufficient. |

Legacy Structure/contention snapshots omit `pyproject.toml`. The composer allows only that
extra design dependency-declaration entry while requiring equality of all shared source/lock
entries. Other omissions and changes fail. All attempts, including failures and baseline
attempts, enter token and duration totals; missing measurements cannot silently become zero.
No electricity or monetary prices are invented.

Missing evidence stays `not_checked`; contradictory observations fail. Structured independent
review can satisfy qualitative gates without any new approval role. Existing Structure
acceptance remains mandatory for the overall model assessment, so design-only evidence
cannot promote the general default. `scientific_review` stays `unreviewed` and
`execution_authority` stays false.
