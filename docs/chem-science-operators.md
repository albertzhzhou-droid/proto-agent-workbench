# Chemistry scientific operators

The Chem Computation workspace and both Chat editions share one set of chemistry
operators. The Python worker is `apps/proto-workbench/runtime/chem-integration/chem_science.py`;
its input schemas and examples are returned by the live `catalog` operation.
The TypeScript data contract is `src/shared/chem-science.ts`. The host owns run
history, cancellation, input/result hashing and saved artifacts; the worker does
not write files or execute supplied code. See [the tool bridge](chem-science-tools.md).

## Implemented operators

The shared catalog now contains 21 operators. Analysis, Statistics and Chemical
Data add the following 11 to the original simulation and design tools. See
[the computation workspace](chem-computation-analysis.md),
[analytical methods](chem-analysis-methods.md) and
[chemical data methods](chem-data-methods.md) for sources and numerical limits.

| Workspace | New operators |
| --- | --- |
| Analysis | `fit_calibration_curve`, `analyze_spectrum`, `chemical_pca` |
| Statistics | `summarize_replicates`, `compare_assay_groups` |
| Chemical Data | `prepare_molecular_dataset`, `search_substructures`, `cluster_molecules`, `formula_properties`, `balance_equation`, `solution_calculator` |

| Operator | Calculation | Important interpretation |
| --- | --- | --- |
| `simulate_reaction_network` | General mass-action stoichiometric ODE, LSODA integration, concentration/rate/conversion series, composition and null-space conservation checks | User supplies the mechanism and rate constants; the solver does not discover them. |
| `scan_reaction_temperature` | Independent ODE solutions at 2–16 temperatures, using supplied Arrhenius activation energies | A missing activation energy means temperature-independent kinetics. |
| `fit_reaction_rates` | Bounded nonlinear least squares for 1–4 positive rate constants against time-series observations | Reports convergence, residual RMSE, Jacobian rank and conditioning; no confidence-interval or global identifiability claim. |
| `analyze_molecule` | SMILES parsing, formula, 17 descriptors including QED, explicit Lipinski criteria, seeded ETKDGv3 conformer, MMFF94/UFF relaxation where parameters exist | Generated conformers and descriptor heuristics do not establish experimental geometry, activity or safety. |
| `compare_molecules` | Morgan radius-2/2048-bit Tanimoto, Murcko scaffolds, bounded maximum common substructure, descriptor changes | Similarity is structural; acyclic empty scaffolds do not establish preservation. |
| `inspect_reaction_smiles` | Reactant/product composition and formal-charge balance, existing atom-map consistency, mapped bond changes, structures on each side | Inspects supplied maps; it does not predict atom mapping, reaction feasibility or transition states. |
| `parse_xyz_trajectory` | Multi-frame XYZ parser with stable element order, source hash and explicit frame interval | Preserves supplied coordinates; it does not infer or validate the source simulation. |
| `organic_candidates` | Original Chem scaffold substitution, descriptors, filters and ranking | Calls the immutable source snapshot; no descriptor-derived reaction rates. |
| `inorganic_candidates` | Original ordered double-perovskite construction and ionic geometry screen | No new phase-stability or electronic-property claim. |
| `simulate_interface` | Original candidate-bound electrode/electrolyte, catalyst/reactant and solid/liquid models | Original illustrative/supplied parameter provenance remains attached. |

## Model and numerical conventions

For stoichiometric matrix S, the worker integrates `dc/dt = S v`, with
`v_j = k_j(T) product_i c_i^a_ij`. Concentrations are mol/L and time is seconds;
the rate-constant unit is `(mol/L)^(1-order)/s`. Bound sites in abstract catalyst
and surface examples use the same volume basis, so their conserved site pool
has a consistent unit. These are well-mixed, closed, isothermal, constant-volume
models. Transport, explicit solvent, diffusion fields and changing volume are
not included.

The temperature correction is `k(T) = k_ref exp[-Ea/R (1/T - 1/Tref)]`, with
activation energy in J/mol. Rate fitting fits constants at the observation
temperature and writes that temperature back as the fitted reference temperature.
It keeps positive rates by optimizing their logarithms, scales residuals by the
maximum concentration of each measured species, and reports the rank and
condition of the residual Jacobian.

SciPy `solve_ivp(method="LSODA", rtol=1e-8, atol=1e-11)` integrates the model.
The worker rejects non-finite results and negative concentrations beyond the
declared numerical tolerance; very small numerical undershoots are clipped and
the minimum raw concentration is retained. Stoichiometric left-null-space
invariants are reported independently of elemental composition. When every
species has SMILES or a declared composition, the worker checks atom/charge or
declared moiety balance before solving and returns conservation curves. With
incomplete compositions, chemical balance is `null`, not a false success.
Composition keys such as `site` and `substrate` describe abstract conserved
moieties, not elements.

Examples cover reversible, consecutive, parallel, catalytic and surface-site
networks. All example mechanisms and rate constants are explicitly synthetic.
The isomer examples use actual C3H8O molecular graphs only to provide geometries
and a consistent composition; the chosen interconversion steps do not claim an
actual chemical mechanism.

## Meaning of the 3D reaction scene

The reaction result includes concentration samples, a molecular graph and one
generated conformer per SMILES species. The viewer scales illustrative molecule
populations with the ODE concentration at the selected time. This connects the
visible scene and the kinetic charts to the same calculation.

It is **a population-based spatial illustration**, not a molecular-dynamics or
transition-state trajectory. No collision paths or atomic forces are inferred
from rate equations. Species without a molecular graph use abstract symbols.
The separate XYZ operator accepts actual user-supplied trajectories, preserves
their coordinates and records their source hash. XYZ does not carry bond
topology, so any viewer connectivity inference remains display-only.

## Open-source provenance

OpenScience was inspected at commit
`ef6156f8fe5a1e40bd7889707e7abdba9ea1da80` in the existing local research checkout.
The following public scripts informed the adapted procedures:

| Source at the pinned OpenScience commit | SHA-256 | Adaptation |
| --- | --- | --- |
| `backend/cli/skills/chemistry/rdkit/scripts/molecular_properties.py` | `35da14c86329a6d58243acd5bf027aa8f493fecbc56b5e56b639b532d4dfbb5d` | Molecular descriptor workflow, explicit Lipinski criteria and QED. |
| `backend/cli/skills/chemistry/smiles-validation/scripts/validate.py` | `a60ccfd2cb195cd50161c8f881ba9cb13d7d693472cc3268756ed7014937ea9c` | Parse validation, Morgan similarity, Murcko scaffolds and bounded MCS. |
| `backend/cli/skills/chemistry/molecule-visualization/scripts/render_3d.py` | `8486128fe1c73bedbc1625674562a7ad2e09a4e2cb5a5c8038bfbbff584166e5` | Hydrogen expansion, seeded ETKDG embedding and local force-field relaxation. |

The new worker uses typed JSON results, explicit numerical units, local rendering
and bound input sizes. It does not copy OpenScience's CDN HTML generator,
file-writing CLI, ambiguous similarity-based design classification, or silently
substitute a 2D drawing for failed 3D embedding. The network ODE and fit wrapper
are new local adapters around SciPy, **not algorithms claimed to come from
OpenScience**. The unified Chat research workflow already carries the separate
OpenScience planning, trace, deduplication and result-storage adaptations.

Licenses have distinct scopes: the OpenScience application is Apache-2.0; the
RDKit skill's upstream metadata identifies K-Dense Scientific Agent Skills under
MIT; the inspected SMILES validation and molecular visualization skill metadata
declare MIT and Synthetic Sciences authorship. RDKit and SciPy runtime libraries
are BSD-3-Clause. Existing Chem source is MIT and remains an unchanged snapshot
with manifest hash
`4fab5293651958bc7763b74f510d341e2f5951538a77546b611735d6d95f655d`.
Legacy operators verify every snapshot file against that manifest before use.
No new chemistry package was installed for this change; the configured local
Chem Python environment already contained the required libraries. This does
not establish clean-machine installer availability.

Primary references:

- [OpenScience repository and license](https://github.com/synthetic-sciences/openscience).
- [Pinned OpenScience chemistry skills](https://github.com/synthetic-sciences/openscience/tree/ef6156f8fe5a1e40bd7889707e7abdba9ea1da80/backend/cli/skills/chemistry).
- [K-Dense Scientific Agent Skills license](https://github.com/K-Dense-AI/scientific-agent-skills/blob/main/LICENSE.md).
- [RDKit Python guide](https://www.rdkit.org/docs/GettingStartedInPython.html) and [license](https://github.com/rdkit/rdkit/blob/master/license.txt).
- [SciPy solve_ivp](https://docs.scipy.org/doc/scipy/reference/generated/scipy.integrate.solve_ivp.html), [least_squares](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.least_squares.html), and [license](https://github.com/scipy/scipy/blob/main/LICENSE.txt).

## Verification

Run the actual installed scientific runtime:

```powershell
& '../Chem CLI/.venv/Scripts/python.exe' apps/proto-workbench/tests/test_chem_science.py
```

The focused suite checks first-order and reversible analytical solutions,
consecutive intermediates, parallel branching, catalyst/site conservation,
Arrhenius scaling, fitting separately generated analytical observations,
deterministic 3D geometry, molecular similarity, explicit mapped hydrogen
preservation, reaction imbalance, XYZ identity consistency, invalid inputs,
every live operator's example, and the subprocess JSON protocol. Evidence is
saved to `build/chem-science-qa/numerical-acceptance.json`.

The verified runtime was Python 3.13.3, NumPy 2.5.2, SciPy 1.18.1, RDKit 2026.3.6,
pymatgen 2026.5.4 and ASE 3.29.0. Numerical acceptance does not claim empirical
validation of synthetic reaction mechanisms, a successful local-model benchmark,
or native installer acceptance; those require their own evidence.
