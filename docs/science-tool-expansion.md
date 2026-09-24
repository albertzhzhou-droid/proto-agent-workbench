# Chemistry and biology tool expansion

The September 19, 2026 extension adds four chemistry operators and five native
biological methods. Chem now exposes 25 fixed operators; Proto exposes 124
methods in 16 collections: 109 Biomni adaptations and 15 native companions.
Availability is read from the selected local runtime. No new package installation
is needed by these nine methods in the configured development environments.

## Chemical computation

| Operator | Inputs and result | Method boundary |
| --- | --- | --- |
| `fit_adsorption_isotherm` | Equilibrium concentration/loading observations with explicit units; Langmuir or Freundlich coefficients, fitted curve, residuals and numerical diagnostics | Original-scale, uniform-residual nonlinear least squares. Freundlich `n` is the exponent in `q = K_F c^n`. At least five observations and four distinct positive concentrations. |
| `analyze_vanthoff_equilibrium` | Kelvin temperatures and dimensionless equilibrium constants; enthalpy in J/mol, entropy in J/(mol K), standard errors and ln(K) plot | OLS under constant enthalpy/entropy and a consistent standard state. Constant responses have zero OLS residual variance. |
| `calculate_acid_base_speciation` | Sequential pKa values, pH values and fully protonated charge; species fractions and mean charge | Ideal dilute polyprotic equilibrium, normalized with log-sum-exp. Does not solve pH from bulk concentrations or include coupled metal equilibria. |
| `fit_electrochemical_impedance` | Frequencies in Hz, real and imaginary impedance in ohms; fitted series/transfer resistance and capacitance in F, Nyquist curve and complex residuals | Declared `R_s + (R_ct parallel C)` topology. Capacitive input uses negative Im(Z). Uniform or modulus-weighted residuals; no CPE, diffusion or Kramers–Kronig validation. |

Existing Analysis, Statistics and Chemical Data capabilities remain available:
calibration and dilution correction, spectra/chromatogram processing, descriptor
PCA, replicate summaries, paired/Welch group comparisons, molecular datasets,
SMARTS search, molecular clustering, formula properties, exact equation balancing
and solution arithmetic. The kinetics, molecule, trajectory, candidate and
interface operators share the same catalog.

Chem uses Proto's card-library and input/output desk layout. Horizontal collection
tabs filter the catalog; Results, Run inputs and Provenance use accessible keyboard
navigation. Drafts and saved results are kept per operator. Charts retain supplied
units and provide CSV/SVG exports; tables provide CSV and complete results JSON.
The reaction-network card opens the existing simulator with its spatial view.

## Native biology companions

| Operator | Capability and assumptions |
| --- | --- |
| `analyze_qpcr_relative_expression` | Technical Ct replicates are averaged within each named biological sample; reports delta Ct, delta-delta Ct and `2^-ddCt`. Assumes stable reference expression and approximately equal doubling efficiencies. |
| `normalize_gene_expression_counts` | Explicit gene-by-sample integer counts to CPM, TPM or RPKM, with effective lengths where required. Reports library totals; zero-count libraries are rejected. This is abundance normalization, not differential expression. |
| `analyze_ecological_diversity` | Shannon in nats, Simpson diversity, Pielou evenness and pairwise Bray–Curtis on declared counts or relative abundance. Empty communities remain undefined. |
| `analyze_protein_physicochemistry` | Biopython ProtParam mass, bounded pI estimate, hydropathy, aromaticity, extinction, composition and charge versus pH for the 20 standard residues. Free termini and no modifications. |
| `analyze_sequence_composition` | GC fraction/skew, unknown bases, CpG O/E and explicit zero-based half-open windows. N bases are excluded from GC denominators and adjacent-pair counts. No functional annotation is inferred. |

These tools appear in Proto's Biology collection, **Expression, diversity &
molecular profiles**. Chat discovers their schema through `compute.catalog` and
executes the same runtime through `compute.run`. Chemistry IDs and `chem.*` aliases
resolve to one canonical implementation shared by both Chat entry points.

The Vite source UI on loopback now uses the real MCP catalog and computation
service for arbitrary supported inputs, retaining workspace input/result/manifest
artifacts. Host, Origin, request schema, module enablement and artifact containment
are checked. A separately served static preview retains clearly labelled recorded
examples and refuses altered input; it does not claim live computation.

## Sources and attribution

The new physical-chemistry adapters are independently written NumPy/SciPy code.
The public [pyGAPS fitting workflow](https://pygaps.readthedocs.io/en/master/manual/modelling.html)
and [impedance.py fitting reference](https://impedancepy.readthedocs.io/en/latest/faq.html)
were studied as method references; neither whole package was ported or installed.
Thermodynamic interpretation follows the
[IUPAC equilibrium definition](https://goldbook.iupac.org/terms/view/C01023).

The biology implementations reference
[Livak and Schmittgen, 2001](https://pubmed.ncbi.nlm.nih.gov/11846609/),
[Wagner et al., 2012](https://pubmed.ncbi.nlm.nih.gov/22872506/),
[scikit-bio's Shannon definition](https://scikit.bio/docs/latest/generated/skbio.diversity.alpha.shannon.html),
and [Biopython ProtParam](https://biopython.org/docs/latest/api/Bio.SeqUtils.ProtParam.html).
Biopython is called directly; scikit-bio is a reference, not a required runtime.
Method references are included in new biology manifests. Native runs no longer
attribute their implementation to a Biomni commit.

The existing OpenScience workflow adaptation remains pinned to
`ef6156f8fe5a1e40bd7889707e7abdba9ea1da80`. Canonical discovery, tool execution,
context handling and artifacts reuse the existing shared Chat bridge. These new
fixed numerical methods are not presented as an OpenScience engine port. The
imported Chem snapshot remains immutable.

## Local verification

- 74 chemistry Python tests pass in Chem's complete scientific environment.
- 136 Proto computation and CLI Python tests pass, including the five new biological methods.
- 23 focused Node tests pass, including all 15 newly added analysis/data/physical
  chemistry methods through canonical Chat discovery and artifact readback.
- Live loopback checks execute all nine new tools, validate custom input results,
  input snapshots and result hashes, and reject disabled, cross-origin and invalid
  requests. Evidence: `build/science-expansion/live-endpoints.json`.
- Independent numerical expectations cover known Langmuir/Freundlich parameters,
  thermodynamic coefficients, species fraction conservation, complex RC units,
  qPCR fold changes, normalization sums, diversity, peptide mass and DNA windows.

Evidence and build logs are stored under `build/science-expansion/`. These are
local software checks, not experimental validation or installer acceptance.

### Model and UI observations

The exact LM Studio `unsloth/qwen3.8-27b` Q4_K_M baseline completed a real
Chem/Proto Chat run. It discovered and executed acid-base speciation and qPCR,
returning fractions 0.5/0.5 and relative expression 4 with saved artifact paths.
One invalid catalog query was recovered. The final prose introduced an unsupported
H2A species label for a one-pKa input; the numerical tool result itself does not
assign a molecular formula. This is a tool-connectivity acceptance, not scientific
validation or model promotion. The full trace is `build/science-expansion/chat-expansion.json`.

Browser checks covered light and dark themes, a 900 by 760 viewport with no
document horizontal overflow, collection/result keyboard navigation, draft
preservation, saved input immutability, history reopening, invalid input feedback,
single-point charts and real edited-input TPM computation. An existing formatting-only
stale-result warning was fixed and regression-tested. The saved manifest read
endpoint was verified byte-for-byte; the in-app browser did not surface a download
event to the automation API.

A packaged CLI check revealed that compute commands calculated a result but fell
through into the unknown-command handler. Both catalog and run now return their
JSON and exit status immediately, covered by two CLI regressions.

### Final build checks

The rebuilt admin CLI and desktop MCP sidecars both expose 124 methods and
execute all five new biology methods. `pnpm typecheck` and `pnpm build:desktop`
pass. All 16 module resources verify against manifest SHA-256
`1652c5ecdc69f9f7fa435d1ef781b3bc21890adc2703e10f72e2923e56d45b7b`. The original 254-file Chem
snapshot still matches its preserved manifest. Final receipt:
`build/science-expansion/acceptance.json`. No installer was produced in this pass.
