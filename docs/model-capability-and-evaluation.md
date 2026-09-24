# Model capability probes and evaluation records

## Capability evidence

Model catalog metadata is an advertisement, not an observed capability. The model list keeps LM Studio's `trained_for_tool_use` field in `providerToolUseAdvertised`; this field never sets `toolCapability` to `agent-ready`.

The Models page offers an explicit tool-call probe for a connected LM Studio instance. It sends one bounded, forced function call with a random challenge, executes no returned tool, and records only the exact model fingerprint, provider instance id, request/response hashes, argument hashes, observed tool name, status, and timestamps. Raw prompt text, challenge values, and raw model output are not stored. A pass certifies only that this exact instance returned the requested call with the required arguments. It does not certify scientific reasoning, image input, context length, cancellation, or any other capability.

Probe statuses keep passed, failed, malformed, timeout, cancelled, unsupported, unavailable, and runtime-error outcomes distinct. Records are append-only and content-hash checked. `agent-ready` is derived only while the latest passed probe's model fingerprint and instance id match the connected model. Disconnecting, replacing the instance, or changing the model fingerprint returns the capability to `unknown`.

The current implementation probes LM Studio's OpenAI-compatible streamed function-call path only. Image, structured-output-only, context-limit, Unicode edge-case, and cancellation probes remain separate future work; no provider capability is inferred from a model name.

## Scientific evaluation ledger

`ModelEvaluationAttempt` records bind an attempt to immutable case, dataset, reference, scorer, provider, model, exact instance, runtime, tool-schema, and prompt-template identities. Each record keeps three independent outcomes:

1. Tool selection and argument selection.
2. Execution receipt and recovery outcome.
3. Scientific answer, unit check, and source check.

The append-only SQLite ledger accepts error, timeout, cancellation, refusal, unsupported, and interrupted attempts. Its summary reports separate counts for each dimension, including `unscored` and `not-run`, so an execution failure cannot disappear from the run denominator or be confused with a wrong scientific answer. Raw answer text and case content are not accepted by the record schema; content-addressed external case and reference artifacts provide the binding. The UI exposes read-only summaries; no user-facing case runner currently creates scientific evaluation attempts.

No frozen scientific case pack, reference set, baseline, or human-scoring protocol is bundled yet. Therefore this release provides the evidence contracts and storage foundation, but no scientific accuracy score, comparative model ranking, or benchmark claim. Before scoring a domain task, create and review a versioned case pack with independent references, freeze its digests and scorer version, and preserve every attempt. A successful tool call alone must never count as a correct scientific answer.

## Synthetic software Harness iteration

A separate [frozen software evaluation runner](harness_iteration_evaluation.md)
now binds 30 fixture-only cases to the same-instance direct and Harness arms.
It reuses this append-only ledger and keeps completion, validation, abstention,
resource usage, duplicate journal effects, recovery, and diagnostic classes as
independent metrics. Scientific answer scoring remains `not-run`. Scripted
runner tests are not live baseline results; any live measurements must link to
the retained campaign artifacts and their exact instance and source snapshot.
