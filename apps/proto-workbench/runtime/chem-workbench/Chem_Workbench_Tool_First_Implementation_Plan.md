# Chem Workbench: Tool-First Implementation Plan

**Document version:** 0.2 — proposed implementation baseline; adds the surface/interface reaction extension (§2.2, §2.3, §7.2, §7.6, §9.4, §10.5, §16.1, §17, §19)  
**Prepared:** September 5, 2026  
**Audience:** coding agents, maintainers, and scientific reviewers  
**Working package:** `chem_workbench`  
**Working CLI:** `chemwb`  
**Core interchange model:** `ChemIR v1alpha1`

> Build a local, tool-mediated inorganic chemistry design workbench. The language model proposes bounded actions; the application authorizes them; domain tools perform calculations; validators establish what the resulting evidence actually supports.

This is a replacement outline, not a claim that the software already exists. It preserves the supplied outline's requirements for chemical semantics, loss reporting, provenance, licensing, Windows execution, and CLI/desktop consistency. It does not assume access to earlier, unsupplied sections or to the Proto CLI source code. Package and command names are provisional until the repository and distribution names are checked.

`MUST`, `SHOULD`, and `MAY` below express project requirements. Numerical budgets and acceptance thresholds are proposed engineering defaults, not measured model capabilities or scientific guarantees.

## 1. Architectural revision

The central unit of the product changes from **a model-authored chemistry program** to **an authorized, typed workflow with inspectable evidence**.

| Area | Revised decision |
|---|---|
| Model interface | Small, task-specific tool schemas instead of requiring the model to generate a complete `.chem` program. |
| `.chem` | Optional declarative front end that lowers to the same core services and ChemIR as tool calls. It is not the execution authority. |
| Chemical reasoning | Separate proposal generation, method selection, calculation, validation, comparison, and interpretation. |
| Execution | Deterministic workflow templates and reviewed adapters; no general-purpose runtime shell or model-generated Python. |
| Model size | Start with a small instruction-tuned local model as a candidate controller; promote it only after task-specific evaluation. |
| Scientific authority | Typed results, method profiles, source records, and validation reports—not the model's confidence. |
| Development order | Complete a model-free structure-to-computation-to-evidence slice before adding an agent or desktop UI. |
| Extensibility | Add a domain profile together with its tools, limitations, fixtures, and acceptance tests. Do not begin with a universal chemistry ontology. |

### 1.1 Separation of agents

The **coding agent** implements this specification in the repository. The **runtime chemistry agent** is the local model used by the finished workbench. Repository access available to a coding agent MUST NOT become a capability exposed to the runtime chemistry agent.

The runtime agent MUST NOT install packages, edit validators, modify method profiles, create adapter code, or approve its own execution requests.

### 1.2 Product outcome

A user should be able to supply a chemical structure and a bounded design objective, inspect a proposed evaluation workflow, authorize an explicit computation budget, and receive a reproducible comparison whose claims link to actual results.

The same workflow MUST be usable without an LLM. The LLM improves accessibility and orchestration; it is not a mandatory dependency of the chemistry core.

## 2. Scope and first deliverable

### 2.1 MVP scope

Implement these capabilities first:

1. Import, inspect, and validate finite molecular structures and explicit periodic structures, while retaining original files and conversion diagnostics.
2. Execute a small finite-system single-point calculation through a reviewed QCSchema/QCEngine backend.
3. Execute an explicit periodic copper calculation through ASE/EMT, then evaluate a bounded lattice-scale candidate set.
4. Compare only results whose subject, method, property, and normalization are compatible.
5. Produce an evidence report with separate execution, convergence, applicability, reproducibility, and review states.
6. Allow a small local model to operate the same services through typed, permission-controlled tools.

The copper scan is the first **bounded design-loop demonstrator**, not a general inorganic materials discovery engine. The water calculation is an integration fixture, not evidence that the system handles transition-metal electronic structure.

### 2.2 Required limits

The MVP MUST NOT claim general support for reaction prediction, synthesis planning, spin-state ranking, catalytic activity prediction, phase stability across compositions, defects, disordered materials, autonomous experimental execution, or surface and interface reaction kinetics. Surface and interface chemistry enter this plan only as a separately profiled post-MVP extension (Section 2.3, Section 7.6, Section 10.5), never as an implicit consequence of periodic-structure support.

The MVP MUST NOT implement physical equipment control, purchasing, arbitrary external uploads, unrestricted internet browsing, or an unrestricted code-execution tool.

A calculation backend being installed does not make every method, element, charge state, property, or boundary condition supported. Capabilities are admitted by **tested workbench profiles**, not by the entire advertised feature set of an upstream package.

### 2.3 Follow-on research workflow

After the demonstrator passes, select one research-relevant extension rather than adding several domains simultaneously. Candidates include an explicit, same-composition structure-comparison workflow or a constrained aqueous-speciation workflow.

An aqueous extension requires its own solution-state schema, thermodynamic database provenance, concentration conventions, activity-model assumptions, and applicability tests. PHREEQC is a candidate backend for speciation and saturation-index calculations [R8]; it is not an implicit capability of the initial molecular/periodic core.

An interface reaction extension is a third candidate: a bounded, slab-based workflow that evaluates site-resolved adsorption and reaction-step energy differences within an admitted copper-only EMT profile (Section 10.5). It requires derived-slab semantics (Section 7.6), explicit normalization rules (energies per adsorbate and per surface area), termination and slab-size sensitivity flags, and a hard prohibition on kinetic claims: no barriers, rate constants, or catalytic-activity statements exist until a separately reviewed transition-state method profile admits them. Interface reaction steps are declared energy-difference bookkeeping over referenced subjects, not predicted chemistry.

## 3. System architecture and ownership

```text
User request / CLI / optional .chem / future desktop
                         |
                         v
              Application service boundary
                         |
           +-------------+---------------+
           |                             |
           v                             v
  Optional local LLM              Direct typed commands
  - choose exposed tools          - no model required
  - propose bounded inputs
           |                             |
           +------------+----------------+
                        v
          Tool gateway and trusted policy context
          - schemas, ownership, budgets, permissions
                        |
                        v
             ChemIR and workflow compiler
          - immutable subjects and conditions
          - approved method/template selection
          - input generation and preflight
                        |
                        v
             Resolved plan + human approval
                        |
                        v
          Job runner -> reviewed domain adapters
                        |
                        v
             Result parsing and validators
                        |
                        v
          Evidence store -> comparison -> report
```

### 3.1 Authority boundaries

| Component | Owns | Does not own |
|---|---|---|
| Local model | Intent extraction, candidate proposals, selection among exposed workflows, questions, interpretation drafts | Permissions, scientific result values, final validation states |
| Tool gateway | Input/output validation, registered tool dispatch, authenticated actor context | Chemistry conclusions |
| ChemIR core | Types, units, immutable references, declared semantics, profile constraints | Universal chemical truth |
| Workflow compiler | Template expansion, dependency graph, resource requests, resolved plan | Unbounded autonomous planning |
| Runner | Approved process launch, supervision, cancellation, result collection | Method applicability |
| Domain adapter | Translation to/from one pinned backend interface | Overriding policy or changing the requested method |
| Validator/comparator | Explicit checks, compatibility rules, evidence-derived claims | Certifying experimental truth from a successful computation |
| Human reviewer | Approval of execution and separately recorded scientific review | Retroactively changing immutable run inputs |

The core MUST NOT import the model provider or desktop UI. Chemistry adapters MUST NOT depend on a model. Clients MUST NOT create an alternative validation or approval path.

## 4. Tool registry and capability discovery

### 4.1 Registry design

Create a first-party registry before adding a provider-specific agent framework or MCP server. Each tool definition MUST include:

- Stable tool name and contract version; input and output JSON Schemas.
- Short purpose, explicit non-goals, and at least one positive and negative example.
- Permission set, side effects, workspace access, and network requirements.
- Required adapter and method-profile capabilities.
- Parameter limits, timeout policy, output limits, and cancellation behavior.
- Idempotency/caching policy and structured error codes.
- Definition hash and compatibility-test references.

Use closed schemas with explicit units, enums, bounded arrays, and `additionalProperties: false`. A syntactically valid call is still subject to reference ownership, chemical, permission, and budget checks.

### 4.2 Initial tool surface

The following are target APIs to implement, not existing functions.

| Tool | Purpose | Permissions |
|---|---|---|
| `capabilities_list` | Return installed, tested profiles and their availability states. | Read |
| `schemas_get` | Return one registered tool or workflow schema and compact examples. | Read |
| `project_search` | Search approved project objects and local source records. | Read |
| `object_get` | Read a bounded projection of an immutable object. | Read |
| `structure_import` | Parse a previously ingested artifact into a new representation. | Workspace write |
| `state_create` | Attach an explicitly supplied electronic-state assertion to a new subject revision. | Workspace write |
| `structure_validate` | Run a declared validation profile; create a report. | Workspace write |
| `plan_finite_single_point` | Prepare a fixed finite-system workflow from an existing subject and admitted method profile. | Workspace write |
| `plan_cu_lattice_scan` | Prepare a bounded, fixed-composition copper candidate batch. | Workspace write |
| `workflow_submit` | Request launch of an already resolved plan; the host checks approval. | Compute |
| `job_status` | Read job state and available result references. | Read |
| `job_cancel` | Request cancellation of an owned job. | Owned-job control |
| `results_compare` | Apply a registered comparison profile to compatible results. | Workspace write |
| `evidence_report` | Render a deterministic report from validated evidence and claims. | Workspace write |

Expose only a relevant subset—initially no more than eight tools per model turn. The full registry remains available to the application. Discovery is host-filtered: unavailable or unauthorized actions MUST NOT become available merely because the model requests their schemas.

A tool taking an artifact reference MUST NOT accept arbitrary filesystem paths. File ingestion is a separate explicit user operation. No `execute_python`, `run_shell`, `install_package`, `fetch_any_url`, or unrestricted `write_file` tool exists in the runtime-agent API.

### 4.3 Capability availability

Keep `installed`, `enabled`, `license_reviewed`, `self_test_passed`, and `applicable_to_subject` separate. Return actionable states such as `not_installed`, `disabled_by_policy`, `incompatible_version`, `unreviewed_distribution`, `self_test_failed`, and `unsupported_subject`.

Read-only discovery MUST NOT install software or contact the network. Installation and update actions belong to explicit administrator/developer workflows.

### 4.4 MCP boundary

MCP MAY later expose the same registry; it MUST NOT define a second chemistry core. Its structured tool results and schemas are useful transport mechanisms [R9], not a substitute for application authorization.

Pin and negotiate the implemented protocol revision. Test tool-name mapping, schema compatibility, result conversion, and error propagation. Do not initially accept arbitrary third-party MCP servers. Tool descriptions, annotations, and returned text from an external server are not trusted permission declarations.

## 5. Tool contracts and execution semantics

### 5.1 Host-owned invocation context

The model supplies only a registered tool name and schema-validated arguments. The host supplies actor identity, workspace scope, request correlation, permission grants, approval lookup, and execution budgets.

Do not place trusted fields such as `approved`, `is_admin`, `network_allowed`, or `validation_passed` in model-controlled arguments. The model MUST NOT possess approval secrets or manufacture approval records.

### 5.2 Example input schema

This is a proposed complete parameter schema for `plan_cu_lattice_scan`. The registry also carries its output schema and permission metadata. The numerical limits are intentionally narrow MVP guardrails, not a claim that every admitted configuration is physically reliable.

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "subject_ref",
    "scale_factors",
    "method_profile_id",
    "resource_profile_id"
  ],
  "properties": {
    "subject_ref": {
      "type": "string",
      "minLength": 1,
      "description": "Existing immutable explicit periodic copper subject."
    },
    "scale_factors": {
      "type": "array",
      "minItems": 2,
      "maxItems": 9,
      "uniqueItems": true,
      "items": {
        "type": "number",
        "minimum": 0.95,
        "maximum": 1.05
      },
      "description": "Dimensionless uniform cell scale; preserve fractional coordinates."
    },
    "method_profile_id": {
      "type": "string",
      "enum": ["ase.emt.cu.scan.v1"]
    },
    "resource_profile_id": {
      "type": "string",
      "enum": ["local.smoke.v1"]
    }
  }
}
```

Reference existence, copper-only composition, full site occupancy, cell validity, and actual profile availability are checked by the core. JSON Schema alone does not establish these properties.

### 5.3 Result envelope

Every tool returns a validated envelope containing:

| Field | Requirement |
|---|---|
| `request_id`, `tool_name`, `contract_version` | Host-generated correlation and the actual executed contract. |
| `status` | `succeeded`, `accepted`, `blocked`, `rejected`, or `failed`. |
| `data` | Tool-specific structured payload, validated against its output schema. |
| `diagnostics` | Stable codes, severity, field pointers, explanations, and allowed repair categories. |
| `artifact_refs` | References to immutable detailed outputs; never uncontrolled local paths. |
| `provenance_ref` | Record of tool version, subject/input hashes, profile, and execution context. |
| `summary` | A bounded host-generated projection for model context. |
| `truncated` | Explicit indication that the projection omits data; full artifacts remain available. |

`accepted` means a job was queued; it does not imply a scientific result exists. A successful process may still produce failed scientific validation. Raw backend output MUST NOT become a trusted claim merely by being included in `data`.

### 5.4 Error taxonomy

At minimum implement:

`INVALID_ARGUMENT`, `UNKNOWN_TOOL`, `UNKNOWN_REFERENCE`, `REFERENCE_OUT_OF_SCOPE`, `NEEDS_INPUT`, `UNSUPPORTED_PROFILE`, `BACKEND_UNAVAILABLE`, `LOSS_REQUIRES_REVIEW`, `APPROVAL_REQUIRED`, `APPROVAL_STALE`, `POLICY_DENIED`, `BUDGET_EXCEEDED`, `TIMEOUT`, `BACKEND_FAILED`, `NONCONVERGED`, `INVALID_TOOL_OUTPUT`, `INCOMPARABLE_RESULTS`, and `REPRODUCIBILITY_MISMATCH`.

Separate call-level errors from scientific diagnostics. For example, a parsed backend result may have a successful tool response while carrying `NONCONVERGED` and being excluded from ranking.

Only mechanical repairs may be automatic. Changing charge, spin, method, solvent, composition, scientific tolerances, or accepted information loss requires a new explicit proposal and the corresponding review/approval.

## 6. Local-model integration

### 6.1 Model role and selection

**September 5 implementation update:** The selected local provider is LM Studio
at `http://127.0.0.1:1234`, with model key `google/gemma-4-e2b` (replacing E4B).
The current machine serves Q8_0 through an 8192-token loaded context. The
read/derive proposal controller uses strict JSON actions with host validation;
no native tool-use support is inferred from the model family name. This is a
candidate configuration, not model promotion or a chemistry benchmark pass.

The user explicitly requested an early English UI and real coordinate viewer;
this preview is now implemented ahead of the original desktop sequence. It
does not imply that the M2 execution gateway, M3 computation, M4 evaluated
design loop, or M7 model promotion gates are complete. The next implementation
queue is [Structure Studio roadmap](docs/structure-studio-roadmap.md).

Treat Gemma 4 E2B's instruction-tuned variant as an initial candidate, not a hard dependency or a certified chemistry model. Google's documentation describes function calling and makes clear that the application executes and validates generated calls [R1].

Record the actual model identifier, weight revision/checksum, tokenizer, chat template, quantization, inference runtime version, tool-call parser, and decoding settings. Do not infer serving compatibility from the model name alone. A different quantization or tool-call parser is a distinct evaluation configuration.

Use a provider adapter to normalize model output into either a proposed tool call or a final response. Support native tool calling when tested. A strict JSON action envelope MAY be a fallback; arbitrary generated function text MUST NOT be evaluated as Python.

### 6.2 Bounded controller

Implement a host-owned finite-state controller:

```text
REQUESTED -> CONTEXT_READY -> PROPOSING -> PREFLIGHT
                                      |       |
                                      |       +-> NEEDS_INPUT
                                      |       +-> BLOCKED
                                      v
                              AWAITING_APPROVAL
                                      |
                                      v
                                  EXECUTING
                                      |
                                      v
                                  VALIDATING
                                      |
                                      v
                                   REPORTING -> COMPLETED
```

The model proposes actions; it does not write the authoritative controller state. While awaiting approval or job completion, the host waits on user/job events rather than spending model turns repeatedly polling.

### 6.3 Context policy

Provide a compact task brief, relevant object references, admitted workflow descriptions, current diagnostics, remaining budget, and evidence-backed summaries. Keep large geometries, raw logs, and complete databases out of the prompt unless specifically needed and bounded.

Persist task state in typed records, not in hidden reasoning or an ever-growing chat transcript. Store action arguments, decisions, concise stated rationales, outputs, and model configuration; do not require private chain-of-thought logging.

Initial limits: twelve model tool calls per request, at most two mechanical schema-repair attempts, one active compute job by default, and the candidate count admitted by the selected workflow profile. Count retries and rejected calls. Enforce compute and workspace limits separately from token limits.

### 6.4 Escalation

Escalate when required scientific inputs are missing, no reviewed method applies, semantic repairs are needed, repeated valid-looking calls fail, or results conflict beyond a declared tolerance.

Escalation means requesting user input, stopping with a precise limitation, or using an explicitly enabled stronger local model. Never silently switch to cloud inference. A stronger model receives no additional permissions merely because it is stronger.

### 6.5 Output discipline

Generate authoritative numbers and status statements through deterministic report templates. The model MAY add a separately labeled interpretation draft that cites existing claim IDs.

The report system MUST NOT describe free-form model commentary as validated evidence. A citation existing in the store does not prove that arbitrary prose is entailed by it. Unstructured interpretation remains explicitly unverified unless independently reviewed.

## 7. ChemIR: minimum useful semantics

### 7.1 Object envelope and provenance

Use immutable object envelopes with schema version, object kind, payload, parent references, creation actor, source references, and separate payload/envelope hashes. Updates create new revisions.

Maintain an explicit distinction between **user asserted**, **source imported**, **tool derived**, and **model proposed** information. Toolkit inference MUST NOT overwrite an assertion without a recorded transformation and conflict report.

An original source file is an immutable artifact. Parsed and normalized representations are derived objects. Unknown is not equivalent to zero, an empty list, or an assumed default.

### 7.2 Minimal chemical entities

| Entity | Required ownership boundary |
|---|---|
| `Molecule` | Finite identity/graph representation, atom identifiers, isotopes, declared connectivity and stereochemical information. Not a universal identity key. |
| `Geometry` | Coordinates, units, atom mapping, and a reference to the represented entity. Geometry generation creates a derived object. |
| `ElectronicState` | Distinct finite and periodic profiles; state belongs to the calculation subject, not to a material lot. |
| `ChemicalSubstance` | Identity/specification of a substance, with declared representation and source references. |
| `MaterialLot` | A physical material instance and its source/measurement records. No inference of purity or composition from a structure file. |
| `CoordinationComplex` | Metal/ligand references and explicit coordination or hapticity assertions where represented; preserve unsupported information. |
| `PeriodicStructure` | Cell, species, sites, coordinate convention, periodic boundary flags, and explicit representation mode. |
| `SurfaceSlab` | Derived periodic slab with declared Miller indices, termination, layer count, vacuum extent, and surface normal; construction algorithm and version, parent structure, and loss report are recorded. Not a bulk-equivalent structure or a universal surface model. |
| `AdsorptionComplex` | A slab plus an explicitly placed adsorbate: identity, stoichiometry, binding site, height and orientation, and coverage. Site and coverage are assertions, not inferred defaults. |
| `InterfaceReactionStep` | A declared surface or interface reaction step binding explicit reactant/product subject revisions to referenced energy evaluations. Owns only computed energy differences under a reviewed comparison profile; owns no barrier, rate, or mechanism claim. |
| `CalculationSpec` | Subject, admitted method profile, requested property, conditions, and resource profile. |
| `Evidence` | Source or result artifact, producing activity, method/context, and limitations. |

`ChemicalSubstance`, `MaterialLot`, and `CoordinationComplex` may initially have thin, preservation-oriented schemas. Their existence does not imply inventory management or general coordination-chemistry calculation support.

Keep workflow/control entities separate: `DesignGoal`, `CandidateSet`, `WorkflowPlan`, `ToolInvocation`, `RunRecord`, `ValidationReport`, `LossReport`, `Claim`, and `ApprovalAttestation` are not additional chemistry ontologies.

### 7.3 Electronic-state rules

For the initial finite, all-electron profile, require explicit molecular charge and multiplicity. Check electron count, multiplicity positivity, and parity compatibility. These are consistency checks, not a determination of the ground state. Effective-core-potential, ghost-atom, and other specialized cases require separate profiles rather than reuse of an incompatible rule.

For periodic electronic-structure extensions, represent the selected backend's charge convention, spin treatment, occupations/smearing, and sampling assumptions explicitly. Do not apply finite-molecule multiplicity rules to metallic periodic calculations.

For the classical ASE/EMT MVP, quantum electronic-state fields are `not_applicable`, not silently set to zero charge and singlet. Unsupported electronic-state requirements block calculation readiness.

### 7.4 Explicit, average, and ensemble structures

An explicit atomistic structure, a crystallographic average-occupancy model, an enumerated configuration, a defect event, and an ensemble are different owners of information.

The MVP admits only supported explicit, fully occupied structures for atomistic calculation. Average occupancies and disorder MUST be preserved in source/preservation records and flagged as not calculation-ready. Do not round occupancies, silently choose one disorder configuration, or invent an explicit supercell.

Later conversions require a versioned algorithm, assumptions, atom/site mappings, and a separate derived object. An ensemble result must identify the member set and weighting rule.

### 7.5 Identity, conversions, and loss

Do not use a canonical SMILES string, InChI, or toolkit object as a universal identity authority. Keep explicit identity claims and their representation profiles. RDKit has specific coordination and stereochemistry features [R6]; support must be tested at the precise export/import path rather than assumed for every format.

Every conversion produces a `LossReport`, including an explicit empty report when nothing covered by the tested conversion profile is lost. Entries identify source fields/features, target support, severity, downstream effects, and whether review is required.

Preserve original bytes even when a conversion fails. An unrecognized field is not evidence that it is unimportant. A lossy display export may be acceptable while the same export remains forbidden as a computation input.

### 7.6 Surface and interface representations

A surface slab is always a **derived** object: the transformation from a parent `PeriodicStructure` records the construction algorithm and its version, Miller indices, termination choice, layer count, vacuum extent, any cell reshaping, and the atom/site mapping, and it produces a `LossReport`. A slab without this provenance MUST NOT become a calculation subject.

Surface and interface energies are normalization-sensitive derived claims. Adsorption energies MUST state their reference states (isolated adsorbate or declared reservoir convention), per-adsorbate normalization, and the slab parameters used. Comparisons MUST NOT mix terminations, Miller indices, coverages, slab thicknesses, or vacuum extents without an explicitly reviewed comparability rule.

Termination, slab-thickness, and vacuum-convergence sensitivity are surfaced as review-requiring warnings; one slab configuration is not evidence of convergence with respect to surface model size.

Solid-solid and solid-liquid interface constructions additionally record registry/orientation, imposed strain, and any commensuration assumptions. They are distinct subjects, not composition-preserving variants of one structure.

Interface reaction steps (Section 2.3, Section 10.5) are records over referenced energy evaluations. A step may be described as a computed energy difference under the declared profile. It MUST NOT be promoted to a barrier, a rate, an equilibrium constant, or a catalytic-activity statement; those require separately reviewed transition-state and thermodynamic method profiles that the MVP does not include.

## 8. Reposition `.chem` as a declarative client

### 8.1 MVP decision

Retain `.chem`, but do not make custom-language design the critical path. For `v1alpha1`, use a documented, restricted JSON declaration syntax with source diagnostics. A more concise surface grammar can be introduced later through an RFC without changing the core service API.

A `.chem` declaration specifies imports, explicit state bindings, and registered workflow requests. It contains no loops, executable expressions, shell fragments, embedded Python, network imports, or model-generated backend commands.

### 8.2 Illustrative declaration

The following is the target syntax to implement, not a claim that these commands or fixtures already exist:

```json
{
  "chem_version": "v1alpha1",
  "imports": [
    {
      "name": "water",
      "path": "fixtures/water.xyz",
      "format": "xyz"
    }
  ],
  "state_bindings": [
    {
      "subject": "water",
      "profile": "finite.all_electron.v1",
      "charge": 0,
      "multiplicity": 1
    }
  ],
  "workflows": [
    {
      "template_id": "finite.single_point.v1",
      "subject": "water",
      "method_profile_id": "qcengine.psi4.hf_sto3g.smoke.v1",
      "resource_profile_id": "local.smoke.v1"
    }
  ]
}
```

CLI ingestion resolves permitted source-relative paths, snapshots file bytes, and lowers declarations to the same services used by tool calls. Runtime model tools receive artifact/object references instead of this path access.

Reject duplicate keys and non-finite numeric literals. Diagnostics MUST include JSON pointers and syntax-error line/column positions; richer semantic source spans may follow once the parser supports them reliably.

Identical declared semantics through `.chem`, direct CLI, and tool calls MUST yield the same logical plan hash. With identical resolved environments and inputs, they MUST also yield the same resolved hash.

## 9. Adapters, method profiles, and backend acceptance

### 9.1 Adapter lifecycle

Each adapter implements the following conceptual interface:

```text
probe_environment()           -> CapabilityManifest
check_subject_and_spec()      -> PreflightReport
prepare_inputs()              -> PreparedInputArtifacts
execute_in_approved_runner()   -> RawRunArtifacts
parse_results()               -> TypedResult
validate_results()            -> ValidationReport
```

Actual execution is always mediated by the runner. `prepare_inputs` MUST NOT launch the backend. `probe_environment` is bounded and side-effect-limited. Adapter-specific metadata cannot grant permissions.

Use separate worker processes for native-code parsers and calculators when needed for crash containment and resource accounting. A worker process alone is not a security sandbox.

### 9.2 First two acceptance backends

| Profile | Candidate implementation | Acceptance task | Explicit limitation |
|---|---|---|---|
| `qcengine.psi4.hf_sto3g.smoke.v1` | QCEngine + QCElemental + Psi4 | Fixed-geometry neutral singlet water single-point energy, with pinned settings | Integration test only; no claim of chemically accurate energetics or broad electronic-state support. |
| `ase.emt.cu.scan.v1` | ASE + built-in EMT calculator | Explicit FCC copper energy/force calculation and bounded lattice-scale scan | Copper-only workbench profile; not DFT, not a general inorganic potential, not proof of experimental stability. |

QCEngine documents standardized quantum-chemistry execution and a Psi4 single-point example [R2]. QCSchema is the external interchange target for the supported finite calculation profile, not a replacement for all ChemIR entities [R3]. ASE exposes calculators for energies, forces, and sometimes stress [R4]. Its EMT documentation identifies a limited parameterized element set and explicitly cautions against serious use of certain additional elements [R5]. The workbench therefore narrows the first profile to copper instead of equating parser acceptance with scientific suitability.

These are implementation targets, not backends tested in preparing this document. M0 MUST establish exact versions, licenses, installation routes, and smoke-test outputs. A failed compatibility spike requires an explicit architecture decision—not a silent backend substitution.

Use native Windows for the core/CLI where supported. Prefer a pinned Linux/WSL environment for the first Psi4 acceptance path unless native Windows support is demonstrated for the selected build. Record native, WSL, and container profiles separately; do not advertise one as equivalent to another without testing.

### 9.3 Method profiles

A method profile MUST declare supported subject kinds/elements, property names, charge/spin restrictions, boundary conditions, units, parameter ranges, method/basis/potential sources, scientific limitations, and validation rules.

Resolve defaults explicitly before approval. Backend defaults that influence a result are not allowed to remain hidden. Store exact effective settings, even when the user selected a short named profile.

Do not allow the model to request arbitrary backend keyword dictionaries. Add new keyword support through a reviewed schema/profile change with negative tests.

### 9.4 Deferred adapter catalog

| System | Planned role | Initial disposition |
|---|---|---|
| RDKit / InChI | Tested finite-structure parsing, identifiers, and conversions | Optional parsing/identity adapters; precise feature/loss tests required. |
| pymatgen / CIF | Periodic structure import, inspection, and later analysis | Explicit-structure profile only at first; no blanket crystallographic support claim [R7, R11]. |
| PHREEQC | Aqueous speciation and related calculations | Separate future solution profile [R8]. |
| Transition-state methods (e.g., NEB-class) | Surface/interface reaction barriers, if ever admitted | Out of scope until a separately reviewed barrier profile exists; energy-difference claims only in the interim (Section 7.6, Section 10.5). |
| AiiDA | Optional advanced workflow/HPC integration | Not required by the local MVP [R12]. |
| ORD | Reaction-record exchange | Deferred; do not confuse a reaction record with an executable procedure [R13]. |
| OPTIMADE / NOMAD | Optional external materials data access | Explicit network grants and source snapshots; not runtime dependencies [R14, R15]. |
| XDL / SiLA | Procedure/device interoperability | M10/M11 only, behind independent licensing and safety review [R16, R17]. |

## 10. Required vertical slices

### 10.1 Slice A: finite structure to evidence

Implement a model-free path first:

1. Ingest a checked-in water geometry fixture; retain its byte hash and atom mapping.
2. Attach explicit neutral/singlet finite-state inputs; validate units and profile compatibility.
3. Prepare backend inputs through the admitted finite method profile.
4. Display the resolved plan, limitations, resource budget, and required authorization.
5. Execute through the supervised runner; parse the result and backend convergence information.
6. Generate a typed energy result, validation report, provenance record, and deterministic evidence report.

Missing state information must yield `NEEDS_INPUT`; it must not be inferred from an XYZ file merely because the example is water. Reference numerical values must be generated and reviewed using the pinned backend during implementation, not copied from an unrelated geometry or invented in test code.

### 10.2 Slice B: bounded periodic candidate design

Given a validated, explicit FCC copper fixture, implement this template:

```text
Read fixed parent structure
    -> Validate admitted copper-only profile
    -> Generate requested cell-scale candidates deterministically
    -> Preserve fractional coordinates and atom/site mapping
    -> Prepare all candidate inputs
    -> Freeze batch and compute budget
    -> Obtain approval
    -> Execute candidates
    -> Validate each result independently
    -> Compare admitted potential energies per atom
    -> Report ranking and excluded candidates
```

The initial example requests scale factors `0.98`, `1.00`, and `1.02`. These are fixture parameters, not an asserted optimal search interval.

Record the full parent-to-candidate transformation, including whether coordinates move with the cell. Keep composition, atom count, calculator parameters, and property definition comparable. A result may be described as **lowest calculated energy among the evaluated candidates under this profile**. It MUST NOT be promoted to an experimentally stable phase, a global minimum, or a finite-temperature equilibrium lattice constant.

When all candidates fail, produce a failed comparison with reasons. When some fail, state the surviving population and whether the selection objective remains meaningful; never silently drop failures and imply a complete search.

### 10.3 Slice C: the same workflow through the local agent

The runtime agent locates the copper subject, inspects the admitted capability, requests a bounded plan, explains the preview, and submits only after host authorization. It reads validated comparison evidence and provides a report.

It MUST NOT generate coordinates as long free-form arrays, invent computed energies, select a different potential after failure, or expand the candidate budget without a new proposal.

Acceptance requires logical/resolved hash parity with the corresponding model-free workflow. Token savings are useful, but preserving the same approved semantics is the primary goal.

### 10.4 Iterative design after the MVP

Support adaptive search later as a sequence of immutable candidate batches. A model may propose the next bounded batch based on validated results. Each new batch must satisfy current policy and receive authorization appropriate to its resolved actions.

Do not interpret approval of one fixed batch as approval of every future model-generated candidate. Deterministic numerical optimizers may have their own reviewed bounded workflow profiles; those are not equivalent to an unbounded agent loop.

### 10.5 Deferred slice D: bounded interface reaction energetics

Slice D is a post-MVP extension selected through Section 2.3, implemented only after Slices A and B are stable and admitted through its own RFC and method profile (for example `ase.emt.cu.surface.v1`). It repeats the demonstrated pattern rather than changing it:

```text
Construct/ingest a fixed Cu(111) slab as a derived, provenance-carrying subject
    -> Validate admitted copper-only profile and slab provenance (Section 7.6)
    -> Generate a bounded candidate set: a fixed copper adatom
       at declared sites (for example top, fcc hollow, hcp hollow)
       and bounded heights above those sites
    -> Preserve fractional coordinates, site labels, and atom/site mapping
    -> Prepare all candidate inputs; freeze batch and compute budget
    -> Obtain approval
    -> Execute candidates; validate each result independently
    -> Compare site-resolved adsorption energies per adsorbate
    -> Report site ranking, excluded candidates, and sensitivity warnings
```

The extension introduces its own bounded `plan_*` tool and workflow template through the same registry review; it MUST NOT widen existing tool schemas or the composition admitted by the copper-only profile.

Acceptance mirrors Slices A-C: reference numerical values are generated with the pinned backend during implementation, model-free and agent-driven executions produce identical logical/resolved hashes, and failures and exclusions are reported explicitly.

Scientific boundaries: results are site rankings of computed potential-energy differences for one declared slab under one profile. The slice MUST NOT produce barriers, rate constants, catalytic-activity claims, equilibrium-morphology claims, or statements about reactions involving elements outside the admitted profile. Adsorbates beyond copper-only composition (for example CO) are rejected by applicability checks rather than silently evaluated with cautioned EMT parameters.

## 11. Validation, comparability, and claims

### 11.1 Validation layers

Implement separate checks for transport/schema validity, representation integrity, subject consistency, method applicability, execution integrity, numerical/convergence criteria, and result comparability.

Use `pass`, `warning`, `fail`, `not_checked`, and `not_applicable` where appropriate. A required check that was not run cannot be counted as passed. Warnings identify whether they are display-only, require review, or block a requested downstream operation.

The core owns general invariants. Reviewed adapters provide versioned method-specific validators. A second model saying that a result looks correct is not an independent numerical validation.

### 11.2 Separate result states

Every result/report MUST distinguish:

| Dimension | Example states |
|---|---|
| Execution | `not_run`, `queued`, `running`, `succeeded`, `failed`, `cancelled`, `interrupted` |
| Convergence | `not_reported`, `converged`, `not_converged`, `not_applicable` |
| Applicability | `within_declared_profile`, `outside_declared_profile`, `unknown`, `not_applicable` |
| Validation | `not_checked`, `pass`, `warning`, `fail` |
| Reproducibility | `not_tested`, `matched_within_tolerance`, `mismatch` |
| Scientific review | `unreviewed`, `reviewed`, `rejected` |

`within_declared_profile` means the input meets a declared profile; it is not a guarantee of model accuracy. Human review is an attestation, not a conversion of computed data into experimental fact.

### 11.3 Comparison profiles

Before ranking, check property definition, units, normalization, composition/stoichiometry, method/basis/potential, boundary conditions, and relevant environmental assumptions.

Do not rank different chemical compositions by raw total energy. Reaction/formation energies, chemical potentials, phase diagrams, and finite-temperature free energies require separately reviewed reference-state and thermodynamic workflows.

Store precision/tolerances and define tie behavior. Missing values are not zero. Nonconverged or incompatible values remain visible but are not eligible merely because they are numeric.

### 11.4 Claim DAG

A claim contains a subject, a precisely scoped predicate, typed value where relevant, units, context/method references, evidence references, limitations, and producing activity.

Derived claims form a directed acyclic graph. Reject cycles, missing evidence, and references outside the workspace. Comparison claims depend on the actual eligible results and comparator version. Results depend on concrete inputs and execution records.

Do not collapse a byte-integrity check, a numerically reproduced result, a literature statement, and an experimental measurement into one confidence score. A computed result may be reproducible yet scientifically inappropriate for a different question.

## 12. Hashing, plan resolution, and approval

### 12.1 Distinct hashes

| Hash | Purpose and included content |
|---|---|
| Artifact byte hash | Exact stored bytes for source files, generated input decks, logs, and result artifacts. |
| Semantic object hash | Versioned normalized declared payload and semantically relevant references; excludes presentation and timestamp-only metadata. |
| Logical plan hash | Requested workflow/template, semantic subjects, method-profile semantics, conditions, objective, constraints, and declared budgets. |
| Resolved plan hash | Logical plan plus exact prepared inputs, adapter/backend/environment fingerprints, data/basis/potential hashes, effective settings, validator/policy versions, and execution permissions. |
| Envelope/event hash | Integrity of full immutable records and their audit linkage, including metadata. |

Canonical serialization MUST define units, numeric encoding, key ordering, null handling, and normalization version. Reject NaN/infinity and ambiguous encodings. Do not silently round scientific inputs to obtain a hash match.

A semantic hash is a fingerprint under a declared normalization policy, not a proof that two arbitrary chemical representations are chemically identical. Do not perform universal graph/structure equivalence as part of hashing.

### 12.2 Resolve before authorization

For the MVP's fixed single-point and fixed-batch workflows, generate the complete candidate set and exact input artifacts before approval. Resolve executable/worker identities, environment, relative input/output mappings, resource requests, and permission requirements.

Temporary scratch-directory names and timestamps need not change plan semantics. The permitted workspace/mount policy and generated input content do. Document this distinction in hash fixtures.

If a future workflow has data-dependent steps that cannot be resolved in advance, it requires a separately reviewed bounded-execution policy or a new resolved plan after the preceding result. Do not claim that unknown future input bytes were approved by an earlier exact-input hash.

### 12.3 Approval binding

An execution approval binds the actor, workspace, resolved plan hash, allowed action set, resource ceiling, expiry, and allowed launch/retry count. Approval is distinct from scientific review and from accepting a known representation loss.

At launch, the runner rechecks input and environment fingerprints. Changes to a subject, method, database, potential, executable, adapter, relevant policy, budget, or accepted-loss context invalidate the affected approval.

The runtime model cannot set or renew approval. The host may grant low-risk read/derive operations through an explicit session policy; costly execution remains governed by the resolved-plan authorization.

## 13. Execution security and Windows runner

### 13.1 Permission sets

Permissions are explicit sets, not an automatic inheritance ladder:

- **Read:** bounded reads of admitted workspace objects and registries.
- **Workspace write:** creation of new derived objects and artifacts; no overwrite of source records.
- **Compute:** launch of admitted calculators with approved inputs and budgets.
- **Network:** a separately granted endpoint/data-transfer capability; absent in the MVP runtime.
- **Physical control:** disabled in the MVP, regardless of other permissions.

A chemistry warning cannot authorize process execution. Conversely, operating-system permission cannot certify scientific applicability.

### 13.2 Process and filesystem rules

Launch only reviewed executable/worker identities using argument arrays. Never use a model-controlled command string. Forbid arbitrary shell scripts, interpreter snippets, executable paths, and environment-variable expansion supplied by model arguments.

Stage immutable inputs in a run-specific workspace. Enforce path traversal, symlink/junction, archive extraction, and output-size limits. Use an allowlisted environment without unrelated credentials. Validate output schemas and resource use even for a process that exits successfully.

Pin plugin code as part of the trusted computing base. Do not dynamically load arbitrary Python modules from project files. Bound file sizes, nesting depth, atom counts, and decompression before parsing.

### 13.3 Windows supervision

Use a tested Windows runner for process-tree ownership, cancellation, wall-clock deadlines, memory/CPU limits where enforceable, and scratch cleanup. Job Objects provide process-group management and resource-control facilities [R10]; they are not a complete filesystem/network sandbox.

Ensure a child cannot begin untracked execution before it is assigned to its supervising job. Disallow unreviewed process breakaway. Include tests for cancellation, process-spawn races, and cleanup after parent failure.

For WSL, supervise Linux-side workers within the chosen distribution. Killing the Windows launcher is not the project's proof that Linux descendants stopped. The WSL profile MUST test actual descendant termination and record its own resource/permission controls.

A trusted-backend local profile may explicitly acknowledge weaker isolation. Such a profile MUST NOT be advertised as suitable for hostile or arbitrary code. If required isolation cannot be enforced, return `POLICY_DENIED` rather than claiming it is active.

### 13.4 Prompt injection and data exposure

Treat imported files, database text, logs, and tool-returned narrative as untrusted data. Instructions embedded in these sources cannot modify tool availability, policy, approval, or system prompts.

Do not embed raw logs as high-priority model instructions. Keep a bounded data projection with source references. Protect against oversized output, forged tool messages, malicious filenames, and attempted credential disclosure.

Offline mode is a tested runtime policy, not a marketing label. No automatic telemetry, package/model download, cloud fallback, or external evidence lookup occurs during a workflow. Optional online connectors require explicit endpoint and data-scope approval.

## 14. Storage, caching, recovery, and integrity

Use a local metadata database plus an immutable artifact store. SQLite is the proposed MVP metadata backend; large geometries, input decks, logs, and arrays live in hashed artifact files rather than oversized conversational records.

A project layout should separate:

```text
project/
  sources/          # immutable ingested source artifacts
  objects/          # immutable ChemIR envelopes
  plans/            # logical and resolved plans
  runs/             # run records and raw/parsed outputs
  evidence/         # claims, reports, source records
  artifacts/        # content-addressed blobs
  scratch/          # disposable, run-scoped workspaces
  project.db        # indexes and transactional state
```

The database indexes are rebuildable from authoritative records where practical. Mutable job state transitions occur transactionally, while event history is append-only.

### 14.1 Idempotency and cache rules

Use a host-generated submission idempotency key tied to the user-authorized launch intent. A retry of the same submission must return the same job rather than launch another calculation. An explicitly requested new run receives a new launch intent even when its scientific inputs match.

A cache lookup uses resolved inputs and all result-relevant environment/profile fingerprints. A cache hit references an existing run; it does not claim that a new calculation occurred. Re-evaluate cached results when validator or applicability rules change.

Reproduction is a fresh authorized execution followed by a declared comparison, not a cache hit. Byte-identical artifacts and numerically matching scientific outputs are distinct notions.

### 14.2 Crash recovery

Persist the queued-to-running transition and runner lease atomically. After interruption, reconcile actual process state before any restart. Mark uncertain runs as `interrupted`; never infer successful completion from partial output files.

Retries are bounded and recorded as new attempts. Do not automatically change scientific inputs to obtain convergence. The retry budget is part of authorization.

### 14.3 Packaging integrity

Use a cross-process packaging lock, immutable staging, a single packaging owner, and verification of the final archive/installer against its manifest. Prevent concurrent writers from mixing release artifacts or producing a manifest for different bytes.

Hash-linked local records detect accidental changes and some tampering; they do not provide independent authenticity against a privileged actor able to rewrite the whole store. Stronger signed attestations require explicit key custody and a separate threat model.

## 15. CLI, repository, and client parity

### 15.1 Target command surface

Implement these commands against the same application services. Angle-bracket values below are placeholders, not literal identifiers.

```text
chemwb doctor
chemwb capabilities --json
chemwb import fixtures/water.xyz --format xyz
chemwb validate <OBJECT_REF> --profile finite.all_electron.v1
chemwb compile examples/water_single_point.chem
chemwb plan show <PLAN_REF>
chemwb approve <PLAN_REF>
chemwb run <PLAN_REF>
chemwb status <JOB_REF> --json
chemwb cancel <JOB_REF>
chemwb compare <RESULT_REF_1> <RESULT_REF_2> --profile <PROFILE_ID>
chemwb report <RUN_OR_COMPARISON_REF> --format markdown
chemwb reproduce <RUN_REF>
chemwb agent --model-profile <MODEL_PROFILE_ID>
chemwb benchmark --suite tool_use_v1 --model-profile <MODEL_PROFILE_ID>
```

`compile` and planning do not run a scientific backend. `approve` is a user/client action, not a model tool. `doctor` reports missing components; it does not install them. Machine-readable output MUST use the shared diagnostic model and stable nonzero exit behavior for failed operations.

### 15.2 Proposed repository structure

```text
chem-workbench/
  pyproject.toml
  locks/
  AGENTS.md
  README.md
  src/chem_workbench/
    core/             # ChemIR, units, hashing, diagnostics
    services/         # shared application operations
    tools/            # registry, schemas, gateway
    workflows/        # bounded templates and compiler
    policy/           # grants, approvals, budgets
    runners/          # native Windows, Linux/WSL profiles
    adapters/         # reviewed domain integrations
    validation/       # invariants, readiness, comparisons
    evidence/         # claims, provenance, deterministic reports
    storage/          # records, transactions, artifacts
    agent/            # provider adapter and bounded controller
    language/         # optional .chem front end
    cli/
  schemas/
  profiles/
    methods/
    resources/
    models/
  fixtures/
  examples/
  tests/
    unit/
    property/
    contract/
    integration/
    security/
    model/
    packaging/
  docs/rfcs/
  benchmarks/
  third_party/
```

Use Python with typed models and generated JSON Schemas. Pydantic, Typer, pytest, Hypothesis, Ruff, and mypy are proposed implementation/development dependencies; pin exact compatible versions during M0. Keep heavyweight toolkits and inference providers optional. Avoid a mandatory agent framework in the first release.

Generate schemas, tool documentation, and examples from one contract source where possible. Do not maintain divergent hand-written model schemas and backend validators.

### 15.3 Desktop policy

Defer desktop implementation until the model-free and agent slices pass. The desktop invokes the same services, preserves the same approvals and provenance, and produces hash parity for equivalent input semantics.

Ketcher and 3Dmol.js, if selected later, are clients for editing/viewing particular representations—not chemical identity or validation authorities. Review their pinned versions and licenses before bundling. Editing creates a new object revision and invalidates dependent approval where relevant.

## 16. Tests and model promotion criteria

### 16.1 Chemistry and representation fixtures

Preserve the original fixture set, with intentionally different acceptance expectations:

| Fixture | Positive expectation | Required negative case |
|---|---|---|
| Water | Finite-state binding, geometry preservation, admitted single point | Missing state, inconsistent units, invalid multiplicity, and forced nonconvergence are detected. |
| Chiral molecule | Preserve explicitly represented stereochemical information | A lossy export cannot silently become an equivalent authoritative representation. |
| Ferrocene | Preserve supplied coordination/hapticity information and source bytes | Unsupported representation or calculation readiness is explicit; no silent ordinary-bond rewrite. |
| Silicon | Import/inspect a supported explicit periodic representation | The copper-only EMT workflow rejects silicon. |
| FCC copper | Single-point and bounded scan through the admitted profile | Invalid cell, out-of-range scan, altered composition, and incompatible comparison are blocked. |
| Cu(111) slab and adatom complexes | Derived-slab provenance, site-resolved adsorption-energy comparison within the copper-only EMT profile | Out-of-profile adsorbates (e.g., CO) are rejected; cross-termination, cross-coverage, and cross-thickness comparisons are blocked; a slab without construction provenance is not calculation-ready. |
| Average/disordered CIF | Preserve source and report unsupported explicit-atomistic readiness | Fractional occupancy is not silently rounded or expanded into an invented structure. |

Use genuine, reviewed fixtures with source/license records. CIF is an externally specified crystallographic framework [R7]; passing one parser fixture is not a conformance claim for every CIF dictionary or crystallographic model.

### 16.2 Core and security tests

Unit/property tests MUST cover schema closure, explicit units, immutable revision behavior, source/derived separation, canonicalization, claim DAG acyclicity, comparison ties, missing values, and hash sensitivity.

Contract tests MUST cover unknown tools, extra arguments, malformed/mismatched outputs, references to another workspace, unavailable profiles, duplicate submissions, timeout/cancellation, approval expiry, input/environment changes after approval, and cache-versus-reproduction semantics.

Security tests MUST cover path traversal, junction/symlink escapes, oversized/hostile files, unexpected child processes, interrupted launches, policy-field spoofing, prompt injection inside tool data, attempted package installation, and network activity in offline mode.

Use injected failures and mocks to test orchestration, but label them as mocks. Mock results MUST NEVER satisfy the real-backend acceptance gate or appear as scientific evidence in a normal project.

### 16.3 Initial model evaluation suite

Create an initial 150-task suite:

| Category | Tasks | Main evaluation |
|---|---:|---|
| Admitted complete requests | 40 | Correct workflow, subject, parameters, and evidence-backed completion. |
| Missing or ambiguous inputs | 30 | Appropriate questions or `NEEDS_INPUT`, not invented defaults. |
| Unsupported chemistry/representations | 25 | Correct rejection without scientific or backend substitution. |
| Tool and runtime failures | 20 | Bounded mechanical repair, correct stopping, no hidden retries. |
| Authorization and hostile-data cases | 20 | Policy enforcement and non-execution of injected instructions. |
| Evidence and comparison cases | 15 | Valid provenance, exclusions, units, and appropriately limited claims. |

Separate development and held-out cases by underlying scenario, not just by paraphrasing the same prompt. Repeat stochastic model evaluations and report variation. Keep deterministic golden plans and actual pinned-backend reference outputs independently maintained.

Compare the E2B candidate with a stronger locally deployable instruction-tuned model using identical tools, profiles, hardware accounting, task sets, and budgets. An optional no-tool baseline measures unsupported-answer behavior; it is not an operational benchmark for executing calculations.

### 16.4 Proposed promotion gates

The following are project targets, not measured results:

- At least 95% first-attempt valid tool-call structure and at least 90% end-to-end success on admitted, fully specified held-out tasks.
- At least 95% correct clarification/abstention on cases where the task should not proceed as stated.
- All mandatory deterministic policy, stale-approval, invalid-input, and unsupported-profile regression tests pass.
- Zero unauthorized execution or network transfer in the security suite, and complete provenance for every authoritative numeric claim in the evaluation output.
- Complete logical/resolved hash parity for equivalent model-free and agent-driven acceptance workflows.

Report exact denominators, failure categories, and uncertainty. Zero observed security failures in a finite suite is not proof that no vulnerability exists. Do not publish a generic claim that the model is reliable at inorganic chemistry based on these narrow tasks.

Also measure p50/p95 latency, model and tool time separately, peak RAM/VRAM, token use, repair counts, blocked-call frequency, and compute cost per completed workflow. Test memory contention between local inference and calculators. Advertised model loading memory is not the entire workbench's peak footprint.

If errors concern syntax or consistent argument mapping, improve the contract/examples before fine-tuning. If errors concern method choice, missing physical conditions, or interpretation, narrow the admitted workflow or evaluate a stronger model. Do not relax scientific validators to improve a benchmark score.

## 17. Milestones and exit criteria

Implement milestones in dependency order. A milestone is complete only when its artifacts and tests are committed; a demonstration transcript alone is insufficient.

| Milestone | Scope | Exit criterion |
|---|---|---|
| M0 — Decisions and compatibility | Repository inspection, working names, license decision, runtime choice, exact dependency/backend/model candidates | Version/license records and real read-only/install-isolated compatibility results; unresolved distribution items explicitly blocked. |
| M1 — Core contracts | Minimal ChemIR, diagnostics, units, artifacts, hashes, local store | Schema/immutability/hash tests pass; the core imports without an LLM or heavy backend. |
| M2 — Gateway and policy | Tool registry, trusted invocation context, approval records, budgets, mock runner | Contract and authorization tests pass; model-supplied policy fields cannot authorize anything. |
| M3 — First real vertical slice | Water import, finite profile, supervised QCEngine/Psi4 execution, evidence report | Model-free, real-backend run with traceable inputs/results and tested failures. |
| M4 — Bounded design slice | Explicit periodic import, ASE/EMT copper scan, comparison | Fixed-batch candidate generation, approval, execution, exclusions, and ranking work without an LLM. |
| M5 — Declarative/client parity | Minimal `.chem`, unified CLI, source diagnostics, representation fixtures | Equivalent source/tool/CLI paths share logical/resolved hashes; water/chiral/ferrocene/silicon/copper cases behave as specified. |
| M6 — Local agent | Model adapter, capability-filtered tools, bounded controller, deterministic reports | Both real workflows operate through the agent without bypassing M1–M5 gates. |
| M7 — Evaluation and hardening | Held-out model tests, recovery, Windows/WSL supervision, optional first-party MCP facade | Promotion criteria and platform-specific security/compatibility gates are documented and met. |
| M8 — Release candidate | Locked builds, third-party notices, offline installation path, packaging integrity | Final package verified from immutable staging; advertised optional profiles have passing real-backend acceptance. |
| M9 — Desktop and one domain extension | Shared-core desktop and one separately scoped research workflow (Section 2.3 candidates: structure comparison, aqueous speciation, or surface/interface reaction energetics) | No second chemistry core; client parity retained; extension has its own scientific/profile tests. |
| M10 — Procedure interoperability | Optional XDL-related representation work | Independent license/safety review completed; no assumption of device execution. |
| M11 — Device interoperability | Optional SiLA/device adapter work | Implementation-specific semantics, authorization, interlocks, and supervised operational tests approved. |

M10 and M11 are explicitly outside the MVP and are not prerequisites for a useful tool-first workbench. Do not pull them forward to make a demo appear more autonomous.

## 18. Licensing, dependency review, and distribution

Retain the original outline's conservative release gates:

Record the exact version, license text/source, distribution form, checksum, and review status for every parser, toolkit, backend, calculator, model weight/runtime, pseudopotential, basis-set source, dataset, and UI component. A permissive wrapper license does not establish the redistribution terms of everything it invokes.

RDKit, InChI, ORD, QCElemental, QCEngine, Psi4, pymatgen, AiiDA, ASE, Ketcher, and 3Dmol.js each require review at the exact pinned version before the relevant distribution. Review model weights, tokenizer assets, and scientific data separately from application source code.

ASE calculators and external simulation programs may have licenses different from ASE itself. Separate-process or optional-plugin boundaries are engineering choices, not assumed legal exemptions.

XDL's public implementation MUST NOT be copied, vendored, linked, or distributed before formal review of its AGPL-related and additional repository terms identified in the original outline. This document does not certify those terms or legal compatibility for any particular release. Running XDL in a separate process does not itself settle the question.

Test SiLA compatibility per concrete implementation and version. Protocol conformance alone does not establish identical command meaning, device behavior, or operational safety.

Maintain `third_party/manifest.json`, applicable notices/license texts, scientific data manifests, and model provenance. Unresolved licensing must be visible in the release checklist. Do not claim a redistribution review has been completed because a documentation page was consulted.

## 19. Risks and mitigations

| Risk | Consequence | Required mitigation |
|---|---|---|
| Tool-first becomes a thin wrapper around unrestricted execution | The model still controls arbitrary code | Closed APIs, reviewed templates, no shell/code tool, trusted launch context. |
| Small model selects a plausible but wrong workflow | Valid syntax hides invalid science | Method readiness checks, narrow task admission, held-out workflow evaluation, escalation. |
| Schema/ontology scope expands indefinitely | No usable design loop ships | Freeze minimal entities and two real profiles; defer extensions. |
| Toolkit inference is treated as chemical fact | Corrupted identity and false confidence | Asserted/derived separation, versioned transformations, explicit evidence and warnings. |
| Lossy conversion is invisible | Coordination, stereo, defects, or provenance disappear | Mandatory loss reports and operation-specific review gates. |
| Average and explicit structures are conflated | Invalid atomistic inputs | Separate representation owners; block unsupported readiness. |
| Slab/interface models are treated as representative surface chemistry | Unjustified adsorption, reaction-step, or kinetic claims | Derived-slab provenance as a readiness gate; normalization and comparability rules; termination/size sensitivity warnings; kinetic claims blocked without a reviewed transition-state profile. |
| Backend support is inferred from installation | Unsupported methods or materials are executed | Capability manifests plus subject-specific admitted profiles. |
| Agent changes inputs after approval | User authorized a different calculation | Resolved hashes, immutable inputs, launch-time revalidation. |
| Model-generated prose overstates results | A computed number becomes a claimed discovery | Deterministic authoritative claims; unverified interpretation kept separate. |
| Cache or mocks are mistaken for new computation | False reproducibility and provenance | Explicit source/run identity; fresh-run reproduction; mocks excluded from evidence. |
| Desktop, CLI, and agent diverge | Conflicting plans and audit history | One core and contract source; hash parity as a release gate. |
| Local model and calculator exhaust shared memory | Failed runs and unstable interaction | Combined memory profiling, scheduler reservations, bounded jobs, explicit failure states. |
| Windows/WSL descendants survive cancellation | Budget and trust-boundary violations | Platform-specific supervision tests and Linux-side WSL lifecycle control. |
| Early XDL/device integration creates lock-in | Licensing, safety, and architecture exposure | Defer to M10/M11 under separate review. |
| Concurrent packaging mixes mutable artifacts | Invalid manifests or releases | Cross-process lock, immutable staging, one packaging owner, final verification. |

## 20. Immediate implementation actions

Complete the first cycle in this order:

1. Inspect the actual repository before modifying it. Record which names, modules, tests, and dependency pins already exist. Do not assume this proposed directory layout is the current one.
2. Write `docs/rfcs/RFC-0001-tool-first-core.md`: object envelopes, chemical/material identity boundaries, asserted/derived ownership, immutable references, and minimal ChemIR scope.
3. Write `RFC-0002-tool-contracts-and-policy.md`: registry, schemas, host-owned context, result envelopes, errors, permission sets, and bounded controller responsibilities.
4. Write `RFC-0003-plans-evidence-and-approval.md`: semantic/logical/resolved hashes, claim DAGs, approval binding/invalidation, idempotency, and reproduction semantics.
5. Write `RFC-0004-representation-and-state-profiles.md`: finite/periodic state rules, explicit/average/ensemble ownership, conversion loss, and calculation readiness.
6. Write `RFC-0005-runner-and-backend-acceptance.md`: Windows/native/WSL execution, resource/permission enforcement, first two profiles, licensing records, and platform tests.
7. Run compatibility spikes against real SMILES/InChI/SDF/CIF, QCSchema/QCEngine/Psi4, and ASE fixtures. Pin tested versions and preserve the raw outputs. Unsupported or lossy cases must remain visible.
8. Create the minimal package, schema generation, formatting/type checking, unit/contract tests, and a no-network core CI path. The runtime agent must not perform dependency installation.
9. Implement the immutable store, diagnostic model, tool gateway, and policy tests, then complete the water structure-to-evidence slice without an LLM.
10. Add the explicit copper candidate scan and comparator. Then implement minimal `.chem` parity, integrate the candidate local model, and evaluate it against the same golden workflows.

Do not freeze a schema beta or start desktop implementation before the two model-free slices reveal the actual data and execution requirements.

### 20.1 Coding-agent working rules

Implement one milestone or coherent sub-ticket at a time. Add acceptance tests before broadening supported chemistry. Keep schema changes, profile changes, and documentation/examples synchronized.

Do not fabricate numerical reference outputs, passing tests, installed backend availability, legal clearance, or model benchmark results. A missing optional backend is a reported skip in ordinary core CI, but it is a **failed/incomplete gate** in an acceptance job claiming that backend is supported.

At the end of each coding task, report changed files, commands actually run, tests actually passed/failed/skipped, unresolved limitations, and the next dependency. Use an architecture decision record when deviating from this plan; never quietly replace an unsupported chemistry task with an easier one.

## 21. Definition of done for the tool-first MVP

The MVP is complete when a user can run the finite single-point and bounded copper-design workflows locally, with or without the candidate LLM; inspect and authorize the exact resolved actions; cancel them reliably; and obtain a report backed by real, traceable calculations.

All supported representations and profiles have positive and negative fixtures. Missing state, unsupported chemistry, unavailable tools, nonconvergence, stale approval, and incomparable results produce explicit machine-readable outcomes. No model-generated number becomes authoritative merely because it appears in fluent text.

The package has version/license records, tested installation/platform profiles, an offline runtime path, and a verified release manifest. Desktop, broader inorganic research claims, XDL, and device control are not required for this definition of done.

## 22. Reference standards and primary documentation

Documentation was consulted on September 5, 2026 to identify interfaces and scope. These links are orientation references, not exact dependency pins or legal approvals. Implementation must use documentation/source corresponding to the versions actually selected in M0.

| Reference | Primary source | Relevance |
|---|---|---|
| [R1] | Google: Function calling with Gemma 4 | Model/tool-call integration; application-side execution and validation. |
| [R2] | MolSSI: QCEngine documentation | Quantum-chemistry execution adapter and standardized results. |
| [R3] | MolSSI: QCSchema | Supported finite-calculation interchange contracts. |
| [R4] | ASE: Calculators | Calculator interface boundaries. |
| [R5] | ASE: Pure Python EMT calculator | Parameterized scope and explicit limitations. |
| [R6] | RDKit Book | Representation, coordination, stereochemistry, and toolkit behavior. |
| [R7] | IUCr: Crystallographic Information Framework | CIF definitions, dictionaries, validation, and exchange. |
| [R8] | USGS: PHREEQC Version 3 | Future aqueous-speciation profile. |
| [R9] | Model Context Protocol: Tools | Optional tool transport and structured results. |
| [R10] | Microsoft: Job Objects | Windows process/resource supervision facilities. |
| [R11] | pymatgen | Candidate periodic structure and analysis adapter. |
| [R12] | AiiDA | Deferred advanced workflow integration. |
| [R13] | Open Reaction Database schema | Deferred reaction-record interchange. |
| [R14] | OPTIMADE | Deferred materials-database interoperability. |
| [R15] | NOMAD | Deferred materials-data/provenance integration. |
| [R16] | XDL standard | Deferred procedure representation; separate implementation/license review. |
| [R17] | SiLA standards | Deferred implementation-specific device interoperability. |
| [R18] | InChI extension programme | Identifier scope and extension considerations. |
| [R19] | Psi4 | Candidate finite quantum-chemistry backend. |

[R1]: https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4
[R2]: https://molssi.github.io/QCEngine/dev/
[R3]: https://molssi-qc-schema.readthedocs.io/en/latest/
[R4]: https://docs.ase-lib.org/ase/calculators/calculators.html
[R5]: https://docs.ase-lib.org/ase/calculators/emt.html
[R6]: https://www.rdkit.org/docs/RDKit_Book.html
[R7]: https://www.iucr.org/what-we-do/digital-standards/cif
[R8]: https://www.usgs.gov/software/phreeqc-version-3
[R9]: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
[R10]: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
[R11]: https://pymatgen.org/
[R12]: https://aiida.net/
[R13]: https://github.com/open-reaction-database/ord-schema
[R14]: https://www.optimade.org/
[R15]: https://nomad-lab.eu/nomad-lab/
[R16]: https://croningroup.gitlab.io/chemputer/xdl/standard/
[R17]: https://sila-standard.com/standards/
[R18]: https://www.inchi-trust.org/inchi-extending/
[R19]: https://psicode.org/
