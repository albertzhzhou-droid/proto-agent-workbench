# Interface kinetics in Chem Compute

Five independent local SciPy operators are exposed through Analysis → Interfaces,
Reaction simulator → Interface reactions, and the canonical `chemistry.*` Chat
tools. `chem.*` names are aliases, not separate engines. Existing candidate-bound
interface models remain available. Imported Chem snapshot code is unchanged.

## Models and units

| Operator | Model | Primary output |
| --- | --- | --- |
| `simulate_competitive_adsorption` | A and B compete for equivalent single-occupancy sites; maintained dimensionless reservoir activities | Fractional coverages and net adsorption flux, mol m⁻² s⁻¹ |
| `simulate_langmuir_hinshelwood` | A* + B* → P + 2*, coupled to adsorption/desorption | Coverages, product flux and accumulated product, mol m⁻² |
| `simulate_eley_rideal` | A* + B(reservoir) → P + *, coupled to A adsorption/desorption | Coverage, turnover and product flux |
| `simulate_electrode_step` | Asymmetric Butler–Volmer current with series resistance and double-layer capacitance | Interfacial potential, total/Faradaic/capacitive current density and charge accounting |
| `simulate_diffusion_film` | Cell-centered finite-volume planar diffusion with Robin surface reaction and fixed far reservoir | Surface flux, time-dependent concentration profile and integrated mass balance |

Surface equations use `theta_vacant = 1 - theta_A - theta_B` and
`r_ads,i = k_ads,i * activity_i * theta_vacant - k_des,i * theta_i`.
The LH reaction uses `k_reaction * theta_A * theta_B`; the ER reaction uses
`k_reaction * theta_A * activity_B`. Multiply rates per site by site density
(mol sites m⁻²) to obtain areal molar flux. These are mean-field models; no
pair-correlation or lattice kinetic Monte Carlo calculation is claimed.

The electrode convention is positive anodic current:
`j_F = j0 * (exp(alpha*n*F*eta/(R*T)) - exp(-(1-alpha)*n*F*eta/(R*T)))`.
Area-specific resistance is in Ω m² and capacitance in F m⁻².
`C*deta/dt = (eta_applied-eta)/R_area - j_F`.
Integrated total current must equal Faradaic charge plus double-layer charge
change. The input step is relative to the same equilibrium potential; neither
absolute electrode potentials nor time-dependent exchange current are inferred.

Film diffusion uses fixed D and thickness L, an irreversible surface rate in m/s,
and concentrations in mol/m³ (not mol/L). At x=0, `D*dc/dx = k_s*c_surface`;
at x=L, `c=c_bulk`. Half-cell boundary resistances preserve the steady solution
`J = c_bulk*k_s/(1+k_s*L/D)`. Cells range from 8 to 80. Integrated reservoir
supply minus surface consumption equals the change in film inventory.

## Public references and implementation provenance

Reviewed 2026-09-19. These are method-level references; no upstream engine is
invoked and no upstream source file was copied. The execution dependency is the
existing NumPy/SciPy environment, whose actual versions accompany each receipt.

- [Cantera 3.2 interface kinetics](https://www.cantera.org/3.2/python/kinetics.html#interfacekinetics): coverage evolution, surface species and areal rates.
- [PyBaMM 26.4.1 Butler–Volmer source](https://docs.pybamm.org/en/v26.4.1/_modules/pybamm/models/submodels/interface/kinetics/butler_volmer.html): symmetric and asymmetric current conventions.
- [NIST FiPy Robin boundary example](https://pages.nist.gov/fipy/en/latest/generated/examples.convection.robin.html): flux-boundary finite-volume treatment; the implementation here is an independent one-dimensional diffusion model.
- [SciPy solve_ivp](https://docs.scipy.org/doc/scipy/reference/generated/scipy.integrate.solve_ivp.html): implicit BDF integration with rtol=1e-9 and atol=1e-12.

## UI and saved evidence

Each interface result has one shared sample timeline, synchronized kinetic
charts, CSV table export and a complete JSON run record. Adsorption/catalysis
also has a rotatable 3D occupancy schematic; 100 display sites are apportioned
from the computed coverages, including vacancies. Fixed display positions and
rounded counts are not atomic coordinates, crystallography or trajectories.
Diffusion profiles show concentrations at cell centers for the selected time.
Electrode models show current/potential/charge curves without inventing atoms.

The default examples are illustrative parameters. The model, resolved parameters,
equations, warnings, diagnostics, input snapshot, library versions and hashes of
all integration source files are preserved. User input validation rejects unknown
fields, nonfinite numbers, negative physical quantities and overfilled sites.
Solver or conservation failure never becomes a completed trajectory.

## Verification

`tests/test_chem_interfaces.py` checks analytical adsorption and ER transients,
the equal-coverage LH closed-batch solution, both-polarity pure RC limits,
Butler–Volmer steady roots, linear steady diffusion, transient mesh refinement,
mass/charge/site accounting and invalid input rejection.

`tests/chem-interface-integration.test.mjs` checks schemas, real worker execution,
canonical Chat dispatch, complete persisted readback, source hashes, history,
display-site apportionment and mismatched trajectory rejection. Numerical and
integration receipts are saved under `build/chem-interface-qa/`.
