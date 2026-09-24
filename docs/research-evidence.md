# Research Chat receipt-bound facts

This A2 increment adds a narrow host projection of saved tool receipts. Chat response `state: complete` means **generation finished**. It does not establish scientific validity, source entailment or correctness of the model's interpretation. The UI says “Response finished” and labels model prose “Not independently checked”.

The host writes each complete tool receipt as UTF-8 bytes and records `artifactSha256` in the conversation. Returned session snapshots reopen the receipt, hash the same bounded byte string that is parsed, and rebuild evidence cards. They do not use truncated model previews or trust previously serialized evidence cards. A changed, missing, unsafe or incompatible receipt produces no bound facts. A legacy record without the host digest remains unreviewed; opening it never upgrades it by hashing whatever happens to be on disk.

## Supported projections

| Operator | Bound fields | Request association | Unit source |
| --- | --- | --- | --- |
| `chemistry.calculate_acid_base_speciation` / `chem.calculate_acid_base_speciation` | Exact `alpha_i` identity, fraction, pH, protons lost and formal charge | Parsed request and receipt pKa/pH/initial-charge inputs must match; the complete ordered species contract must match | Receipt `result.visualization.y_unit`, required to be `dimensionless` |
| `compute.run` aliases returning `analyze_qpcr_relative_expression` | Exact sample ID, relative expression, sample group and control group | Requested `arguments.path` must exactly match receipt `source.path`; receipt source digest must be structurally valid | Explicit `qpcr-relative-expression/v1` operator contract: dimensionless ratio |

Each fact also carries an immutable receipt digest, activity ID, deterministic fact ID, JSON pointers for value and identity, and the literal unit field or named unit contract. There is no formula inference: `alpha_0` is not renamed to H₂A. A tool may complete successfully while its contract is unsupported for projection. Other operators and citations remain unreviewed.

“Receipt-bound” means matching saved receipt fields only. This increment does not re-execute calculations, rehash all referenced native artifacts, verify that a mutable input file still matches the historical input, validate the scientific method, or establish biological eligibility. The qPCR request association is a path comparison against the saved receipt; it is not a current-input integrity check. These boundaries are visible in the UI.

## Retained failure and explicit claim checker

The retained case is `build/science-expansion/chat-expansion.json`, SHA256 `58c614f2945792b96dea288eabdcdd8c158c3f546f49f545557673b5812b6c55`. At `/session/messages/1/content`, the historical model labeled `alpha_0` as “H₂A 型”. The calculation returned the correct fraction 0.5 at pH = pKa = 4.76 with one pKa; its species list contains `alpha_0`/`alpha_1` and contains no molecular formula. The failure is an unsupported identity label, not an arithmetic error. The original trace remains unchanged and remains a failed case.

The portable fixture at `apps/proto-workbench/tests/fixtures/research-evidence/acid-base-retained.json` preserves the literal offending line, copied full receipt and original provenance hashes. Tests create their own fresh host receipt digests; the fixture is not represented as a newly executed model evaluation. The original native `result.json` digest is `559614231fc3d4d0c1dfe6baafe8a74ea0f67027b4bd556a1d9c223ccd6b8ba7`.

`verifyStructuredResearchClaim` compares an explicit fact ID plus the entire subject/quantity/value/unit tuple. A substituted H₂A identity fails. Separate synthetic negatives substitute mol/L or percent units and values; no retained model unit-error case is claimed. Explicit inferences remain unreviewed. Unknown fields such as a citation cannot silently become bound. There is no automatic unit conversion or tolerance matching.

**No report tool or natural-language claim extraction is wired in this increment.** The checker does not automatically diagnose arbitrary prose. The erroneous historical sentence is preserved, displayed as unreviewed interpretation, and kept separate from the host's literal facts. Citation entailment and broader scientific claim verification remain future work.

## Bounded reads and verification

Each returned session snapshot projects at most the eight latest candidate activities. Each receipt is at most 1 MiB; each projection has at most 128 facts. Older candidates show `SNAPSHOT_PROJECTION_LIMIT` without partial promotion. Reads reject foreign-session paths, malformed session IDs, directory links, linked/non-regular files, file identity changes and digest changes. This is an integrity check against the local conversation database, not protection against an attacker who can rewrite both database and artifacts.

Targeted deterministic validation (no model, network search or GPU execution):

```powershell
cd apps/proto-workbench
node --experimental-strip-types --test tests/research-evidence.test.mjs tests/research-chat-evidence.test.mjs tests/research-chat.test.mjs
pnpm typecheck
```

The tests cover literal identity/unit binding, retained and synthetic negative claims, request mismatch, duplicate sample IDs, missing contract fields, bounded reads, tampering, legacy records, SQLite reopening and preservation of unreviewed model text. Existing cancellation, generation limits and transcript behavior remain covered by the original Chat tests.

For browser acceptance, stop the preview and seed three explicitly labeled disposable fixture conversations through the real service:

```powershell
node --experimental-strip-types tests/seed-research-evidence-preview.mjs --seed-preview ../..
```

Restart the existing preview and open “Fixture · receipt-bound facts”, “Fixture · tampered receipt” and “Fixture · legacy without digest”. These are backend/UI acceptance fixtures, not live-model or scientific acceptance. The script only adds new conversation IDs and their own tool artifacts; it never rewrites the retained historical case.
