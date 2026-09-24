# Chem Workbench Architecture

**Implementation status:** Alpha  
**Product boundary:** Software-only chemistry compiler, computation, evidence, and review workbench  
**Source of direction:** `IMPLEMENTATION_PLAN.md`, plan version 0.2

This document defines the architectural contract for Chem Workbench. In this
alpha stage, words such as **must** and **must not** describe required behavior;
they are not evidence that a command, adapter, backend, desktop view, or release
gate has already been implemented. Current capability must be established from
code, capability manifests, explicit trust and registration state, active host
policy, and passing direction-specific conformance tests.

## Product boundary

The software-only v1 boundary is:

```text
source -> parse -> type-check -> chemistry-check -> compile
       -> review -> compute -> normalize results -> provenance
```

The workbench is intended to let a scientist describe chemical entities and
computational intent, identify structural and scientific inconsistencies,
compile to a versioned intermediate representation, run explicitly approved
local calculations, and review reproducible evidence.

Software-only v1 does not:

- control robots, pumps, heaters, or other physical devices;
- discover laboratory devices or register a laboratory command path;
- turn a reaction equation, graph transform, or literature record into an
  approved laboratory procedure;
- treat parse success, model consistency, process exit, parsed output, or
  convergence as proof of scientific correctness;
- treat a calculation or abstract procedure simulation as evidence of
  laboratory safety, feasibility, approval, or execution; or
- provide arbitrary user-code execution or an unrestricted plugin runtime.

XDL interoperability, platform simulation, SiLA integration, and vendor
controllers are later trust domains. They are not part of the v1 architecture
or the current alpha capability.

## Governing decisions

1. **ChemIR is the product boundary.** External formats enter and leave through
   versioned adapters. No toolkit-specific object model is the system of record.
2. **No molecular string is universally authoritative.** Original bytes,
   original representations, normalized structures, parser configuration,
   toolkit versions, and conversion-loss reports remain linked.
3. **Chemistry types remain distinct.** Molecules, coordination complexes,
   periodic structures, average crystals, explicit configurations, physical
   material lots, reaction equations, transforms, attempt records, and
   procedures cannot be silently promoted into one another.
4. **Compilation never executes.** Checking, compilation, conversion, and
   review compilation are deterministic software operations and cannot launch a
   scientific backend, contact a service, or reach a device.
5. **Every conversion is loss-aware.** Unsupported semantics produce a
   machine-readable loss report; they are never silently discarded.
6. **Warnings are first-class.** Heuristic conclusions about valence, bonding,
   oxidation state, symmetry, coordination, and stereochemistry are not
   universal hard errors.
7. **Approvals bind immutable evidence.** Approving an object creates a
   separate, append-only attestation. It never mutates the approved payload.
8. **Support is profile-based.** A schema type, format direction, or backend is
   supported only within a named profile and declared capability range.
9. **Extensions cannot redefine the core silently.** Unknown namespaced
   extensions may be preserved for round trips, but cannot contribute to core
   validity or readiness claims without an active compatible validator.

## Logical architecture

```text
Declarative .chem source or imported bytes
                    |
                    v
      parser + source map + type checker
                    |
                    v
       scientific and policy validators
                    |
                    v
              versioned ChemIR
          +---------+----------+
          |                    |
          v                    v
   pure format adapters   immutable logical plans
          |                    |
          v                    v
   external formats       compute adapters
          |                    |
          +---------+----------+
                    v
          normalized result model
                    |
                    v
     run manifest + typed artifact hashes
                    |
                    v
          review and provenance index
```

The local provenance index is an index and recovery ledger, not the sole copy
of scientific data. Portable manifests and regular artifact files remain the
minimum audit representation.

### Current `0.1.0a2` boundary

The diagram above is the target architecture, not the current execution path.
Version `0.1.0a2` implements strict, versioned documents for adapter identity,
direction-specific format capability, and conversion loss reporting. It also
implements a deterministic static registry inventory and read-only inspection
of those document types. The registry shipped with the package contains zero
adapter registrations, so no format conversion is available.

`chem capabilities` emits canonical JSON by default and has a separate
human-readable `--format text` view. The text view is not an artifact format
and cannot be written with `--output` or `--force`.

Constructing the inventory does not discover entry points, import adapter
modules, search `PATH`, inspect executable installations, launch a process,
contact a network service, plan or run a computation, or expose laboratory
control. These absences are part of the slice's contract rather than merely a
property of its current configuration.

## ChemIR

ChemIR is typed and versioned. Each top-level object uses an immutable envelope:

```text
schema_version
id
kind
payload
source_references[]
provenance_references[]
review_requirement_references[]
extensions{}                 # namespaced only
```

Digests, claims, attestations, reviewer identity, and review timestamps live
outside the payload. This prevents review activity from changing the semantic
object that was reviewed.

Physical values use a shared quantity model that preserves the source value and
unit together with a normalized value, optional uncertainty, uncertainty kind,
and provenance. Bare numbers are reserved for dimensionless schema fields.

The software-only v1 target profile covers a deliberately bounded set of
chemical and computational types. It does not make every type described in the
implementation plan normative. The exact profile boundary and deferred types
are documented in [Conformance Profiles](conformance-profiles.md).

## Source language and compilation

The `.chem` language is declarative. It organizes existing chemical
representations and typed computational intent rather than replacing SMILES,
InChI, CIF, QCSchema, or other established formats.

The grammar must exclude arbitrary code, unrestricted recursion, unbounded
loops, implicit network access, and implicit execution. Advanced composition
can be added only when it can be bounded statically and compiled
deterministically.

Compilation produces ChemIR or review artifacts; it does not produce a running
scientific process. Calculation planning is also separate from execution:

```text
CalculationSpec
    -> LogicalComputePlan
    -> ResolvedExecutionPlan
    -> approved, startup-revalidated execution
    -> raw artifacts
    -> normalized result
```

The logical plan records portable scientific intent, adapter identity, backend
requirements, and capability requirements. Resolution adds the exact
executable or package digest, generated native input, environment policy,
resources, and runtime capability snapshot. The two plans have distinct hashes
and neither may be substituted for the other.

## Adapter boundaries

Adapter responsibilities are separated by permission class:

- A **FormatAdapter** performs pure local byte-to-ChemIR or ChemIR-to-byte
  conversion. It cannot use the network or launch an executable.
- A **DataServiceConnector** may contact a configured external service only
  through the explicit `fetch` boundary. It stores the downloaded bytes and
  retrieval evidence before a pure FormatAdapter imports them.
- A **ComputeAdapter** validates and lowers a calculation, describes resolution
  against a trusted environment, and normalizes host-supplied raw results. Only
  a future trusted host runner may launch an approved resolved plan.
- A future **WorkflowBridge** may map frozen plans and results to a workflow
  system without replacing the local manifest.
- No **LabAdapter** interface or `lab_execute` capability belongs in the v1
  distribution.

One adapter cannot combine format conversion, network access, scientific
execution, workflow orchestration, and laboratory control. Detailed command and
runner constraints are defined in [Security and Trust](security-and-trust.md).

The `0.1.0a2` implementation stops at the descriptor boundary. Its Python
protocols and immutable records define how future host-owned code can exchange
bounded values, but no implementation is dynamically loaded or invoked. A
protocol, type annotation, or package boundary is not an operating-system
sandbox; containment must be selected and tested independently before
untrusted adapter code can run.

Adapter state is intentionally not represented by one ambiguous `available`
flag:

- **schema-valid** means only that a document satisfies the recognized closed
  schema and semantic cross-field checks;
- **declared** means the adapter identity occurs in the package-owned static
  registry, without implying that a supplied document is an exact match;
- **registered** means the descriptor and typed hash exactly match that
  package-owned registration;
- **trusted** is true only for that exact registration resolved through the
  package-owned registry; and
- **active** additionally requires `enabled=true`,
  `implementation_status=installed_verified`, and a conformance status of
  `experimental` or `normative`.

No transition follows from schema validity alone. The shipped registry is empty
and therefore contains no trusted, registered, or active adapter. See
[ADR 0002](decisions/0002-static-adapter-registry.md).

Package ownership is part of the trust boundary, not a field that an input can
assert. A separately constructed, internally valid registry remains unable to
confer `declared`, `registered`, `trusted`, or `active`; an exact entry resolved
through it reports `REGISTRY_NOT_PACKAGE_TRUSTED`. Within any registry document,
validation still fails closed unless manifest, capability, typed-hash,
operation, profile, ChemIR-schema, loss-schema, and allowed-loss-code bindings
agree. Capability IDs and adapter identities must be sorted and unique. Two
format capabilities for one adapter also cannot occupy the same canonical
`(format, direction, ChemIR schema, profile)` coordinate, because that would
make direction resolution ambiguous.

Loss assessment separates local contract eligibility from publication
authority. The public assessment accepts one loss report and its exact format
capability; there is no caller-supplied approvals input. A report is
`contract_eligible` only when its bindings, classification, output-hash rules,
issue severities, dispositions, and allowed loss codes pass the implemented
checks. A dropped, approximated, or `review_required` item adds
`LOSS_APPROVAL_UNAVAILABLE:<code>` while no approval ledger exists. Regardless
of contract eligibility, the descriptor-only implementation always returns
`publishable=false` and includes `PUBLICATION_PATH_UNAVAILABLE`; it never writes
or releases conversion output.

## Diagnostics, claims, and review

Diagnostics are structured records with severity, a stable code, message,
source location, actionable suggestion, and, where available, a ChemIR path and
evidence references. A deterministic invariant violation is an error; chemical
ambiguity normally remains a warning unless a declared complete model supplies
an unambiguous invariant.

Progress is represented by independent, evidence-backed claims rather than a
single success flag. Claim prerequisites and invalidation edges form an
enforced directed acyclic graph. Downstream claims become invalid when an
upstream semantic object, tool, policy, plan, backend, artifact, or required
capability changes. The claim DAG and hash meanings are defined in
[Security and Trust](security-and-trust.md).

## Runtime artifacts

An implemented computation must create a bounded run directory under an
explicit build root. Its portable evidence model includes a run manifest,
inputs, plans, diagnostics, events, raw artifacts, normalized results,
provenance, and review records. The manifest must distinguish source,
semantic, serialized-artifact, logical-plan, and resolved-plan hashes.

Files must remain below the configured root. Path traversal, symlink or junction
escape, duplicate JSON keys, non-finite values, unbounded structures, and files
that change during attestation must fail closed.

## Desktop boundary

The desktop workbench is a later consumer of the same local core. It must not
reimplement core behavior in UI fixtures. CLI and desktop parity for semantic
and plan hashes is a release gate, not a claim about the current alpha.

The renderer is expected to be sandboxed behind a narrow typed bridge. A
packaged desktop release must demonstrate the real software-only workflow and
visible window-level behavior before it can qualify for v1.

## Alpha evidence rule

Architecture documentation is not a capability manifest. During alpha:

- examples are illustrative unless backed by an executable test;
- a schema-valid or declared adapter is unavailable until it is separately
  trusted, statically registered, implemented, and its direction-specific
  capability manifest and conformance corpus pass;
- `chem capabilities` reports the immutable static inventory; it does not
  discover, import, probe, or activate adapters;
- an externally supplied descriptor may be schema-valid while remaining
  undeclared, unregistered, untrusted, and inactive;
- a schema-valid loss report with no exact registered capability binding has
  `bindings_valid=false`, `contract_eligible=false`, and `publishable=false`;
- even an exactly capability-bound, contract-eligible loss report remains
  non-publishable because this slice has no publication path;
- a command name is not proof that the command is implemented;
- a backend is not accepted through installation or a health check alone; and
- no profile may be advertised as conformant until all applicable release gates
  have passed.
