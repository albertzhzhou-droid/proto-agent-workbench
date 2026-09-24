# Coupled reaction, reactor and transport operators

The second 2026-09-19 reaction extension added six local operators, reaching
44 catalog entries and 23 methods across the five Reaction Sim families. The
same canonical `chemistry.*` tools (and `chem.*` aliases) serve both Chat editions,
Analysis and Reaction Sim. No separate engine, upstream source copy or new
runtime installation is involved. The immutable imported Chem snapshot is unchanged.

The later [driven-reaction extension](chem-driven-reactions.md) added optical,
electrochemical and kinetic-inference methods. The latest
[network and nonideal-reactor extension](chem-network-reactors.md) brings the
current catalog to **56**, with **35 Reaction Sim methods**. This page documents
the preceding six coupled operators.

| Operator | Reaction Sim family | Main outputs |
| --- | --- | --- |
| `simulate_nonisothermal_batch` | Reactors | Concentrations, dynamic elementary rates, temperature, heat rates and cumulative energy |
| `simulate_nonisothermal_cstr` | Reactors | Thermal startup with inlet/outlet material accounting and feed sensible heat |
| `simulate_tanks_in_series` | Reactors | Outlet curves, all stage/species table columns and a synchronized target-species stage profile |
| `simulate_catalyst_deactivation` | Mechanisms | Selected rates scaled by activity loss/regeneration; unselected steps retained |
| `simulate_gas_liquid_reaction` | Interface reactions | Dissolved A + B → P, signed absorption/stripping and cumulative reservoir transfer |
| `simulate_catalyst_pellet` | Interface reactions | Transient radial pore profiles, external flux, consumption and pellet inventories |

## Numerical and scientific contracts

`runtime/chem-integration/chem_coupled_reactions.py` reuses the existing network
validation, stoichiometry, composition checks, bounded BDF solver and result
contract. There are at most 501 output samples, 16 tanks or 80 radial cells.
Every solve uses the existing 60,000 derivative-evaluation limit and host
cancellation/time limit. Nonfinite values, excessive negativity, inconsistent
inventories and thermal numerical-range failures return explicit failed receipts.

### Thermal reactors

The constant-volume liquid models integrate
`Cv dT/dt = -sum(ΔH_j r_j) - Uv(T-Tcool) + Cv(Tfeed-T)/tau`, with the final term
only for CSTR. Concentration is mol/L, `Cv` is J/L/K, `Uv=UA/V` is W/L/K,
and reaction enthalpy is J per mol of reaction extent. Negative ΔH releases heat.
Rate constants use the network's declared reference temperatures and activation
energies at every integration step. Missing activation energies mean zero
temperature dependence; no heats or activation energies are inferred from SMILES.

Every reaction requires an explicit heat. A least-squares consistency check
requires a species-enthalpy vector compatible with `S.T h = ΔH`, rejecting
inconsistent reverse steps or stoichiometric cycles. This does not validate
thermodynamic detailed balance of supplied kinetic constants. Cumulative reaction,
coolant and feed heat are integrated independently and checked against sensible
energy change. Feed-corrected material invariants are checked separately.

Constant density, heat capacity and reaction enthalpies are assumptions. There is
no phase change, gas expansion, pressure or coolant dynamics. The 150–2000 K
solver envelope is a numerical bound, not a validated physical operating range.

### Tanks and catalyst activity

The train contains N equal-volume CSTRs with individual residence time
`tau_total/N`. Each stage starts with the supplied network concentrations. The
overall balance uses mean stage concentration and integrated net feed/discharge.
The primary curves are explicitly outlet curves; stage profiles follow the same
saved sample cursor. A final derivative diagnostic is reported without declaring
steady state automatically.

Catalyst activity follows `da/dt=-kd*a+kr*(1-a)`. Only selected elementary rates
receive the activity multiplier. This is a phenomenological model, not a resolved
deactivation chemistry or catalyst inventory. Scaling one direction of a reversible
pair changes its implied equilibrium ratio; the result warns about this assumption.

### Gas–liquid and porous pellet models

Gas transfer uses `J=kLa*(C_sat-A)` with positive absorption and negative stripping.
The maintained reservoir and dissolved equilibrium concentration are supplied.
Coupled second-order consumption gives `dA/dt=J-kAB`, `dB/dt=-kAB`, `dP/dt=kAB`.
Integrated gas exchange closes the open-system inventory. No gas depletion,
Henry-constant estimation or liquid-film enhancement model is implied.

The pellet integrates `epsilon*dC/dt = De/r²*d(r²*dC/dr)/dr - kv*C` with zero
central flux and an external film boundary. Spherical finite volumes use shell
volumes and radial diffusion resistances; diffusion fluxes cancel between cells.
Porosity determines storage. Pore/bulk concentrations are mol/m³ **fluid**;
reaction rates and cumulative inventories are per m³ **total pellet**. Product
transport is not resolved. Diffusivity and `kv` use the corresponding total-area
and total-volume conventions. The model assumes a homogeneous isothermal sphere
and dilute or equimolar diffusion.

Analytical steady references report Thiele modulus, Biot number, internal
effectiveness, surface concentration and flux. They remain distinct from the
simulated transient endpoint. The radial view is a continuum profile, not atomic
motion or a new 3D molecular trajectory.

## UI and reproducibility

The existing paper/ink theme, shared method icon, fonts and three-panel tool desk
are retained. Radial/stage charts use the same time cursor as the kinetic curves;
the chart exports the selected spatial frame as CSV or SVG. Complete result JSON
retains every profile frame. Run tables retain all time-dependent bulk quantities
and every stage/species concentration. History restores the exact saved inputs.

**Use network editor** copies the authored network without changing the editor.
For thermal models it maps the initial temperature and deliberately resets every
reaction enthalpy to `null`: the user must enter explicit values for the copied
stoichiometry. Even identical reaction IDs must not inherit unrelated example heat.
The example remains separately loadable. Empty/missing heat values fail validation.

Every successful or failed host run retains the original input, diagnostics and
source hashes, now including `chem_coupled_reactions.py`. Shared Chat catalog and
dispatch tests exercise both canonical names and aliases without duplicating tools.

## Method references

Reviewed 2026-09-19. These informed independent equation implementations; they are
not copied code, runtime adapters or claims of complete upstream feature parity.

- [Cantera reactor interactions](https://www.cantera.org/3.1/reference/reactors/interactions.html): reactor wall heat transfer. This implementation uses only a constant volumetric heat-transfer coefficient and fixed coolant temperature.
- [Fogler, diffusion and reaction](https://public.websites.umich.edu/~essen/html/byconcept/chapter12.pdf): spherical catalyst diffusion, Thiele modulus and effectiveness. The transient finite-volume implementation and explicit porosity/storage convention are documented above.
- [Fogler, nonideal reactor models](https://public.websites.umich.edu/~elements/5e/18chap/Fogler_Web_Ch18_final.pdf): tanks-in-series framework. This implementation resolves equal-volume transient stages with a shared mass-action network.
- [WaterTAP anaerobic digester equations](https://watertap.readthedocs.io/en/stable/technical_reference/unit_models/anaerobic_digester.html): explicit gas–liquid transfer terms. The present operator is a smaller maintained-reservoir A+B model, not an ADM1 or IDAES adapter.

## Verification

`tests/test_chem_coupled_reactions.py` checks adiabatic conversion/temperature,
Newton cooling, feed/cooling startup, Arrhenius feedback against independent
DOP853 integration, single-tank equivalence, train steady conversion, analytical
activity/exposure, absorption/stripping, closed second-order kinetics, porosity
storage, pellet steady profiles and grid refinement, plus invalid inputs and
explicit thermal failure. Numerical receipts are in `build/chem-coupled-reaction-qa/`.

`tests/chem-coupled-reactions.test.mjs` validates schemas, shared Chat dispatch,
source hashes and saved readback for all six methods, failed receipt retention,
spatial-frame validation and thermal network handoff. These checks establish
software behavior within the stated models, not experimental mechanism validity.
