# ADR 0001: Package Name and Pending License

- **Status:** Accepted for naming; license decision pending
- **Date:** 2026-09-02
- **Decision owners:** Project maintainers

## Context

The project needs stable names for its Python distribution, import package, and
command-line entry point before the first compiler modules and tests are added.
It does not yet have an owner-approved software license. Choosing a familiar
license without explicit authorization would grant rights that the project
owner has not granted.

## Decision

Use the following names:

- `chem-workbench` for the Python distribution and project metadata;
- `chem_workbench` for the import package; and
- `chem` for the command-line entry point.

Keep the project license explicitly **PENDING**. Do not create a `LICENSE` file,
add a license classifier, or describe the project as open source until the
project owner selects a license and records a superseding decision.

The absence of a selected project license must not be confused with dependency
or data rights. Every parser, chemistry toolkit, compute backend, bundled data
source, and user-interface component still requires version-specific license
and distribution review.

## Rationale

`chem-workbench` matches the product name and is more specific than `chem` or
`chem-cli`, reducing ambiguity in package indexes and documentation. Python
normalizes hyphens in distribution names while import identifiers require an
underscore, so `chem_workbench` is the corresponding conventional module name.
The short `chem` executable keeps the planned CLI contract readable.

Deferring the license is the only decision that preserves the owner's ability
to choose the applicable terms. Repository access, package installation for
local evaluation, and the presence of source code do not themselves grant
redistribution rights.

## Consequences

- Packaging and documentation must use all three names consistently.
- Users can install the `chem-workbench` distribution and import
  `chem_workbench`; examples invoke `chem`.
- Publication and redistribution remain blocked on an explicit license
  decision and any required third-party notices.
- A future license selection must add the authoritative license text, update
  package metadata and documentation, and supersede the pending portion of this
  ADR.

## Alternatives considered

- **`chem`:** too broad for the distribution name and likely to be ambiguous.
- **`chem-cli`:** describes only the interface, not the planned compiler and
  review workbench.
- **Selecting a common permissive license now:** rejected because no owner
  authorization has been provided.

