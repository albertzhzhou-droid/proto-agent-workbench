# Chemical Data operators

The Chemical Data section uses six bounded operators in
`apps/proto-workbench/runtime/chem-integration/chem_data.py`. Computation and
Chat use the same registered implementations. Every operation returns structured
tables, method definitions and warnings; the host persists the original request,
result and provenance. The operators do not fetch databases, execute user code,
modify source documents or control laboratory equipment.

## Capabilities and definitions

| Operator | Inputs and calculation | Interpretation |
| --- | --- | --- |
| `prepare_molecular_dataset` | 1–256 identified SMILES records; canonical isomeric SMILES, formula, charge, molecular weight, exact mass, logP, TPSA, HBD/HBA, rotatable bonds and heavy atoms; duplicate identity report | Invalid rows and original SMILES remain in the result. Duplicate record IDs are rejected. Identity is scoped to the recorded RDKit version and chosen salt policy. |
| `search_substructures` | SMARTS matching with explicit chirality option; exact atom-index lists, match limits and invalid-row report | Zero-based indices refer to parsing the returned canonical SMILES, in query-atom order. A truncated result is a lower bound on match count. |
| `cluster_molecules` | Morgan bit fingerprints, Tanimoto distances and Butina clustering with neighbor reordering; one actual centroid record per cluster | A cluster threshold is relative to its centroid, not every pair of members. Representatives provide cluster coverage; they are not a claim of globally optimal diversity or biological activity. |
| `formula_properties` | Integer formulas, nested parentheses/brackets, hydrates and explicit `[13C]` isotope labels; composition, mass fractions, average molar mass and exact mass | Unspecified elements use natural-abundance weights for molar mass and their most abundant isotope for exact mass. Explicit isotope masses override those choices. |
| `balance_equation` | Explicit reactant/product formula and charge objects; exact rational nullspace of element/isotope/charge conservation matrix | Requires exactly one strictly positive balance; returns its primitive integer coefficients and zero residuals. Missing, ambiguous, duplicate and spectator species are rejected. |
| `solution_calculator` | Mass/amount/concentration conversion and conserved-solute dilution with declared units | Preserves input quantities and formulas. Final solution volume is explicit; solvent-volume additivity, density, activity and dissociation are not inferred. |

### Molecular identity

Salt treatment defaults to `preserve`. The alternatives are
`reject_multicomponent` and `largest_fragment`. Largest-fragment selection sorts
by heavy-atom count, then molecular weight, then canonical SMILES, and reports
each removed fragment. It does not silently prefer an organic fragment, uncharge
ions or normalize tautomers. Atom-map labels are excluded from identity while
the original mapped input remains available. Stereo, isotope and formal-charge
information is retained. SMILES names/CXSMILES extensions and wildcard atoms are
not accepted as specified molecular identities.

Descriptor definitions are RDKit `Descriptors.MolWt`, `ExactMolWt`, Wildman–Crippen
`MolLogP`, `CalcTPSA(includeSandP=False)`, `Lipinski.NumHDonors`,
`Lipinski.NumHAcceptors` and `Lipinski.NumRotatableBonds`. In particular, the
reported HBD/HBA values use RDKit's pharmacophore counts. No drug-likeness or
experimental property claim is derived from them.

The clustering defaults are Morgan radius 2, 2048 bits, chirality included and
Tanimoto similarity threshold 0.55. The exact configuration is retained in the
result. Invalid records remain visible and do not enter the distance matrix.

### Formula, isotope and charge conventions

The formula parser is a new local adapter. It accepts `K4[Fe(CN)6]`,
`CuSO4·5H2O`, `CuSO4.5H2O` and `[13C]H4`. Counts must be positive integers;
charges are supplied separately. Fractional site occupancies, phase annotations,
wildcard atoms, suffix charges and fractional compositions are rejected.
The dot character separates hydrate components. The parser limits nesting to
12 groups and the total atom count to 1,000,000.

Average molar mass omits electron mass. Exact mass subtracts
`formal_charge * 0.000548579909065 Da`; mass-to-charge is reported for nonzero
charge. This value uses the most abundant isotope for each unspecified element,
not a fitted isotope envelope. Actual isotope abundances are not inferred.

Equation balancing includes a row for every element, each explicit isotope label
and formal charge. Neutral formula text must be supplied separately from charge,
for example `{"formula":"Fe","charge":3}`. An electron is
`{"formula":"e","charge":-1}`. A one-dimensional rational nullspace is
converted to the smallest positive integer vector. All declared species must
participate on their declared side. Element and charge balance establish a
stoichiometric identity, not feasibility or a mechanism.

### Quantity conventions

Amount mode requires a formula and exactly one of mass, moles or concentration;
concentration additionally requires volume. The returned equations are
`n = m / M` and `c = n / V`. Dilution mode requires stock concentration, target
concentration and final volume; it applies `c1 V1 = c2 V2`. Targets above the
stock concentration are rejected. It returns stock volume and conserved solute
amount, without treating final volume minus stock volume as a proven solvent
volume.

Supported units are g/mg/ug/kg, L/mL/uL, mol/mmol/umol/nmol and
mol/L, mmol/L, umol/L, nmol/L. Values must be finite, at most 1e12 in the supplied
unit and, when nonzero, at least 1e-24 in canonical units. This lower numerical
bound prevents underflow and non-finite divisions. Unknown units are rejected.

## Source provenance

The existing local OpenScience checkout was inspected at commit
`ef6156f8fe5a1e40bd7889707e7abdba9ea1da80`. Its application license is
Apache-2.0. Skill and library licenses have separate scopes:

| Inspected source at that commit | SHA-256 | Use |
| --- | --- | --- |
| `backend/cli/skills/chemistry/rdkit/SKILL.md` | `00bde981ae3d53f2688bc990d47597c706c60b0bfe727f3b1d7474a821f7a6aa` | Morgan/Tanimoto, Butina and SMARTS procedure references. Metadata credits K-Dense Scientific Agent Skills, MIT upstream. |
| `backend/cli/skills/chemistry/rdkit/scripts/molecular_properties.py` | `35da14c86329a6d58243acd5bf027aa8f493fecbc56b5e56b639b532d4dfbb5d` | Batch descriptor workflow reference; this adapter additionally retains invalid rows and explicit identity transformations. |
| `backend/cli/skills/chemistry/cheminformatics-definitions/SKILL.md` | `6b1659a391bcaf9440add993b74adce4aea49b9d526e1ed81c9fa66ddfca02f9` | Descriptor definitions, salt/charge treatment, isotope/stereo retention and version-scoped identity. Synthetic Sciences, MIT. |

The underlying algorithms are provided by RDKit (BSD-3-Clause) and SymPy
(3-clause BSD). The formula parser, exact stoichiometric wrapper and unit adapter
are new local implementations, not algorithms claimed to originate in
OpenScience. No third-party implementation source was vendored into these
operators. The existing runtime contained RDKit 2026.3.6 and SymPy 1.14.0.
ChemPy was checked and is not installed; it is not advertised as a backend.
Pymatgen's composition API was reviewed, but it is not used in these six
operators because their formula scope requires explicit integer/isotope/charge
rejection behavior. No new package was installed.

Primary references:

- [Pinned OpenScience chemistry procedures](https://github.com/synthetic-sciences/openscience/tree/ef6156f8fe5a1e40bd7889707e7abdba9ea1da80/backend/cli/skills/chemistry).
- [RDKit Python guide](https://www.rdkit.org/docs/GettingStartedInPython.html), [fingerprint generators](https://www.rdkit.org/docs/source/rdkit.Chem.rdFingerprintGenerator.html), [Butina](https://www.rdkit.org/docs/source/rdkit.ML.Cluster.Butina.html) and [periodic table API](https://www.rdkit.org/docs/source/rdkit.Chem.rdchem.html#rdkit.Chem.rdchem.PeriodicTable).
- [SymPy exact matrix nullspace](https://docs.sympy.org/latest/modules/matrices/matrices.html#sympy.matrices.matrixbase.MatrixBase.nullspace).
- [Pymatgen composition API](https://pymatgen.org/pymatgen.core.html#pymatgen.core.composition.Composition), reviewed but not called here.
- [RDKit license](https://github.com/rdkit/rdkit/blob/master/license.txt), [SymPy license](https://github.com/sympy/sympy/blob/master/LICENSE), [OpenScience license](https://github.com/synthetic-sciences/openscience/blob/main/LICENSE).

## Verification

`apps/proto-workbench/tests/test_chem_data.py` runs actual RDKit and SymPy
calculations. It checks all six examples and JSON schemas, salt/charge/stereo/
isotope preservation, retained invalid rows, duplicate IDs, exact SMARTS indices,
chirality and truncation, real centroid membership, hydration/group parsing,
isotope and ion mass shifts, primitive coefficients, ionic/electron conservation,
ambiguous balances and unit/dilution identities. It also checks rejection of
non-finite values, unknown units and extreme underflow inputs.

The generated receipt is `build/chem-data-qa/acceptance.json`; it contains the
actual example results, dependency versions and test counts. This receipt proves
the local operator calculations and contracts. UI, Chat and desktop integration
are validated separately by the host acceptance run.
