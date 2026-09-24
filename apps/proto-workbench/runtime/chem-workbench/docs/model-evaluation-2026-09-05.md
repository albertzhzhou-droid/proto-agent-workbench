# Model evaluation and E4B integration

## Decision

Gemma 4 E4B Q4_K_M is the default experimental LM Studio candidate. E2B Q8_0
remains selectable with `CHEM_MODEL_KEY=google/gemma-4-e2b`. Selection is a closed
allowlist, always served at `http://127.0.0.1:1234`, with no silent fallback and
no model weight loader in the Workbench. Both comparisons used an 8192-token
context and four provider slots; requests were issued sequentially.

E4B performs better on this local task set but **is not promoted**: correct
abstention remains below the original 95% gate. The model cannot authorize or
execute calculations. The existing host approval and scientific-profile gates
remain in force.

## Strict comparison

The frozen suite contains 40 cases: 24 admitted requests, 12 unsupported or
missing-input requests, and four instruction-injection requests. It embeds
source and attachments, renamed IDs, explicit scale factors and expected
actions. Inputs and direct-tool oracle outputs were frozen before inference.
The task set was authored in this implementation session; independent review
is **pending**, not implied by a hash or by this report.

| Metric | E2B Q8_0, fixed host | E4B Q4_K_M, same host |
|---|---:|---:|
| First attempt schema valid | 38/40 (95%) | 39/40 (97.5%) |
| Admitted task success | 21/24 (87.5%) | 22/24 (91.7%) |
| Correct abstention | 9/16 (56.25%) | 13/16 (81.25%) |
| Injection-case correct abstention | 1/4 | 2/4 |
| All task outcomes | 30/40 | 35/40 |
| p50 request latency | 0.811 s | 1.385 s |
| p95 request latency, nearest-rank | 3.661 s | 5.107 s |
| Observed total tokens | 29,498 | 31,090 |
| Observed provider calls | 41 | 40 |

The frozen controller/scorer hashes and suite hashes match across these two
runs. This compares the installed variants, not parameter count in isolation:
quantization differs. No pressure test or uncertainty calibration claim is made.
Scores describe the complete host-assisted proposal workflow, not standalone
model stopping ability. Missing error records count conservatively as failed
or unverified; a failed authority-observation metric does not mean a shell or
calculation actually executed. No execution tool is exposed to either model.

## Bugs found and fixed

The older 12/12 check asked whether any correct tool appeared in a trace. It did
not establish correct arguments, a successful final state or absence of repeated
tools. On the new strict initial E2B baseline, 0/24 admitted requests completed
all gates, although 19/24 selected the correct first tool. This corrects the
scope of the earlier evidence; the original records are retained.

The host now ends a proposal after one tool result or rejection, produces a
deterministic report containing output hashes, and keeps the model's explanation
unverified. A follow-up is a new user request. Mechanical schema repair remains
limited to one attempt and cannot extend tool authority.

Copper scale/cell decimals now use canonical serialization: numeric `1` and
`1.0` produce identical candidate and logical-plan hashes. The regression test
compares both representations. Existing approvals do not transfer to a newly
resolved plan hash.

The initial suite exposed those defects and was reused after the host fixes;
the comparison is therefore **regression/candidate evidence**, not a fresh
independent held-out promotion set. The system prompt was not tuned to make
individual failed examples pass.

## Evidence and reproduction

- Suite: `evaluations/gemma-e2b-next-cycle-01.json` (historical filename; shared
  unchanged by both variants), hash
  `sha256:72f4aa8b0bcd26f85fb2a5c45a78e05f251b15d74d6aecd853efa8c0e7177059`.
- Initial baseline: `build/model-evaluations/1e5c04964de440cfbb9ddb1d68a5dc2c/`.
- Fixed-host E2B: `build/model-evaluations/8e22cd14bf0040c9b0a916029fd0f9f3/`.
- Same-host E4B: `build/model-evaluations/865af54571334d0fa6533da3500c19ab/`.
- Comparison: `build/model-comparison-20260905.json`.
- E4B GGUF/projector/template identity and live provider configuration:
  `build/model-e4b-identity-20260905.json`.
- E4B direct/model plan parity and real approved water/copper calculations:
  `build/model-e4b-execution-acceptance.json`.

Each evaluation has exclusive-create files, a pre-inference freeze, per-case
records, hashes, provider usage, source snapshots and a final report. Failed
cases stay in the denominator. Model/config or code drift makes the run
incomplete/ineligible. Unknown usage is not presented as zero usage. Three
consecutive provider failures terminate an incomplete run; thresholds cannot
pass an incomplete run.

```powershell
.venv/Scripts/python.exe scripts/run_model_evaluation.py --model google/gemma-4-e4b
.venv/Scripts/python.exe scripts/inspect_model_evaluation.py <run-directory>
```

The inspector checks internal consistency, including frozen source snapshots;
it does not authenticate a publisher or confer approval. Earlier runs are never
overwritten by these commands. Use LM Studio to load the requested model first.

## Next gate

Have a separate reviewer review and freeze a genuinely new task set, including
more missing-input and injection cases. Keep the current suite as regression
data. Address task selection and abstention without relaxing scientific or
authorization gates, then rerun the new set with exact model identity and
separate first-attempt/repaired denominators. Portable distribution and broader
scientific profiles remain later priorities in [NEXT_STEPS](NEXT_STEPS.md).
