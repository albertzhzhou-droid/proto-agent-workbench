# Reaction studies in Chem Compute

The 2026-09-19 extension adds eight canonical `chemistry.*` operators (with
`chem.*` aliases), bringing the Chem catalog to 38. The Reaction simulator now
has Reaction networks, Interface reactions, Mechanisms, Reactors and Kinetic
analysis. All operators also remain available in Analysis and shared Chat.
The later [coupled-reaction extension](chem-coupled-reactions.md) adds six more,
bringing that catalog to 44 and Reaction Sim to 23 methods, including
nonisothermal energy balances and spatial transport profiles. The isothermal
scope below describes the original eight operators only.
The subsequent [driven-reaction extension](chem-driven-reactions.md) reached
50 catalog entries and 29 Reaction Sim methods. The latest
[network and nonideal-reactor extension](chem-network-reactors.md) brings the
current totals to **56 catalog entries and 35 Reaction Sim methods**.

## Scope and equations

These are independent local NumPy/SciPy implementations. They reuse the existing
network parser, composition checks, stoichiometry and Arrhenius convention. No
Cantera engine, thermochemical mechanism database, instrument or upstream source
code is installed or invoked by this extension. The imported Chem snapshot is
unchanged. Coefficients in examples are illustrative, not measured mechanisms.

| Operator | Calculation | Important assumptions |
| --- | --- | --- |
| `simulate_reversible_chain` | A ⇌ B ⇌ C, four elementary fluxes, two net fluxes, kinetic equilibrium and two relaxation times | Positive first-order coefficients; supplied kinetic ratios, no thermochemical equilibrium database |
| `simulate_catalytic_cycle` | E + S ⇌ ES ⇌ E + P; E + I ⇌ EI; catalyst fractions and product rate | Finite substrate/inhibitor inventories, explicit complexes, no quasi-steady-state reduction |
| `simulate_cstr` | `dc/dt = S r(c) + (c_feed-c)/tau`, `tau=V/Q` | Constant volume, equal inlet/outlet flow, ideal mixing, isothermal liquid |
| `simulate_pfr` | `dc/dtau = S r(c)` | Steady plug flow with constant density/volumetric flow; tau is axial residence time, not startup time |
| `simulate_semibatch` | `V=V0+Qt`, `dn/dt=V S r(n/V)+Q c_feed` | Ideal mixing, additive volumes, constant feed and no outlet |
| `analyze_reaction_sensitivity` | `dZ/dt=J(c)Z+S_selected diag(r_selected)` with `Z(0)=0` | `Z=d concentration/d ln(k)` at supplied parameters; analytic mass-action Jacobian avoids dividing by zero concentrations |
| `analyze_reaction_flux` | `d xi/dt=r`; `c-c0=S xi` and `S_ij r_j` pathway contributions | Signed formation/consumption; reversible cycles can accumulate large extents with little net conversion |
| `propagate_reaction_uncertainty` | Independent draws `ln(k)=ln(k_declared)+Normal(0,sd)` and empirical 5/50/95% concentration quantiles | Declared rates are medians; supplied spread, no inferred rate correlations or experimental observation noise |

Concentration is mol/L; elementary rates are mol/L/s; rate constants have units
`(mol/L)^(1-order)/s`. Fed-batch volumes and feed rates are L and L/s, and species
amounts are mol. All study temperatures are fixed; activation energies, when
provided on custom network reactions, use the existing J/mol Arrhenius convention.
There is no energy balance, pressure drop, axial dispersion, variable gas density,
automatic mechanism generation or transition-state calculation in these models.

The positive cascade relaxation rates are the two nonzero eigenvalues in magnitude.
They are calculated from their sum and product to retain the slower mode without
subtracting nearly equal eigenvalues. Kinetic equilibrium is reported separately
from the actual endpoint; a successful integration does not imply equilibration.

The CSTR integrates net feed minus discharge for every species. Fed-batch checks
amounts after subtracting the analytically integrated feed. Every run checks the
left-nullspace invariants of the stoichiometric matrix. Complete declared
compositions also undergo the shared element/moiety and charge checks. Incomplete
compositions are explicitly reported; mathematical invariants alone do not verify
chemical identity. Initially solute-free CSTR/fed-batch inventories are supported.

Sensitivity outputs preserve all species/selected-rate derivative trajectories
and rank selected rates for the target species. Normalized derivatives divide by
the maximum initial concentration, not instantaneous concentration (which may be
zero). They do not establish causality or global parameter identifiability.

Uncertainty outputs preserve the seed, every rate draw, all species quantiles and
sample counts. Failed draws fail the run rather than disappearing from the
denominator. Quantiles describe the supplied parameter distribution, not confidence
intervals or mechanism uncertainty. At most 128 draws, eight selected rates and
300,000 sample/species/time values are accepted; each solver also has an evaluation
budget and host cancellation. BDF uses rtol=1e-9 and atol=1e-12.

## UI and reproducibility

Method cards keep the shared icon and neutral theme. Study outputs use a shared
sample cursor across concentration, elementary flux, inventory and analysis
charts. PFR charts explicitly label residence time. Mechanism views use the
existing concentration population renderer: abstract species are colored markers,
not invented molecular structures or atomistic trajectories.

The explicit **Use network editor** action copies the current authored network,
temperature and time settings into a study without mutating the network editor.
It replaces the example selector, maps PFR time to residence time, caps saved
samples to 501, selects up to eight positive reaction rates when required, and
initializes reactor feed concentrations from the network's initial composition.
Inspect or edit those assumptions before running. Existing inputs remain in
their saved run records. **Open in Reaction Sim** preserves a method draft/result
when moving from Analysis. Run history reopens the exact method and its family.

CSV tables and complete JSON records retain input snapshots, resolved networks,
equations, runtime versions, all new source hashes, warnings and diagnostics.

## Public method references

Reviewed 2026-09-19; these describe the methods that informed the independent
implementation, not backend dependencies or copied source:

- [Cantera reactor tutorial](https://www.cantera.org/3.1/userguide/reactor-tutorial.html): reactor network integration, inlets/outlets and steady-state criteria.
- [Cantera plug-flow examples](https://www.cantera.org/3.1/examples/python/reactors/pfr.html): residence-time and steady-flow formulations. Our scope is isothermal constant-density liquid flow.
- [Cantera kinetic sensitivity example](https://www.cantera.org/3.1/examples/python/reactors/sensitivity1.html): species responses to rate parameters. Our explicit forward derivative equations and normalization are documented above.
- [SciPy solve_ivp](https://docs.scipy.org/doc/scipy/reference/generated/scipy.integrate.solve_ivp.html): implicit BDF integration and solver diagnostics.

## Verification

`tests/test_chem_reaction_studies.py` verifies the cascade against a matrix
exponential, catalytic/inhibitor inventories, CSTR startup and stationary limits,
PFR exponential decay, fed-batch amounts and dilution, forward sensitivity against
analytic and nonlinear perturbation references, integrated branch fluxes and
uncertainty quantiles against analytic draws. Invalid inputs remain explicit errors.

`tests/chem-reaction-studies.test.mjs` executes all eight operators through the
canonical Chat bridge, validates schemas, reopens persisted results and source
hashes, and checks presentation contracts and network-copy behavior. Receipts are
under `build/chem-reaction-qa/`. Numerical software checks do not validate the
supplied mechanism against experiments.
