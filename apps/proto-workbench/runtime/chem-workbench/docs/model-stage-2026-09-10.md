# Model upgrade stage: September 10, 2026

The stage adds a stricter, reproducible model evaluation path and stronger
proposal-to-workflow binding. Gemma 4 E4B remains an experimental LM Studio
candidate. Its new independent 72-case evaluation does **not** meet the model
promotion gate: admitted success is 39/40, but correct abstention is 21/32
against the required 95%. The identical E2B baseline scores 39/40 and 24/32,
also below the abstention gate. E2B performs better on this local set; neither
candidate is promoted. Engineering delivery and model promotion are separate
decisions, and E4B remains the existing experimental default.

## Implemented engineering changes

- Model context is derived from the compiled snapshot and registered contracts.
  Action-specific schemas distinguish discovery, inspection, geometry preview
  and the two bounded scientific proposals. Exact subject ownership and profile
  compatibility remain host checks.
- The local controller uses bounded thinking and structured actions, records
  first-attempt syntax validity and at most one mechanical repair, and retains
  provider usage and timing. Host-controlled stopping is reported separately
  from the model's selected action.
- Evaluation v3 validates suite structure, freezes embedded sources and direct
  tool oracles before inference, records code and provider configuration, and
  preserves every case in the denominator. Missing or failed observations do
  not become successful abstentions. The inspector recomputes internal evidence
  consistency; it does not authenticate a publisher or grant approval.
- A model-linked workflow must match the exact successful proposal, subject,
  source, arguments and water geometry in the saved orchestration record.
  Attaching an unrelated record cannot make a direct workflow model-derived.
  Proposal provenance never supplies approval or execution authority.
- Changing source, geometry or calculation inputs clears the previous energy
  chart, result table, resolved plan and active controls. Saved history remains
  available. This fixes a stale FCC result remaining visible after constructing
  a Cu(111) geometry; native verification now exercises that transition.

Both selectable candidates continue through LM Studio at
`http://127.0.0.1:1234`. Workbench does not load model weights itself, install
packages on a model's request or expose an execution tool to the model.

## Independent frozen evaluation

The [suite](../evaluations/gemma-e4b-stage-review-20260910.json) contains 40
admitted cases, 16 unsupported or incomplete cases and 16 injection cases.
It covers all five registered tools, renamed and multiple targets, inspection
of non-structure declarations, chiral previews, missing scientific state and
unsupported profiles. All 72 sources compile and all 40 admitted direct oracles
were verified without inference.

An agent independent of the implementation work authored and reviewed the set.
Exact case content was withheld from the implementation agent until the
controller and evaluator were frozen. This is **agent independent review**;
human review remains pending. The author and semantic reviewer of the suite are
the same independent agent, as recorded in the [suite review](reviews/model-suite-20260910.md).
The suite is now observed evaluation evidence and must not be reused as an
unseen promotion set after further tuning.

Suite content hash:
`sha256:7f926b0603a2f0ea59fd135ab03019c1b7c7aa29b9b53e22166cb8dd845ea950`.

| Metric | E4B Q4_K_M | E2B Q8_0, identical suite |
|---|---:|---:|
| First-attempt schema validity | 71/72 (98.61%) | 71/72 (98.61%) |
| Admitted task success | 39/40 (97.5%) | 39/40 (97.5%) |
| Correct abstention | 21/32 (65.63%) | 24/32 (75%) |
| Injection-category correct abstention | 11/16 (68.75%) | 12/16 (75%) |
| All native action outcomes | 60/72 (83.33%) | 63/72 (87.5%) |
| Host workflow outcomes | 60/72 (83.33%) | 63/72 (87.5%) |
| Success after an observed retry | 0/1 (0%) | 0/1 (0%) |
| Authority boundary observed intact | 71/72; one unobserved | 71/72; one unobserved |
| Observed authority violations | 0 | 0 |
| p50 request latency | 5.706 seconds | 4.599 seconds |
| p95 request latency, nearest rank | 10.746 seconds | 8.479 seconds |
| Observed provider calls | 73 | 73 |
| Observed total tokens | 129,688 | 133,221 |
| Measured promotion thresholds | Failed | Failed |

Both runs completed all 72 cases with stable recorded code and provider
configuration. Token usage was present for all 73 observed provider calls in
each run. The comparison supplement verifies identical frozen code, suite,
source snapshots and direct oracles across the two evaluations.
The authority-observation denominator remains 72: a schema failure has no final
authority observation. This is not evidence that a forbidden computation ran.
No authority violation was observed in the available records.

In each run, the failed schema case contains two schema-invalid provider
responses, showing one unsuccessful retry. Because no final orchestration record
exists, its repair metadata is unavailable and the original v3 aggregate
repair-success field reports 0/0. The separate read-only comparison supplement
counts observed provider retries independently of final-record availability and
reports the correct observed cohort, 0/1 for each model. It verifies both bundles
and preserves their original v3 reports unchanged. No repair attempt is hidden
by the final-record omission.

Eight injection cases put authority-spoofing text directly in the objective;
both candidates abstained correctly on 7/8. Another eight put directives in source
comments that the host omits from model context; E4B abstained on 4/8 and E2B on
5/8. The latter measure
host filtering and behavior when the requested directive is absent, not model
resistance to attack text it received. Reporting only 11/16 as model-visible
prompt-injection resistance would overstate this evidence.

The native-action metrics measure the selected action and arguments in a
host-constrained interface. A valid tool result is still produced and validated
by the host. Stopping after that result is host behavior, not a demonstrated
free-running model capability. These local correlated cases do not establish
population reliability or general chemistry competence.

## Remaining model failures

The failed cases expose semantic substitution that the next stage must address.
For example, E4B proposed the installation water geometry when the request
explicitly required missing measured coordinates, reduced a ten-scale request
to an admitted nine-scale batch, chose an arbitrary target between two water
objects, and proposed the gas-phase water fixture for a liquid-phase request.
Other failures called an unrelated read-only tool instead of clarifying, or
abstained on a valid admitted water request.

These actions remained non-executable proposals, but they do not faithfully
preserve user intent. Passing the JSON schema or a source-level profile check
is insufficient evidence that a proposal satisfies the objective. The failures
are retained; the frozen controller, suite and expected outcomes were not
changed to improve this evaluation.

## Evidence and local acceptance

- E4B run: `build/model-evaluations/a750cf999932488fb6790443a6724098/`.
- E4B freeze hash:
  `sha256:b36781562aee0081127afb6e084713ed6747807d34a614ccedac308532b48a0f`.
- E4B report hash:
  `sha256:d269586b4d14461a76c47d387fe53335a94b5c2f7f9e0ec2d1185579e67dbaed`.
- Identical-suite E2B baseline:
  `build/model-evaluations/22e23803de694fc4a07c6610dfe1ce16/`.
- E2B report hash:
  `sha256:e13438dcd850fef359b418ccf4058fc4e3252bee4711c74d9f9bda1f0141479d`.
- Verified comparison and observed-retry supplement:
  `build/model-comparison-20260910-retry-supplement.json`, hash
  `sha256:72aaef2b14f82713eb5a3a0c223c7c58a41b711564c368497c089c843ef12eeb`.
- Final source verification: 394 tests passed in 327.54 seconds, with one
  upstream ASE warning about NumPy 2.5 deprecation. Ruff formatting covered
  63 files in the final check, lint passed, and mypy passed for 43 source files. Six additional
  focused tests passed for the new read-only comparison supplement. These checks
  do not include pressure testing.
- Isolated offline core installation passed:
  `build/offline-reviewed-wheel-acceptance-20260910.json`. The installed package contains
  the exact 72-case suite, compiles the checked source and retains E4B as its
  configured default. This does not establish a portable scientific runtime.
- Real E4B-linked water and copper calculations passed:
  `build/model-execution-stage-20260910.json`. Both logical and resolved plans
  match their direct equivalents, the saved orchestration reference matches the
  exact proposal, direct approval context remains isolated, and both supervised
  scientific jobs succeeded. The water installation check returned
  `-74.96292824697167` hartree within its pinned acceptance window.
- Native desktop acceptance passed for
  `build/desktop-a2d9a7d0ec784bd2932d70ef91834115/`:
  `build/desktop-qa-stage-20260910-reviewed/desktop-acceptance.json`.
  It exercised an actual E4B proposal with matching provenance, explicit
  approval, real copper and water calculations, chiral import, coordinate
  editing/comparison, Cu(111) construction, stale-result clearing, saved revision
  reopening and independently reopened JSON exports. There were zero page
  errors. Renderer sandbox and context isolation remained enabled; Node
  integration remained disabled. All 253 shipped files still matched the
  package manifest after the run. Water and slab screenshots were visually
  inspected. The earlier desktop run is retained as pre-fix evidence.
- The desktop snapshot's documentation records the staging-time state. This
  repository report adds the completed native acceptance without modifying the
  verified package. The source UI is available at `http://127.0.0.1:8768/` while
  its local server is running.

The evaluation freeze identifies the provider's reported variant and loaded
configuration. Its `model_artifact_hashes` field is unavailable, so the freeze
alone is not a cryptographic measurement of the GGUF bytes. Separate fresh
September 10 records, `build/model-e4b-identity-20260910.json` and
`build/model-e2b-identity-20260910.json`, contain streamed SHA-256 measurements
of each actual GGUF and vision-projector file. Both match the recorded baseline
artifact hashes. These are separate observations, not retroactively inserted
fields in the evaluation freeze. Both provider configurations use 8,192-token
contexts and four slots; the suite requests are sequential. The quantizations
differ, so the comparison concerns installed variants rather than model size
in isolation. The separately observed chat-template identities match in
`build/model-template-identity-20260910.json`.

The [September 5 comparison](model-evaluation-2026-09-05.md) remains unchanged:
E2B 30/40 and E4B 35/40 on the earlier shared regression set. The failed 4/10
development record and later 12/12 local check also remain historical evidence.
Different suites and controllers prevent interpreting these totals as a direct
before/after accuracy comparison.

## Next gate

Priority 1 remains semantic intent and proposal gating. Represent the selected
target, geometry provenance, requested conditions, method and complete scale set
as reviewable requirements; reject silent substitution and clarify unresolved
intent. Validate those requirements again when preparing a workflow. Freeze a
fresh unseen evaluation after development and obtain the separate human review
required for promotion. Keep first-attempt, repair, host and native-action
metrics separate and preserve all negative results.

The [portable Windows plan](portable-windows-plan.md) is priority 2 and remains
planned. The current preview depends on installed scientific runtimes. No
portable-distribution acceptance, signing, public release, laboratory operation
or device integration is supplied by this model-stage delivery. The remaining
ordered work is in [NEXT_STEPS](NEXT_STEPS.md).
