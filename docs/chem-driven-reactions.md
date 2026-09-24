# Driven reactions and kinetic inference

The subsequent [network and nonideal-reactor extension](chem-network-reactors.md)
brings the current catalog to **56 operators / 35 Reaction Sim methods**.
The counts below describe this earlier extension.

The third 2026-09-19 reaction extension adds six operators, bringing the Chem
catalog to **50** and Reaction Sim to **29** methods. They use the same Analysis
catalog, five Reaction Sim families, canonical `chemistry.*` Chat tools and
`chem.*` aliases. Implementation is in `runtime/chem-integration/chem_driven_reactions.py`.
The imported Chem snapshot remains unchanged; no upstream engine or device is invoked.

| Operator | Family | New capability |
| --- | --- | --- |
| `simulate_photochemical_isomerization` | Mechanisms | Absorbed-photon-driven A ⇌ B with thermal back reaction and sinusoidal illumination |
| `simulate_excited_state_quenching` | Mechanisms | Ground, singlet, triplet and product populations; emission, quenching and excitation inventories |
| `simulate_cyclic_voltammetry` | Interface reactions | Diffusion-coupled Butler–Volmer kinetics, triangular potential, current–potential loop and charge accounting |
| `simulate_chronoamperometry` | Interface reactions | Faradaic potential-step response with finite-slab diffusion and electrode concentrations |
| `fit_arrhenius_eyring` | Kinetic analysis | Activation parameters from temperature-dependent first-order rates, conditional standard errors and log residuals |
| `compare_integrated_rate_laws` | Kinetic analysis | Zero/first/second-order concentration fits, complete residuals, likelihood-based AICc and candidate weights |

## Models and units

### Photochemical isomerization

The monochromatic optical absorbance is `l*(epsilon_A*A+epsilon_B*B)`, with `l`
in cm, epsilon in L/mol/cm and concentration in mol/L. Absorbed photons are
`I_vol*(1-10^(-absorbance))`, divided between A and B according to their relative
absorption contributions. Each photochemical rate is its absorbed photon rate
times its supplied quantum yield. `I_vol=I_area/(10*l_cm)` converts incident
mol photons/m²/s using the illuminated liquid depth. A dark first-order B→A
channel is separate. Optional light modulation is sinusoidal and nonnegative.

The model assumes homogeneous mixing, constant absorption coefficients, no
scattering, heating or excited-state saturation, and one-photon isomerization
with quantum yields in [0,1]. It does not represent radical-chain quantum yields
above one. The solver normalizes molecular and event inventories for precision
at low concentrations and limits illumination to 200 periods per run. Molecular
and absorbed-photon accounting are checked independently.

### Excited states and quenching

`dS/dt=k_pump*G-(k_f+k_nr+k_isc+k_q*Q)*S`; the triplet gains `k_isc*S` and loses
by return to ground or product formation. Quenching returns singlets to ground
with a maintained Q reservoir. Chromophore inventory `G+S+T+P` is conserved;
fluorescence and quenching events are integrated separately. The pump is a
supplied pseudo-first-order rate, not a spectrum-derived absorption rate.

State populations are abstract kinetics and are displayed as population
schematics. No molecular orbitals, electronic energies or atomistic trajectories
are inferred. The reported singlet lifetime and fluorescence branch yield
condition on the supplied decay coefficients.

### Electrochemical diffusion

Both operators use a planar **finite closed slab** with a reflecting far wall,
equal O/R diffusivities, supporting electrolyte and `O+R=C_total`. Finite-volume
interior diffusion and an analytically eliminated half-cell surface resistance
couple the concentration field to Butler–Volmer electron transfer:

`j_red=k0*[exp(-alpha*nF*eta/RT)*O_s-exp((1-alpha)*nF*eta/RT)*R_s]`.

Here alpha is the cathodic coefficient, eta is applied minus formal potential,
and **anodic current is positive**: `i_F=-nF*j_red`. Concentrations use mol/m³,
diffusion m²/s, heterogeneous coefficients m/s, current A/m² and charge C/m².
Integrated charge is checked against loss/gain of the oxidized inventory.
Normalized concentration must remain in [0,1] within solver tolerance.

CV executes one triangular out-and-back scan. An odd sample count includes the
exact vertex. Ideal capacitive current `Cdl*dE/dt` and charge `Cdl*(E-E_start)`
are recorded separately; the reversal sample uses the return-scan current.
The loop cursor and diffusion profile share the saved timeline. The potential
step reports faradaic current only and omits the ideal instantaneous capacitive
impulse. Neither operator includes migration, convection, solution resistance,
adsorption or coupled homogeneous reaction.

The diffusion-length/domain-length ratio makes finite-wall effects visible.
A chosen finite slab is not automatically a semi-infinite electrolyte. The
initial finite-volume current approximates the early-time boundary layer;
continuum Cottrell behavior is assessed at resolved nonzero times with grid
refinement. Use the explicit domain and grid settings when evaluating results.

### Temperature-dependent rate fitting

Arrhenius fits `ln(k)=ln(A)-Ea/(RT)`; Eyring fits
`ln(k/T)=ln(kB/h)+ΔS/R-ΔH/(RT)` with transmission coefficient one. Only
first-order rates in s^-1 are accepted. Centered/scaled inverse temperature
improves numerical conditioning; rank and insufficient temperature spread
are checked. The result reports energy/enthalpy in J/mol and, for Eyring,
entropy in J/mol/K. Arrhenius returns ln(A) to avoid unsafe exponentiation.

Parameter standard errors use the **supplied known common SD of ln(k)**. They
are not estimated experimental errors; reduced chi-square and residuals expose
disagreement with that error assumption. Straight-line agreement does not prove
a mechanism or support unrestricted temperature extrapolation.

### Integrated rate-law comparison

All three candidates fit the same observations with a fixed **independently
supplied** C0 and known Gaussian concentration SD. Zero-order depletion is
clamped at zero; first- and second-order models use their integrated laws.
Optimization uses a dimensionless extent to handle different rate units.

With one fitted parameter and known variance, each candidate uses
`AICc=chi²+n*ln(2πσ²)+2p+2p(p+1)/(n-p-1)`, `p=1`. Weights normalize
`exp(-delta_AICc/2)` within this three-model set. All parameters, predictions,
residuals, boundary flags, local identifiability flags and convergence status
are retained. A nonconverged candidate fails the comparison rather than being
silently removed. Boundary/depletion-kink or locally unidentifiable fits make
regular AICc assumptions approximate. Relative support is not mechanism proof.

## Integration and evidence

The existing neutral theme, Anthropic typography, common method icon and tool
desk are reused. A timed parametric chart now supports current–potential loops
whose x coordinate reverses, with a sample marker linked to the timeline.
Fit tools use the existing observed/fitted and residual chart surfaces. Complete
JSON preserves all frames and source hashes, including the new Python module;
CSV tables preserve every supplied observation and fitted candidate.

Shared bounded BDF integration retains its evaluation budget and host
cancellation. Model inputs are structured data, with no arbitrary code, files
or instrument commands. The new electrochemical and optical models do not
require RDKit or an external electrochemical engine.

## Public references

Reviewed 2026-09-19. These are method references for independent implementations;
no proprietary COMSOL code or other upstream source is copied.

- [IUPAC Beer–Lambert law](https://goldbook.iupac.org/terms/view/B00626) and [quantum yield](https://goldbook.iupac.org/terms/view/Q04991): absorption and absorbed-photon conventions.
- [IUPAC Stern–Volmer relationships](https://goldbook.iupac.org/terms/view/S06004): lifetime/yield changes from collisional quenching.
- [COMSOL cyclic voltammetry model documentation](https://doc.comsol.com/6.4/doc/com.comsol.help.models.fce.cyclic_voltammetry_1d/cyclic_voltammetry_1d.html): concentration-dependent Butler–Volmer coupling to diffusion and triangular scans. Our finite reflecting slab and equal-diffusivity reduction are explicitly scoped above.
- [SciPy least_squares](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.least_squares.html): bounded nonlinear least squares and convergence reporting.
- [Statsmodels AICc reference](https://www.statsmodels.org/stable/generated/statsmodels.tools.eval_measures.aicc.html): small-sample information criterion; our likelihood uses known supplied variance and independently fixed C0.

## Verification

`tests/test_chem_driven_reactions.py` contains 15 checks covering dark and
transparent optical limits, exact photostationary relaxation, modulated photon
inventory, independent state-matrix exponentials, small-concentration quenching,
triangle/capacitor limits, electrochemical equilibrium, Cottrell behavior and
grid convergence, charge balance, Arrhenius/Eyring parameter recovery, each
kinetic order, independent scalar optimization, likelihood arithmetic and invalid
input failures.

`tests/chem-driven-reactions.test.mjs` exercises all six operators through the
canonical Chat dispatch, schema validation, persisted readback and source hashes,
plus failed receipts, phase-plot validation and CSV sample preservation. Receipts
are stored under `build/chem-driven-reaction-qa/`. These checks establish software
behavior, not experimental validation or a new live-model reasoning evaluation.
