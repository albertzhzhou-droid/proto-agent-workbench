# Structure Studio roadmap — September 5 closeout

This is the bounded product queue following the first Structure Studio and CLI
execution acceptance. The original implementation plan is broader; its M7
promotion thresholds and release/platform gates must not be inferred from a
small local evaluation. See [acceptance](acceptance-2026-09-05-roadmap.md).

| Queue | Delivered behavior | Evidence and boundary |
|---|---|---|
| Next 1 — governed execution | Registered first-party ComputeAdapter; exact prepared input, installed result-relevant environment and policy fingerprints; workspace/owner-bound approval; idempotency; cancellation; interrupted-job recovery; bounded Windows Job Objects; owned scratch cleanup | Authorization, drift, cancellation and recovery regressions. Trusted local user; no claim of network/filesystem sandboxing or arbitrary plugins. |
| Next 2 — finite calculator | Real QCEngine/Psi4 water HF/STO-3G through source, CLI and desktop; explicit geometry, charge, multiplicity, method/basis and result validation | Water installation profile only. No preview geometry silently substituted. |
| Next 3 — copper design | Immutable ASE/EMT cell-scale batch, per-candidate results, exclusions, ranking and real energy curve in UI | Pure copper and bounded uniform scales. An energy ordering does not establish phase stability. |
| Next 4 — model loop | LM Studio Gemma 4 E2B, five schema-validated tools, bounded controller/repair, persisted orchestration; equivalent direct/model proposals and resolved plans; both real calculation paths | Initial 4/10 development results retained; revised independent local set 12/12; two fresh model-to-real-run parity cases pass. This is not broad statistical promotion. |
| Next 5 — import/edit/compare | RDKit SMILES/SDF including stereo and explicit supplied coordinates; immutable coordinate edits; ASE Cu(111) bare/adsorbed geometry; same-composition atom-mapped displacement comparisons | Dedicated fixtures/rejections. Constructed slabs are not relaxed structures or calculated adsorption energies. |
| Product | English live 3D UI; explicit prepare/approve/run/cancel; project revisions/reopen; unsaved-change prompts; exports; MIT; pinned build backend; notices; offline wheel install; immutable native desktop stage | Actual desktop interaction and export reopen. Configured existing scientific runtimes; no portable-backend or full WCAG certification claim. |

The previous CLI-only limitations are superseded by this delivery. Earlier
acceptance documents remain historical records. Next-cycle priorities and
unmet broader gates are listed in [NEXT_STEPS](NEXT_STEPS.md). Optional XDL and
device work remain outside the MVP as specified in the original plan.
