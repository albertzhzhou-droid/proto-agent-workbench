# Network fluctuations and nonideal reactors

The fourth reaction extension (2026-09-19, worker `chem-science/1.7.0`) adds
six operators. The current catalog has **56 operators**, with **35 methods in
Reaction Sim**. All six are available in Analysis and the canonical Chat
registry (`chemistry.<id>`; `chem.<id>` is an alias).

| Operator | Reaction Sim family | Output |
| --- | --- | --- |
| `simulate_stochastic_network` | Mechanisms | Seeded molecular-count trajectories, ensemble means, empirical quantiles and event inventories |
| `simulate_axial_dispersion` | Reactors | Startup outlet curves, synchronized axial profiles and integrated material balances |
| `analyze_tracer_rtd` | Kinetic analysis | Pulse density, cumulative exit fraction, residence-time moments and quantiles |
| `simulate_rtd_segregation` | Reactors | Parcel kinetics, cumulative outlet contributions and mixed outlet composition |
| `analyze_network_structure` | Kinetic analysis | Stoichiometric matrix, conserved linear pools and algebraic cycle bases |
| `scan_cstr_steady_states` | Reactors | One locally found steady-state branch, balance residuals and linear stability eigenvalues |

The implementation is `runtime/chem-integration/chem_network_reactors.py`.
It reuses the existing network validator and bounded BDF solver. No duplicate
tool engine, instrument adapter or external simulator is installed. The
imported Chem source snapshot remains unchanged.

## Stochastic molecular populations

The Gillespie direct method runs independent, well-mixed, constant-volume
trajectories. With volume in litres, `Omega = NA*V`, initial counts are
`N_i = Omega*c_i`, using the exact Avogadro constant 6.02214076e23 mol^-1.
Counts must already be integers within floating-point tolerance; fractional
populations fail rather than being silently rounded. Total counts are bounded
by one million, and elementary reactant molecularity by three.

The shared deterministic convention is reaction-event rate
`r_j = k_j product(c_i^nu_ij)`. The matching propensity is
`a_j = k_j Omega^(1-m_j) product((N_i)_(nu_ij))`, where `(N)_nu` is a falling
factorial. No extra factorial denominator is applied. For example, a `2A -> B`
step with event-rate coefficient k has propensity `k*N_A*(N_A-1)/Omega` and
deterministic A loss `2*k*c_A^2`. Converting a coefficient reported using a
different species-depletion convention is the caller's responsibility.

Waiting times are exponential with total propensity, and the selected reaction
increments counts by its integer stoichiometric column. Every replicate's final
inventory change is checked against its reaction event counts. Absorbing states
remain unchanged for the rest of the time window.

PCG64 generators use child SeedSequences from a saved root seed. All sampled
trajectories, child spawn keys and per-reaction event counts are saved. Individual
event times are not retained. Time samples describe right-continuous states.
The aggregate event budget applies to the complete ensemble; exhaustion fails
the run without promoting a successful subset. Storage is bounded to 300,000
species/time/replicate values. Quantiles describe molecular fluctuations, not
parameter confidence intervals or spatial motion. Ensemble SD uses the
population denominator; a single replicate therefore has zero ensemble SD.

## Axial dispersion and flow

For dimensionless position `z=x/L`, the model solves

`dC/dt = -(1/tau)dC/dz + (1/(tau*Pe))d²C/dz² + S*r(C)`.

Here `tau=L/u` is the nominal residence time and `Pe=u*L/D_ax`. The inlet total
flux is `C_feed/tau` (Danckwerts), while outlet dispersive flux is zero. All
species share the supplied axial dispersion coefficient. Concentration is
mol/L; physical length and cross-sectional area are not needed for this
normalized constant-density model.

Conservative finite volumes use upwind advection and centered diffusion, with
a sparse Jacobian pattern for BDF integration. The initial network concentrations
are uniform throughout the reactor. Each species' volume-mean change is checked
against separately integrated net inlet/outlet flow and reaction production.
Normalization by the concentration scale supports dilute cases. The saved result
contains every species' spatial profile, with the selected species displayed
against the shared startup timeline.

First-order upwinding introduces numerical dispersion. The result reports
`Pe/cells` and the leading numerical/physical dispersion ratio `Pe/(2*cells)`.
Grid refinement is essential for sharp fronts or high Pe. The range is 8–80 cells,
with at most 640 cell/species states. Time denotes startup, not position or parcel
age. Heat, pressure drop, density changes and radial transport are excluded; a
transient endpoint is not automatically a steady state.

## Pulse-tracer residence-time distribution

Matched observations start at zero and increase strictly in time. A supplied
constant baseline is subtracted without clipping negative values. Piecewise
linear interpolation gives the exact observed signal area, and normalization
produces `E(t)` in s^-1. The cumulative distribution is the integral of E.

Two-point Gaussian quadrature integrates each segment's time moments exactly.
Variance is calculated around the mean to reduce cancellation for narrow,
late-arriving pulses. Arrival quantiles invert each segment's quadratic cumulative
distribution. Raw and corrected observations are retained alongside E and F.
The squared-mean/variance ratio is reported as a descriptive moment-matched
tank count, not a fitted physical number of vessels.

The model assumes a passive linear tracer, a pulse injection and constant flow.
Finite injection width and detector dynamics are not deconvolved. Only the
observed window is normalized; missing tails and absolute recovery cannot be
determined without additional evidence. Endpoint signal fractions expose a
visibly unfinished trace, but a zero endpoint does not prove complete recovery.

## Segregated-parcel reactor prediction

The same validated pulse trace weights independent batch trajectories of the
authored network. Network initial concentrations represent the parcel feed:

`dC_parcel/d age = S*r(C_parcel)`

`C_out = integral(E(age)*C_parcel(age) d age)`.

Weighted contributions and the integrated residence distribution are included
in the BDF state. A maximum step tied to tracer spacing resolves the piecewise
signal, and final density normalization must agree within 2e-6. Extreme spacing
ratios above 5,000 fail explicitly. Closed parcel balances are also checked.
Plots use **residence time/parcel age**, not reactor startup time. Conversion is
reported only for species with nonzero feed concentration.

This assumes complete segregation until outlet mixing. It does not establish
the reactor's actual micromixing regime or implement maximum mixedness. The
prediction conditions on the observed-window RTD and supplied kinetics.

## Structural network inspection

SVD of S and its transpose gives right and left nullspaces, using relative
cutoff 1e-10. Conserved pool vectors satisfy `L*S=0`; cycle vectors satisfy
`S*Z=0`. Bases are scaled to a largest absolute coefficient of one with a
consistent leading sign. Their matrix residuals, dimensionality and initial
pool values are exposed, together with a long-form stoichiometry table.

Every declared step enters S, including steps whose supplied rate is zero;
an activity table makes those disabled steps explicit. Bases are nonunique
signed combinations. They do not by themselves identify named chemical moieties,
feasible nonnegative cycles, detailed balance or thermodynamic consistency.
Incomplete species composition remains explicitly unverified.

## Local CSTR steady-state continuation

The supplied residence times must be strictly increasing or decreasing. Each
point solves `0 = S*r(C) + (C_feed-C)/tau` by bounded nonnegative least squares
with an analytic mass-action Jacobian. The first point starts from the network
initial concentrations; subsequent points start from the preceding accepted root.
Both solver success and a scaled maximum balance residual <=1e-7 are required.
Any failure rejects the whole scan rather than discarding an inconvenient point.

The dynamic Jacobian is `J = S*dr/dC - I/tau`. Every complex eigenvalue is retained.
Classification uses the largest real part and a reported scale-aware tolerance:
negative is locally stable, positive is unstable, and near zero is unresolved.
Concentration and spectral-abscissa charts share the residence-time parameter.
The raw table preserves the caller's continuation order.

This is one locally found isothermal branch. A continuation step can switch
branches or fail near folds. The tool does not enumerate all roots, implement
pseudo-arclength continuation, prove global stability or locate bifurcations.

## Integration and verification

The existing method-card icon, neutral theme, Anthropic fonts and input/output
desk are reused. Additional validated charts expose RTD cumulative fractions
and steady-branch stability without assigning new menu icons. Network copying
removes unsupported simulation fields for non-transient analyses and preserves
the original editor draft. Inputs, results, errors and source hashes use the
same saved-run contract as all other chemistry operators.

`tests/test_chem_network_reactors.py` checks reproducibility, binomial mean and
variance, low-copy second-order propensities, integer balances, absorbing states,
independent matrix-exponential transport, continuum grid convergence, exact RTD
moments/quantiles, nonlinear segregated-parcel integrals, nullspaces, analytical
CSTR roots, finite-difference Jacobians, unstable/marginal classification and
invalid inputs. `tests/chem-network-reactors.test.mjs` exercises all six through
canonical Chat dispatch, schema validation, editor copying, source hashes,
result contracts, CSV charts and saved success/failure readback.

Evidence is under `build/chem-network-reactor-qa/`. These checks validate the
software models, not real chemical mechanisms or live-model reasoning quality.

## Public method references

Reviewed 2026-09-19; equations are independently implemented and no upstream
simulator source is copied.

- [Gillespie, Exact stochastic simulation of coupled chemical reactions (1977)](https://doi.org/10.1021/j100540a008): direct stochastic simulation.
- [COMSOL Danckwerts inlet documentation](https://doc.comsol.com/6.3/doc/com.comsol.help.cfd/cfd_ug_chemsptrans.11.139.html): prescribed total inlet flux.
- [University of Michigan, residence-time distributions](https://websites.umich.edu/~elements/5e/16chap/summary.html): tracer normalization and residence-time statistics.
- [University of Michigan, segregation and RTD prediction](https://websites.umich.edu/~elements/5e/17chap/summary.html): independent batch parcels and outlet mixing.
- [SciPy null_space](https://docs.scipy.org/doc/scipy/reference/generated/scipy.linalg.null_space.html) and [least_squares](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.least_squares.html): numerical decomposition and bounded nonlinear solving.
