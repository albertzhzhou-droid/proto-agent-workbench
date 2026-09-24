"""Bounded mean-field interface models; independent SciPy implementations.

Public method references and equations: docs/chem-interface-methods.md.
All examples are illustrative, and surface scenes are occupancy schematics.
"""
from __future__ import annotations

from chem_analysis import obj, number, integer, finite_result, fail

R = 8.31446261815324
F = 96485.33212
RTOL, ATOL = 1e-9, 1e-12


def n(low, high, description, default=None):
    return {'type': 'number', 'minimum': low, 'maximum': high, 'description': description,
            **({'default': default} if default is not None else {})}


COMMON = {
    'duration_s': n(1e-6, 1e6, 'Simulation duration / s', 30),
    'points': {'type': 'integer', 'minimum': 2, 'maximum': 501, 'default': 151, 'description': 'Saved time samples'},
}
SURFACE = {
    'activity_a': n(0, 100, 'Maintained dimensionless activity of A'),
    'activity_b': n(0, 100, 'Maintained dimensionless activity of B'),
    'k_ads_a_s': n(0, 1e4, 'Adsorption coefficient for unit activity of A / s^-1'),
    'k_des_a_s': n(0, 1e4, 'A desorption coefficient / s^-1'),
    'initial_coverage_a': n(0, 1, 'Initial fraction of sites occupied by A', 0),
    'site_density_mol_m2': n(1e-12, 1, 'Moles of equivalent surface sites per m^2'),
}
ADS_B = {
    'k_ads_b_s': n(0, 1e4, 'Adsorption coefficient for unit activity of B / s^-1'),
    'k_des_b_s': n(0, 1e4, 'B desorption coefficient / s^-1'),
    'initial_coverage_b': n(0, 1, 'Initial fraction of sites occupied by B', 0),
}
BASE_EXAMPLE = {'activity_a': 1, 'activity_b': .6, 'k_ads_a_s': .4, 'k_des_a_s': .08,
    'initial_coverage_a': 0, 'site_density_mol_m2': 2e-5, 'duration_s': 30, 'points': 151}
B_EXAMPLE = {'k_ads_b_s': .3, 'k_des_b_s': .12, 'initial_coverage_b': 0}
MODELS = {
    'simulate_competitive_adsorption': ('Competitive surface adsorption',
        'Resolve A/B competition for shared sites, vacant-site coverage and net uptake flux.',
        {**SURFACE, **ADS_B}, {**BASE_EXAMPLE, **B_EXAMPLE}, 'Cantera surface-coverage method reference / SciPy'),
    'simulate_langmuir_hinshelwood': ('Langmuir–Hinshelwood surface catalysis',
        'Adsorb A and B, react A* + B* → P + 2*, and calculate coverages and product flux.',
        {**SURFACE, **ADS_B, 'k_reaction_s': n(0, 1e4, 'Mean-field surface reaction coefficient / s^-1')},
        {**BASE_EXAMPLE, **B_EXAMPLE, 'k_reaction_s': .5}, 'Surface mass action / SciPy'),
    'simulate_eley_rideal': ('Eley–Rideal surface catalysis',
        'React adsorbed A with reservoir B; calculate site occupancy, turnover and product flux.',
        {**SURFACE, 'k_reaction_s': n(0, 1e4, 'Reaction coefficient for unit B activity / s^-1')},
        {**BASE_EXAMPLE, 'k_reaction_s': .5}, 'Surface mass action / SciPy'),
    'simulate_electrode_step': ('Electrode step & double-layer response',
        'Couple Butler–Volmer charge transfer, double-layer charging and series resistance after a potential step.',
        {'exchange_current_a_m2': n(0, 1e4, 'Exchange current density / A m^-2'),
         'alpha': n(.01, .99, 'Anodic transfer coefficient; cathodic coefficient is 1-alpha'),
         'electrons': {'type': 'integer', 'minimum': 1, 'maximum': 4, 'description': 'Electron transfer number'},
         'temperature_k': n(200, 1500, 'Temperature / K'),
         'applied_overpotential_v': n(-.5, .5, 'Applied potential relative to equilibrium / V'),
         'initial_overpotential_v': n(-.5, .5, 'Initial interfacial overpotential / V', 0),
         'resistance_ohm_m2': n(1e-6, 100, 'Area-specific series resistance / ohm m^2'),
         'capacitance_f_m2': n(1e-6, 1000, 'Area-specific double-layer capacitance / F m^-2')},
        {'exchange_current_a_m2': .5, 'alpha': .5, 'electrons': 1, 'temperature_k': 298.15,
         'applied_overpotential_v': .1, 'initial_overpotential_v': 0, 'resistance_ohm_m2': .1,
         'capacitance_f_m2': 2, 'duration_s': 2, 'points': 151}, 'PyBaMM Butler–Volmer method reference / SciPy'),
    'simulate_diffusion_film': ('Reactive diffusion film',
        'Solve one-dimensional diffusion to a reactive surface with a maintained reservoir and a Robin boundary.',
        {'diffusivity_m2_s': n(1e-14, 1e-5, 'Constant molecular diffusivity / m^2 s^-1'),
         'film_thickness_m': n(1e-8, .01, 'Film thickness / m; surface at x=0'),
         'surface_rate_m_s': n(0, .1, 'First-order surface reaction velocity / m s^-1'),
         'bulk_concentration_mol_m3': n(1e-9, 1e6, 'Maintained reservoir concentration / mol m^-3'),
         'initial_fraction': n(0, 1, 'Initial film concentration divided by reservoir concentration', 1),
         'cells': {'type': 'integer', 'minimum': 8, 'maximum': 80, 'default': 40, 'description': 'Finite-volume cells'}},
        {'diffusivity_m2_s': 1e-9, 'film_thickness_m': 1e-4, 'surface_rate_m_s': 5e-5,
         'bulk_concentration_mol_m3': 1, 'initial_fraction': 1, 'cells': 40, 'duration_s': 30, 'points': 151},
        'FiPy finite-volume / Robin-boundary method reference; independent SciPy implementation'),
}


def _parameters(data, operator):
    properties = {**COMMON, **MODELS[operator][2]}
    obj(data, 'input', set(properties))
    values = {}
    for key, rule in properties.items():
        value = data.get(key, rule.get('default'))
        check = integer if rule['type'] == 'integer' else number
        values[key] = check(value, key, rule['minimum'], rule['maximum'])
    return values


def _solve(rhs, initial, p, *, jac=None):
    import numpy as np
    from scipy.integrate import solve_ivp
    time = np.linspace(0, p['duration_s'], p['points'])
    solution = solve_ivp(rhs, (0, p['duration_s']), initial, t_eval=time, method='BDF',
                         rtol=RTOL, atol=ATOL, jac=jac)
    if not solution.success or solution.y.shape[1] != len(time) or not np.isfinite(solution.y).all():
        fail('The interface solver did not produce a complete finite trajectory.', 'SOLVER_FAILED')
    return time, solution.y, {'solver': 'SciPy solve_ivp / BDF', 'rtol': RTOL, 'atol': ATOL,
        'nfev': int(solution.nfev), 'njev': int(solution.njev), 'samples': len(time)}


def _chart(key, title, unit, columns):
    return {'id': key, 'title': title, 'unit': unit,
            'series': [{'id': name, 'label': name.replace('_', ' '), 'values': values.tolist()} for name, values in columns.items()]}


def _result(operator, p, time, rows, charts, diagnostics, equations, warnings, scene=None):
    return {'kind': 'interface-simulation', 'model': operator, 'title': MODELS[operator][0],
        'time_s': time.tolist(), 'rows': rows, 'charts': charts, 'diagnostics': diagnostics,
        'method': {'equations': equations, 'parameters': p, 'implementation': 'Independent local SciPy model'},
        'warnings': warnings, **({'surface_scene': scene} if scene else {})}


def _surface(data, operator):
    import numpy as np
    p = _parameters(data, operator)
    er = operator == 'simulate_eley_rideal'
    reactive = operator != 'simulate_competitive_adsorption'
    a0, b0 = p['initial_coverage_a'], p.get('initial_coverage_b', 0)
    if a0 + b0 > 1:
        fail('Initial A and B coverages must sum to at most one.')
    ka, kb = p['k_ads_a_s'] * p['activity_a'], p.get('k_ads_b_s', 0) * p['activity_b']
    da, db, kr = p['k_des_a_s'], p.get('k_des_b_s', 0), p.get('k_reaction_s', 0)
    def rates(y):
        a, b = y[0], y[1]
        free = 1 - a - b
        reaction = kr * a * (p['activity_b'] if er else b) if reactive else 0 * a
        return ka * free - da * a, kb * free - db * b, reaction
    def rhs(t, y):
        ra, rb, product = rates(y)
        return [ra - product, rb - (0 if er else product), product]
    time, y, diag = _solve(rhs, [a0, b0, 0], p)
    a, b, turnover = y
    free = 1 - a - b
    minimum, maximum = float(min(a.min(), b.min(), free.min())), float(max(a.max(), b.max(), free.max()))
    if minimum < -1e-7 or maximum > 1 + 1e-7 or turnover.min() < -1e-7:
        fail('Computed surface populations violate site bounds.', 'SITE_BALANCE_FAILED')
    ra, rb, product = rates(y)
    density = p['site_density_mol_m2']
    coverages = {'A_adsorbed': a, **({'B_adsorbed': b} if not er else {}), 'vacant': free}
    fluxes = {'A_net_adsorption': density * ra, **({'B_net_adsorption': density * rb} if not er else {})}
    if reactive:
        fluxes['product_flux'] = density * product
    charts = [_chart('coverage', 'Surface coverage', 'fraction of sites', coverages),
              _chart('flux', 'Interfacial flux', 'mol m⁻² s⁻¹', fluxes)]
    if reactive:
        charts.append(_chart('product', 'Accumulated product', 'mol m⁻²', {'product': density * turnover}))
    rows = [{'time_s': float(t), **{key: float(v[i]) for key, v in coverages.items()},
             **{key + '_mol_m2_s': float(v[i]) for key, v in fluxes.items()},
             'product_mol_m2': float(density * turnover[i])} for i, t in enumerate(time)]
    diag.update(minimum_coverage=minimum, maximum_coverage=maximum,
                maximum_site_sum_error=float(np.max(np.abs(a + b + free - 1))), final_turnover=float(turnover[-1]))
    if not reactive and da > 0 and db > 0:
        denominator = 1 + ka / da + kb / db
        diag.update(equilibrium_a=ka / da / denominator, equilibrium_b=kb / db / denominator,
                    final_equilibrium_error=float(max(abs(a[-1] - ka / da / denominator), abs(b[-1] - kb / db / denominator))))
    scene = {'kind': 'surface-coverage', 'species': [{'id': key, 'coverage': values.tolist()} for key, values in coverages.items() if key != 'vacant'],
        'description': 'Mean-field coverage on 100 display sites; rounded occupancy, not atom positions, surface crystallography or a molecular trajectory.'}
    return _result(operator, p, time, rows, charts, diag,
        ['theta_* = 1 - theta_A - theta_B', 'r_ads,i = k_ads,i activity_i theta_* - k_des,i theta_i',
         'r_P = k_r theta_A activity_B' if er else 'r_P = k_r theta_A theta_B' if reactive else 'r_P = 0',
         'd theta_A/dt = r_ads,A - r_P; d theta_B/dt = r_ads,B - r_P (B absent for Eley–Rideal)',
         'Product flux = site_density * r_P'],
        ['Isothermal mean-field equivalent single-occupancy sites with maintained reservoir activities; no lateral interactions or spatial correlations.',
         'Rate constants are supplied at one condition. No activation-energy extrapolation, crystallographic mechanism or experimental validation is inferred.'], scene)


@finite_result
def simulate_competitive_adsorption(data):
    return _surface(data, 'simulate_competitive_adsorption')


@finite_result
def simulate_langmuir_hinshelwood(data):
    return _surface(data, 'simulate_langmuir_hinshelwood')


@finite_result
def simulate_eley_rideal(data):
    return _surface(data, 'simulate_eley_rideal')


@finite_result
def simulate_electrode_step(data):
    import numpy as np
    p = _parameters(data, 'simulate_electrode_step')
    j0, alpha, beta = p['exchange_current_a_m2'], p['alpha'], p['electrons'] * F / (R * p['temperature_k'])
    resistance, capacitance, applied, eta0 = p['resistance_ohm_m2'], p['capacitance_f_m2'], p['applied_overpotential_v'], p['initial_overpotential_v']
    def currents(eta):
        z = beta * eta
        if np.any(np.abs(z) > 500):
            fail('Overpotential exceeds the stable exponential range.', 'NUMERICAL_RANGE')
        faradaic = j0 * (np.exp(alpha * z) - np.exp(-(1 - alpha) * z))
        total = (applied - eta) / resistance
        return total, faradaic
    def rhs(t, y):
        total, faradaic = currents(y[0])
        return [(total - faradaic) / capacitance, total, faradaic]
    time, y, diag = _solve(rhs, [eta0, 0, 0], p)
    eta, total_charge, faradaic_charge = y
    total, faradaic = currents(eta)
    capacitive = total - faradaic
    charge_change = capacitance * (eta - eta0)
    error = float(np.max(np.abs(total_charge - faradaic_charge - charge_change)))
    diag.update(maximum_charge_balance_error_c_m2=error, rc_time_constant_s=resistance * capacitance)
    if error > 1e-6 * max(1, float(np.max(np.abs(total_charge))), float(np.max(np.abs(faradaic_charge)))):
        fail('Charge conservation exceeds the supported numerical tolerance.', 'CHARGE_BALANCE_FAILED')
    rows = [{'time_s': float(t), 'overpotential_v': float(eta[i]), 'total_current_a_m2': float(total[i]),
             'faradaic_current_a_m2': float(faradaic[i]), 'capacitive_current_a_m2': float(capacitive[i]),
             'total_charge_c_m2': float(total_charge[i]), 'faradaic_charge_c_m2': float(faradaic_charge[i]),
             'double_layer_charge_change_c_m2': float(charge_change[i])} for i, t in enumerate(time)]
    return _result('simulate_electrode_step', p, time, rows,
        [_chart('current', 'Electrode current', 'A m⁻²', {'total': total, 'faradaic': faradaic, 'capacitive': capacitive}),
         _chart('potential', 'Interfacial overpotential', 'V', {'overpotential': eta}),
         _chart('charge', 'Charge accounting', 'C m⁻²', {'total': total_charge, 'faradaic': faradaic_charge, 'double_layer_change': charge_change})], diag,
        ['j_F = j0 [exp(alpha n F eta/RT) - exp(-(1-alpha)n F eta/RT)]',
         'j_total = (eta_applied - eta)/R_area; C_area d eta/dt = j_total - j_F', 'Q_total = Q_F + C_area (eta - eta_initial)'],
        ['Positive current is anodic; all potentials are relative to the same equilibrium reference.',
         'Maintained reservoir, constant exchange current and capacitance; no diffusion limitation, evolving composition, adsorption or thermal feedback.'])


@finite_result
def simulate_diffusion_film(data):
    import numpy as np
    p = _parameters(data, 'simulate_diffusion_film')
    diffusion, length, rate, bulk, cells = (p[key] for key in ['diffusivity_m2_s', 'film_thickness_m', 'surface_rate_m_s', 'bulk_concentration_mol_m3', 'cells'])
    dx = length / cells
    # Concentrations normalized by bulk; integrated fluxes normalized by bulk*L.
    surface_factor = 1 / (1 + rate * dx / (2 * diffusion))
    def rhs(t, y):
        c = y[:cells]
        internal = diffusion * (c[1:] - c[:-1]) / dx
        surface, reservoir = rate * surface_factor * c[0], 2 * diffusion * (1 - c[-1]) / dx
        derivative = np.diff(np.r_[surface, internal, reservoir]) / dx
        return np.r_[derivative, surface / length, reservoir / length]
    initial = np.r_[np.full(cells, p['initial_fraction']), 0., 0.]
    time, y, diag = _solve(rhs, initial, p)
    profile = y[:cells]
    if profile.min() < -1e-7 or profile.max() > 1 + 1e-7:
        fail('Diffusion profile violates the nonnegative reservoir bounds.', 'CONCENTRATION_BOUND_FAILED')
    cs = profile[0] * surface_factor * bulk
    uptake, inflow = y[-2] * bulk * length, y[-1] * bulk * length
    inventory = profile.mean(axis=0) * bulk * length
    balance = inventory - p['initial_fraction'] * bulk * length - inflow + uptake
    flux, reservoir_flux = rate * cs, 2 * diffusion * bulk * (1 - profile[-1]) / dx
    steady_flux = bulk * rate / (1 + rate * length / diffusion)
    relative_error = float(np.max(np.abs(balance))) / (bulk * length)
    diag.update(maximum_relative_mass_balance_error=relative_error, damkohler=rate * length / diffusion,
        diffusion_time_s=length * length / diffusion, steady_surface_concentration_mol_m3=bulk / (1 + rate * length / diffusion),
        steady_flux_mol_m2_s=steady_flux, final_flux_mol_m2_s=float(flux[-1]), cells=cells)
    if relative_error > 1e-6:
        fail('Diffusion mass conservation exceeds the supported numerical tolerance.', 'MASS_BALANCE_FAILED')
    rows = [{'time_s': float(t), 'surface_concentration_mol_m3': float(cs[i]), 'surface_flux_mol_m2_s': float(flux[i]),
             'reservoir_flux_mol_m2_s': float(reservoir_flux[i]), 'reacted_mol_m2': float(uptake[i]),
             'film_inventory_mol_m2': float(inventory[i]), 'mass_balance_error_mol_m2': float(balance[i])} for i, t in enumerate(time)]
    result = _result('simulate_diffusion_film', p, time, rows,
        [_chart('concentration', 'Surface concentration', 'mol m⁻³', {'surface': cs}),
         _chart('flux', 'Transport and reaction flux', 'mol m⁻² s⁻¹', {'surface_reaction': flux, 'reservoir_supply': reservoir_flux}),
         _chart('inventory', 'Material accounting', 'mol m⁻²', {'reacted': uptake, 'film_inventory': inventory, 'reservoir_net_supply': inflow})], diag,
        ['dc/dt = D d²c/dx²; D dc/dx at x=0 = k_s c_surface; c(L)=c_bulk',
         'Cell-centered finite volumes; c_surface = c_first_cell / (1 + k_s dx/(2D))',
         'Film inventory change = integrated reservoir inflow - integrated surface consumption'],
        ['Planar, isothermal, constant diffusivity, irreversible first-order surface sink and maintained reservoir; no convection, migration or multi-species coupling.',
         'The finite-volume mesh resolves a continuum concentration profile, not molecular coordinates. Refine cells to assess transient mesh convergence.'])
    result['profiles'] = {'distance_m': ((np.arange(cells) + .5) * dx).tolist(), 'concentration_mol_m3': (profile.T * bulk).tolist(), 'bulk_concentration_mol_m3': bulk}
    return result


def operator_specs():
    return [(key, title, 'interfaces', description,
        {'type': 'object', 'properties': {**COMMON, **properties},
         'required': [name for name, rule in properties.items() if 'default' not in rule], 'additionalProperties': False},
        example, source, ['numpy', 'scipy']) for key, (title, description, properties, example, source) in MODELS.items()]


OPERATORS = {name: globals()[name] for name in MODELS}
