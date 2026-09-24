# Security and Trust

**Implementation status:** Alpha  
**Trust boundary:** Software-only local compilation, computation, evidence, and review

This document defines required security and trust behavior. It does not attest
that every control is already implemented in the alpha codebase. A control is
operational only when the implementation and its adversarial tests demonstrate
it.

## Trust principles

- Imported bytes, `.chem` source, file paths, metadata, backend output, and
  adapter-provided text are untrusted inputs.
- Parsing, validation, compilation, approval, execution, normalization, and
  review are separate state transitions.
- No success state is inferred merely from a process exit code or a parsable
  output file.
- Capabilities are least-privilege and separated by interface. Local conversion
  cannot acquire network or process-launch authority.
- Approvals and reviews reference immutable objects by typed hashes; they do not
  edit the objects they approve.
- A mismatch in a required input, digest, policy, executable, environment, or
  capability snapshot fails closed and invalidates dependent claims.
- Laboratory control is outside the software-only v1 trust boundary.

## Command permission boundary

The following table is the required contract. It is not a statement that every
listed command is currently available.

| Command family | Local deterministic artifacts | Network | Scientific process launch | Device access |
|---|---:|---:|---:|---:|
| `check` | Only when explicitly requested | Forbidden | Forbidden | Forbidden |
| `compile` | Only at an explicit destination | Forbidden | Forbidden | Forbidden |
| `convert` | Only at an explicit destination | Forbidden | Forbidden | Forbidden |
| `review-compile` | Only at an explicit destination | Forbidden | Forbidden | Forbidden |
| `approve` | Append-only attestation | Forbidden | Forbidden | Forbidden |
| `compute plan` | Explicit immutable plan artifacts | Forbidden | Forbidden | Forbidden |
| `compute execute` | Bounded run artifacts | Forbidden in v1 | The only v1 launch boundary | Forbidden |
| `capabilities` | Read the package-owned static registry; optional explicit JSON output | Forbidden | Forbidden | Forbidden |
| `inspect` | Read-only inspection by default | Forbidden | Forbidden | Forbidden |
| `fetch` | Download and retrieval evidence | The only v1 data-service boundary | Forbidden | Forbidden |

In `0.1.0a2`, only `check`, `compile`, `review-compile`, `capabilities`, and
`inspect` are implemented. The adapter registry is empty, and capability
reporting performs no entry-point discovery, module import, path scan, process
launch, network probe, or device access. A protocol or type boundary is not an
operating-system sandbox.

`fetch` is optional and may be absent from the first package. Its absence must
not weaken the offline behavior of checking, compilation, or conversion.

`compute execute` may launch only a scientific backend described by an approved
and revalidated resolved execution plan. It is not a general shell or arbitrary
program execution facility.

## Capability separation

Permission boundaries are expressed in adapter types:

- **FormatAdapter:** pure local import, export, and semantic comparison; no
  network and no executable launch.
- **DataServiceConnector:** explicit network retrieval with endpoint, request,
  retrieval time, rights metadata, response digest, cache state, and diagnostics.
  Downloaded bytes are preserved before local format import.
- **ComputeAdapter:** plan validation, deterministic lowering, resolution
  description, and result normalization. It has no process-launch method;
  controlled execution belongs only to a future trusted host runner.
- **WorkflowBridge:** a future mapping of frozen plans and results that cannot
  replace the local evidence manifest.
- **LabAdapter:** absent from the v1 distribution. No v1 registry or command can
  expose `lab_execute`.

Any future executable-backend registration must declare its schema, toolkit, adapter, and backend
versions; supported objects and operations; exact executable requirements;
package digest and trust source; operating-system and license constraints;
network and environment policies; resource ceilings; cancellation behavior;
error categories; and expected information loss.

## Trusted compute execution

The required execution sequence is:

1. Validate the `CalculationSpec` and target under a named conformance profile.
2. Lower it to an immutable `LogicalComputePlan`.
3. Resolve that plan against an allowed environment to produce a
   `ResolvedExecutionPlan`.
4. Bind approval to the logical intent and the required immutable evidence.
5. Immediately before launch, revalidate both plan hashes, executable or
   package digest, native input bytes, environment policy, resources, and
   capability snapshot.
6. Run in an isolated working directory with a minimal allowlisted environment,
   bounded output, time and resource limits, cancellation, and whole-process-tree
   termination.
7. Preserve raw artifacts before normalization and issue only the claims
   supported by the resulting evidence.

On Windows, process-tree containment must use Job Objects or a verified
equivalent. Process arguments must be passed as an argument array; untrusted
text must never be concatenated into a shell command.

The runner must reject path traversal, symlink or junction escape, an executable
or input changed after approval, environment-policy violations, malformed
output, output growth beyond configured bounds, and failure to enforce resource
ceilings. Interrupted execution retains evidence but cannot be silently
replayed when an external side effect is uncertain.

## Claim DAG

Status is a set of individually supported claims, not one global success enum.
Every claim records its producer, prerequisite claims, required evidence hashes,
invalidation inputs, and allowed successors.

The minimum computation path is:

```text
COMPUTE_PLAN_READY
  -> COMPUTE_APPROVED
  -> COMPUTE_RUNNING
  -> PROCESS_EXITED | COMPUTE_FAILED
  -> OUTPUT_PARSED
  -> CONVERGENCE_VERIFIED
  -> RESULT_VALIDATED
  -> COMPUTE_RESULT_REVIEWED
```

Core validation can separately support `PARSE_VALID`,
`STRUCTURE_MODEL_CONSISTENT`, `CHEMISTRY_CHECKED`, and, for an applicable
record profile, `RECORD_VALIDATED`. Their availability depends on the active
profile and implemented validator set.

| Claim | Producer | Required evidence | Invalidated by |
|---|---|---|---|
| `PARSE_VALID` | Parser | Source hash, grammar version, diagnostics | Source or parser change |
| `STRUCTURE_MODEL_CONSISTENT` | Profile validators | Parsed object, schema and profile versions | Semantic payload, schema, profile, or validator change |
| `CHEMISTRY_CHECKED` | Scientific rule bundle | Structure claim, rule-bundle hash, diagnostics | Any upstream or rule-bundle change |
| `COMPUTE_PLAN_READY` | Planner | Consistent target, `CalculationSpec`, logical plan hash | Target, specification, adapter, or capability-requirement change |
| `COMPUTE_APPROVED` | Named policy or human | Plan-ready claim, policy identity, logical plan hash | Plan or approval-policy change |
| `COMPUTE_RUNNING` | Trusted runner | Approval, resolved plan hash, startup revalidation | Any resolved input mismatch |
| `PROCESS_EXITED` | Trusted runner | Exit status, bounded logs, raw artifact hashes | Immutable run evidence change |
| `OUTPUT_PARSED` | Result adapter | Raw artifacts, parser version, parse diagnostics | Raw artifact or parser change |
| `CONVERGENCE_VERIFIED` | Task validator | Parsed result and convergence criteria | Result, criteria, or validator change |
| `RESULT_VALIDATED` | Result-profile validator | Required properties, units, tolerances, provenance completeness | Any upstream evidence change |
| `COMPUTE_RESULT_REVIEWED` | Human reviewer | Validated-result claim and reviewed artifact hashes | Any reviewed artifact or claim change |

Invalidation is transitive. Failed and interrupted runs retain their evidence
but cannot acquire success-only claims. `RESULT_REPRODUCED` is an independent,
optional claim that requires a defined repeat protocol and comparison with
another run; one successful run cannot produce it.

A named automatic policy may issue `COMPUTE_APPROVED` for a bounded local
calculation if it records its identity and bound hashes. Automatic approval is
never available to a laboratory execution path.

These claims are deliberately narrow:

- `PARSE_VALID` means the input parsed under an identified grammar.
- `STRUCTURE_MODEL_CONSISTENT` means declared deterministic invariants passed.
- `PROCESS_EXITED` says only that a process ended and records how.
- `OUTPUT_PARSED` says only that an identified parser interpreted the output.
- `CONVERGENCE_VERIFIED` means declared task-specific convergence criteria
  passed.

None of them alone establishes scientific correctness, reproducibility,
experimental feasibility, chemical safety, or laboratory approval.

## Hash semantics

Hash fields are typed because they answer different questions and cannot be
collapsed into one generic digest.

| Hash | Meaning |
|---|---|
| `source_sha256` | SHA-256 of the exact imported or authored source bytes |
| `semantic_hash` | Hash of canonical ChemIR semantic content plus schema version, canonicalization-algorithm version, and normalization profile; excludes timestamps and review records |
| `artifact_sha256` | SHA-256 of the exact serialized artifact bytes |
| `logical_plan_hash` | Hash of the lowered immutable plan, adapter identity, backend requirements, and portable capability requirements used to approve intent |
| `resolved_execution_plan_hash` | Hash that additionally binds the exact executable or package digest, generated native input bytes, environment policy, resolved resources, and runtime capability snapshot |

The canonicalization specification must define unit normalization, numeric
precision, map and set ordering, identifier participation, and preservation of
measurement uncertainty. Equal semantic hashes do not imply equal source or
artifact bytes. Equal logical-plan hashes do not imply equal resolved runtime
environments.

Review and approval records are append-only references to the relevant typed
hashes. Any bound source, ChemIR, adapter, backend, plan, capability, or artifact
change invalidates the dependent approval rather than editing it in place.

## Provenance and export profiles

Runtime evidence records source and input hashes, schema and semantic identity,
adapter and backend versions, logical and resolved plans, step states, bounded
logs, results, failures, and provenance completeness. Completeness is evaluated
against a backend-specific required-field profile as `COMPLETE`, `PARTIAL`, or
`UNRESOLVED`; a missing executable, generated input, basis-set identity, or
pseudopotential identity prevents `COMPLETE`.

The two provenance export profiles serve different trust contexts:

- `LOCAL_FULL` retains bounded local evidence needed for debugging and replay.
- `PUBLIC_SANITIZED` is rebuilt from an explicit allowlist. It excludes absolute
  paths, user identity, host identity, operator identity, logs, credentials,
  cache state, staging state, and other machine-specific metadata.

`PUBLIC_SANITIZED` is not produced by deleting a few fields from a full export.
The public bundle must be reconstructed from allowed fields and pass a privacy
scan. Scientific-data rights and software licenses remain explicit, separate
fields and are not removed merely because an export is public.

## Parser and artifact defenses

Implementations must bound file size, nesting depth, object count, text fields,
logs, and generated output. They must fail closed on duplicate JSON keys,
non-finite numbers, path traversal, symlink or junction escape, XML external
entities, compressed-data bombs, command injection, and files that change while
being attested.

Imported representations and conversion output remain linked to parser and
writer versions, normalization policy, stereochemistry and aromaticity policy,
numeric tolerances, and machine-readable loss codes. Unsupported coordination,
stereochemistry, occupancy, disorder, defect, or provenance semantics cannot
disappear silently.

## Laboratory exclusion

The current alpha and software-only v1 have no laboratory or device capability.
They cannot discover devices, resolve device addresses, issue commands to
laboratory hardware, or assert any of the following claims:

```text
PLATFORM_SIMULATED
DEVICE_MAP_VERIFIED
LAB_EXECUTION_APPROVED
LAB_RUNNING
LAB_EXECUTED
LAB_FAILED
LAB_RESULT_REVIEWED
```

The later software-only `procedure-draft` profile, if implemented, is limited to
a bounded logical material-and-vessel trace and may issue at most
`ABSTRACT_PROCEDURE_SIMULATED`. That claim is not platform simulation and does
not establish device compatibility, feasibility, safety, or laboratory
approval.

XDL and SiLA remain deferred behind separate licensing, simulation,
commissioning, operational-safety, and independent-review gates.
