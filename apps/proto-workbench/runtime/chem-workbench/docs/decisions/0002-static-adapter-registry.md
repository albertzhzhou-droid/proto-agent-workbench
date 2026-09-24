# ADR 0002: Static Descriptor-Only Adapter Registry

- **Status:** Accepted for `0.1.0a2`
- **Date:** 2026-09-03
- **Decision owners:** Core, adapter, security, and release maintainers

## Context

Chem Workbench needs a stable way to describe adapter identity, format
directions, and conversion loss before it can safely add chemistry toolkits or
execution backends. Runtime plugin discovery would mix three different
questions: whether a descriptor is valid, whether the project trusts and
registers an implementation, and whether that implementation is active for a
specific operation. It would also make capability output depend on mutable
entry points, import paths, installed packages, `PATH`, and host state.

The first adapter slice must establish the data and review boundary without
creating an accidental code-loading or execution path.

## Decision

Version `0.1.0a2` uses a repository-owned, immutable static adapter registry.
The registry shipped in this version contains no adapter registrations.

The slice implements strict, closed, versioned contracts for:

- adapter capability descriptors;
- direction-specific format capability descriptors; and
- conversion loss reports, including an explicit report when no loss is
  observed under a named profile.

Adapter manifests bind a typed `adapter_package_hash`; they cannot self-declare
a trust source. Their list fields are sorted and duplicate-free. Exact manifest
and format-capability hashes live in static registry registration records.

`chem capabilities` emits deterministic JSON for the static registry by
default. `--json` is an alias for `--format json`; `--format text` emits a
human-readable view and cannot be combined with artifact output options. The
command does not scan Python entry points or module paths, import adapter code,
inspect `PATH`, probe installed packages or services, launch a process, or
contact the network. The empty registry is a supported result, not a signal to
search elsewhere.

`chem inspect` may strictly validate and summarize the supported descriptor and
loss-report artifacts. Inspection is read-only and does not register, trust,
activate, import, or invoke the adapter named by an artifact.

Adapter state is evaluated in separate stages:

1. **Schema-valid:** the artifact satisfies its recognized closed schema and
   semantic cross-field checks.
2. **Declared:** the adapter identity occurs in the package-owned registry,
   without proving that the supplied descriptor matches it.
3. **Registered:** the supplied descriptor and typed hash exactly match the
   package-owned static registration.
4. **Trusted:** the exact registration was resolved through that package-owned
   registry.
5. **Active:** the registration is enabled, its implementation status is
   `installed_verified`, and its conformance status is `experimental` or
   `normative`.

No later state follows from an earlier one automatically. In particular, a
schema-valid file supplied by a user is not a registration request and cannot
grant authority.

The `FormatAdapter` protocol describes a bounded future exchange of host-supplied
bytes or ChemIR values and structured results. It grants no filesystem,
network, process, credential, device, compute, workflow, or laboratory
authority. A Python protocol, type annotation, or package boundary is not an
operating-system sandbox. Untrusted implementation code must not run until a
separate containment design is selected and verified.

No conversion is implemented by this decision. `chem convert` remains
unavailable, and the package exposes no dynamic discovery, adapter import,
process, network, compute, workflow, or laboratory path.

With the shipped empty registry, inspecting a valid external adapter
capability, format capability, or loss report returns an undeclared,
unregistered, untrusted, inactive state. A valid loss report has no exact
capability binding and is not publishable; the reason is
`NO_STATIC_REGISTRATION`. The exact registry emitted by `chem capabilities` is
a trusted match to the bundled registry while still containing zero registered
or active adapters.

## Rationale

A static empty registry makes the safety boundary auditable while the contracts
are still evolving. It lets callers validate, inspect, hash, and review the
metadata shape without confusing metadata with operational readiness. It also
makes capability inventory deterministic and prevents the local Python or
executable environment from silently expanding product authority.

Separating general adapter identity from direction-specific format capability
prevents import support from implying export support. Binding classifications
and allowed loss codes to an exact direction ensures that a future adapter
cannot silently discard unsupported chemistry.

## Consequences

- Capability reporting remains stable across machines with different optional
  packages, entry points, executable paths, and network state.
- A new adapter requires an explicit reviewed registry change; installing a
  package cannot activate it.
- The first non-empty registration must bind exact descriptor and
  implementation identity, document applicable trust policy, and pass its
  direction-specific corpus and loss-report tests.
- A future dynamic or third-party adapter mechanism requires a superseding ADR,
  an independently enforced containment boundary, and new trust and
  conformance evidence.
- The descriptor contracts can evolve without prematurely committing to a
  compute runner or network connector.

## Alternatives considered

- **Python entry-point discovery:** rejected because installation state would
  mutate the capability surface and require importing or trusting third-party
  metadata paths.
- **Directory or `PYTHONPATH` scanning:** rejected because search order, path
  aliasing, and user-writable locations are not a stable trust root.
- **Importing each adapter to ask for capabilities:** rejected because
  capability inspection must not execute adapter code.
- **Shipping an example adapter as active:** rejected because no real format
  direction has yet passed its pinned conformance and loss corpus.
- **Treating schema validation as activation:** rejected because structural
  validity does not establish origin, integrity, registration, implementation
  presence, containment, or scientific conformance.

## References

- [RFC-0001](../rfcs/RFC-0001.md)
- [RFC-0005](../rfcs/RFC-0005.md)
- [Chem Workbench Architecture](../architecture.md)
- [Alpha Implementation Status](../implementation-status.md)
