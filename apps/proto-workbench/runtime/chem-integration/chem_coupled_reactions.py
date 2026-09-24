"""Coupled thermal, activity and transport studies. Independent equation implementations.

Shares validation, bounded BDF integration and result contracts with chem_reactions.
No physical devices, arbitrary code or external engines are invoked.
"""
from __future__ import annotations

import copy
import math
import chem_reactions as r
from chem_analysis import obj, number, integer, finite_result, fail

n = r.n
THERMAL = {
    'initial_temperature_k': n(200, 1500, 'Initial reactor temperature / K', 298.15),
    'heat_capacity_j_l_k': n(1, 1e6, 'Constant volumetric heat capacity / J L^-1 K^-1'),
    'heat_transfer_w_l_k': n(0, 1e6, 'UA / reactor volume / W L^-1 K^-1'),
    'coolant_temperature_k': n(200, 1500, 'Fixed coolant temperature / K'),
    'reaction_enthalpy_j_mol': {'type': 'object', 'minProperties': 1,
        'description': 'Every reaction ID mapped to ΔH / J per mol of reaction extent; negative is exothermic. Explicit values required; cycles must be consistent.',
        'additionalProperties': n(-1e6, 1e6, 'Reaction enthalpy / J mol^-1')},
}
THERMAL_EXAMPLE = {'example': 'consecutive', 'heat_capacity_j_l_k': 2000, 'heat_transfer_w_l_k': 10,
                   'coolant_temperature_k': 295, 'reaction_enthalpy_j_mol': {'A_to_B': -40000, 'B_to_C': -10000}, 'duration_s': 60}
MODELS = {
    'simulate_nonisothermal_batch': ('Nonisothermal batch reactor', 'kinetics', True,
        'Couple a validated network to Arrhenius temperature feedback, cooling and explicit cumulative energy accounting.',
        THERMAL, THERMAL_EXAMPLE),
    'simulate_nonisothermal_cstr': ('Nonisothermal stirred reactor', 'kinetics', True,
        'Resolve stirred-reactor startup with feed enthalpy, coolant heat transfer and coupled material and energy balances.',
        {**THERMAL, 'residence_time_s': n(1e-4, 1e5, 'Volume / volumetric flow / s'), 'feed_mol_l': r.FEED,
         'feed_temperature_k': n(200, 1500, 'Feed temperature / K')},
        {**THERMAL_EXAMPLE, 'residence_time_s': 10, 'feed_mol_l': {'A': 1}, 'feed_temperature_k': 298.15, 'duration_s': 100}),
    'simulate_tanks_in_series': ('Tanks in series', 'kinetics', True,
        'Simulate equal-volume stirred stages with a shared validated network, outlet curves and a synchronized stage concentration profile.',
        {'stages': {'type': 'integer', 'minimum': 1, 'maximum': 16, 'default': 4},
         'residence_time_s': n(1e-4, 1e5, 'Total train residence time / s'), 'feed_mol_l': r.FEED,
         'target_species': {'type': 'string', 'description': 'Existing species ID for the stage profile'}},
        {'example': 'consecutive', 'residence_time_s': 20, 'feed_mol_l': {'A': 1}, 'target_species': 'B', 'duration_s': 100}),
    'simulate_catalyst_deactivation': ('Catalyst deactivation & regeneration', 'kinetics', True,
        'Scale selected elementary rates by a time-dependent activity with first-order loss and regeneration; retain unselected pathways.',
        {'reaction_ids': r.SELECT, 'initial_activity': n(0, 1, 'Initial fractional activity', 1),
         'deactivation_s': n(0, 1e4, 'First-order activity loss / s^-1'),
         'regeneration_s': n(0, 1e4, 'Regeneration toward unit activity / s^-1')},
        {'example': 'consecutive', 'reaction_ids': ['A_to_B'], 'deactivation_s': .08, 'regeneration_s': .01, 'duration_s': 60}),
    'simulate_gas_liquid_reaction': ('Gas–liquid reaction & transfer', 'interfaces', False,
        'Couple maintained gas-reservoir transfer to dissolved A + B → P with signed absorption/stripping and gas inventory accounting.',
        {'kla_s': n(0, 1e4, 'Volumetric transfer coefficient / s^-1'),
         'saturation_mol_l': n(0, 1e3, 'Dissolved equilibrium A concentration imposed by the gas reservoir / mol L^-1'),
         'reaction_l_mol_s': n(0, 1e6, 'A + B → P second-order coefficient / L mol^-1 s^-1'),
         'initial_a_mol_l': n(0, 1e3, 'Initial dissolved A / mol L^-1', 0),
         'initial_b_mol_l': n(0, 1e3, 'Initial nonvolatile B / mol L^-1'),
         'initial_p_mol_l': n(0, 1e3, 'Initial product / mol L^-1', 0)},
        {'kla_s': .15, 'saturation_mol_l': .1, 'reaction_l_mol_s': 2, 'initial_b_mol_l': 1, 'duration_s': 120}),
    'simulate_catalyst_pellet': ('Spherical catalyst pellet', 'interfaces', False,
        'Resolve transient radial pore concentrations, external film transfer and first-order reaction using conservative spherical finite volumes.',
        {'radius_m': n(1e-7, 1e-2, 'Pellet radius / m'),
         'effective_diffusivity_m2_s': n(1e-15, 1e-6, 'Effective diffusivity based on total pellet area / m² s^-1'),
         'porosity': n(.01, 1, 'Pore volume / total pellet volume', .4),
         'film_transfer_m_s': n(0, 1, 'External film transfer coefficient / m s^-1'),
         'reaction_rate_s': n(0, 1e5, 'Rate per pellet volume = coefficient × pore concentration / s^-1'),
         'bulk_concentration_mol_m3': n(1e-9, 1e6, 'Maintained external bulk concentration / mol m^-3 of fluid'),
         'initial_fraction': n(0, 1, 'Initial uniform pore concentration / bulk concentration', 0),
         'cells': {'type': 'integer', 'minimum': 8, 'maximum': 80, 'default': 40}},
        {'radius_m': .0005, 'effective_diffusivity_m2_s': 1e-9, 'film_transfer_m_s': 1e-5,
         'reaction_rate_s': .02, 'bulk_concentration_mol_m3': 1, 'duration_s': 200}),
}


def _properties(key):
    props = {**r.COMMON, **MODELS[key][4]}
    if key.startswith('simulate_nonisothermal_') or not MODELS[key][2]:
        props.pop('temperature_k')
    return props


def _parameters(data, key):
    props = _properties(key)
    obj(data, 'input', set(props) | ({'network', 'example'} if MODELS[key][2] else set()))
    params = copy.deepcopy(data)
    for name, rule in props.items():
        value = params.get(name, rule.get('default'))
        if rule['type'] == 'number':
            value = number(value, name, rule['minimum'], rule['maximum'])
        elif rule['type'] == 'integer':
            value = integer(value, name, rule['minimum'], rule['maximum'])
        elif value is None:
            fail(f'{name} is required.')
        params[name] = value
    if MODELS[key][2] and ('network' in params) == ('example' in params):
        fail('Supply exactly one of network or example.')
    return params


def _prepare(params):
    base = {k: v for k, v in params.items() if k in r.BASE}
    if 'initial_temperature_k' in params:
        base['temperature_k'] = params['initial_temperature_k']
    return r.PREPARE(base, geometry=False, allow_empty=True)


def _result(key, *args, **kwargs):
    return r._result(key, *args, title=MODELS[key][0], **kwargs)


def _thermal(data, key):
    import numpy as np
    params = _parameters(data, key)
    p = _prepare(params)
    reactions = p['network']['reactions']; count = len(p['ids'])
    ids = [step['id'] for step in reactions]
    heat = obj(params['reaction_enthalpy_j_mol'], 'reaction_enthalpy_j_mol', set(ids))
    if set(heat) != set(ids):
        fail('Provide an explicit reaction enthalpy for every reaction ID.')
    dh = np.array([number(heat[sid], f'enthalpy.{sid}', -1e6, 1e6) for sid in ids])
    h = np.linalg.lstsq(p['stoich'].T, dh, rcond=None)[0]
    heat_residual = float(max(abs(p['stoich'].T @ h-dh)))
    if heat_residual > max(1e-6, float(max(abs(dh)))*1e-7):
        fail('Reaction enthalpies are inconsistent around a stoichiometric cycle (including reverse steps).')
    cv, transfer, coolant = (params[k] for k in ['heat_capacity_j_l_k', 'heat_transfer_w_l_k', 'coolant_temperature_k'])
    initial_t = params['initial_temperature_k']; flow = key.endswith('_cstr')
    feed = r._feed(params, p) if flow else np.zeros(count)
    tau = params.get('residence_time_s', 1)
    reference = np.array([step['rate_constant'] for step in reactions])
    activation = np.array([step.get('activation_energy_j_mol', 0) for step in reactions])
    reference_t = np.array([step.get('reference_temperature_k', 298.15) for step in reactions])
    def rates(c, temperature):
        if not 150 <= temperature <= 2000:
            fail('Temperature left the 150–2000 K numerical envelope. Reassess heat, units and model assumptions.', 'THERMAL_RANGE')
        exponent = -activation/8.314462618*(1/temperature-1/reference_t)
        if max(abs(exponent)) > 100:
            fail('Arrhenius exponent exceeded the numerical range.', 'THERMAL_RANGE')
        effective = reference*np.exp(exponent)
        if max(effective) > 1e15:
            fail('Temperature-adjusted rate constant exceeds numerical bounds.', 'RATE_RANGE')
        return r._rates(p, c, effective)
    def terms(y):
        c, temperature = y[:count], y[count]
        flux = rates(c, temperature)
        net_flow = (feed-c)/tau if flow else np.zeros(count)
        powers = np.array([-dh @ flux, transfer*(temperature-coolant),
                           cv*(params['feed_temperature_k']-temperature)/tau if flow else 0])
        return flux, net_flow, powers
    def rhs(t, y):
        flux, net_flow, power = terms(y)
        return np.r_[p['stoich'] @ flux+net_flow, (power[0]-power[1]+power[2])/cv, power, net_flow]
    time, y, diag = r._integrate(rhs, np.r_[p['initial'], initial_t, np.zeros(3+count)], p)
    c, temperature, cumulative, flow_inventory = y[:count], y[count], y[count+1:count+4], y[count+4:]
    diag.update(r._balance(p, c-p['initial'][:, None]-flow_inventory, max(1, float(max(feed)), float(max(p['initial'])))))
    energy_error = float(max(abs(cv*(temperature-initial_t)-(cumulative[0]-cumulative[1]+cumulative[2]))))
    if energy_error > max(1e-6, float(abs(cumulative).max())*1e-7):
        fail('Energy balance exceeded tolerance.', 'ENERGY_BALANCE_FAILED')
    flux = np.stack([terms(yi)[0] for yi in y.T], axis=1)
    powers = np.stack([terms(yi)[2] for yi in y.T], axis=1)
    diag.update(max_energy_balance_error_j_l=energy_error, thermochemical_cycle_residual_j_mol=heat_residual,
                minimum_temperature_k=float(min(temperature)), maximum_temperature_k=float(max(temperature)))
    names = ['Reaction heat', 'Heat removed to coolant', 'Feed sensible heat']
    result = _result(key, params, p, time, c, flux, diag,
        [r._chart('temperature', 'Reactor temperature', 'K', {'Reactor': temperature}),
         r._chart('heat-power', 'Volumetric heat rates', 'W L⁻¹', dict(zip(names, powers))),
         r._chart('heat-inventory', 'Cumulative heat accounting', 'J L⁻¹', dict(zip(names, cumulative)))],
        {'temperature_k': temperature, **{f'{name}_w_l': value for name, value in zip(['reaction', 'cooling', 'feed'], powers)},
         **{f'{name}_j_l': value for name, value in zip(['reaction', 'cooling', 'feed'], cumulative)}},
        ['dc/dt = S r + (c_feed-c)/tau [flow term only for CSTR]',
         'Cv dT/dt = -sum(ΔH_j r_j) - (UA/V)(T-T_cool) + Cv(T_feed-T)/tau [CSTR only]',
         'k_j(T) = k_ref exp[-Ea/R (1/T-1/T_ref)]'])
    result['warnings'][0] = 'Constant volume, density, heat capacity and reaction enthalpies; ideal liquid with no phase change, pressure or coolant dynamics. Temperatures do not establish physical feasibility.'
    result['warnings'].append('Enthalpy cycle consistency is checked; detailed balance of supplied reversible rate constants is not established.')
    if not activation.any():
        result['warnings'].append('No nonzero activation energies were supplied: rate constants in this run are temperature independent.')
    result['method']['initial_rate_constants'] = result['method'].pop('effective_rate_constants')
    return result


def simulate_nonisothermal_batch(data):
    return _thermal(data, 'simulate_nonisothermal_batch')


def simulate_nonisothermal_cstr(data):
    return _thermal(data, 'simulate_nonisothermal_cstr')


def simulate_tanks_in_series(data):
    import numpy as np
    key = 'simulate_tanks_in_series'; params = _parameters(data, key); p = _prepare(params)
    stages, count = params['stages'], len(p['ids']); target = r._target(params, p)
    feed = r._feed(params, p); tau = params['residence_time_s']/stages
    def rhs(t, y):
        c = y[:stages*count].reshape(stages, count)
        upstream = np.vstack([feed, c[:-1]])
        derivatives = np.stack([p['stoich'] @ r._rates(p, ci) for ci in c])+(upstream-c)/tau
        return np.r_[derivatives.ravel(), (feed-c[-1])/params['residence_time_s']]
    time, y, diag = r._integrate(rhs, np.r_[np.tile(p['initial'], stages), np.zeros(count)], p)
    c = y[:stages*count].reshape(stages, count, -1)
    r._check_concentrations(c, max(1, float(max(feed)), float(max(p['initial']))))
    diag.update(r._balance(p, c.mean(axis=0)-p['initial'][:, None]-y[stages*count:], max(1, float(max(feed)))))
    diag.update(stages=stages, stage_residence_time_s=tau, final_derivative_mol_l_s=float(max(abs(rhs(time[-1], y[:, -1])[:stages*count]))))
    flux = np.stack([r._rates(p, ci) for ci in c[-1].T], axis=1)
    result = _result(key, params, p, time, c[-1], flux, diag,
        [r._chart('stages', params['target_species']+' by reactor stage', 'mol L⁻¹', {f'Stage {i+1}': c[i, target] for i in range(stages)})],
        {f'stage_{i+1}_{sid}_mol_l': c[i, j] for i in range(stages) for j, sid in enumerate(p['ids'])},
        ['dc_i/dt = S r(c_i) + (c_(i-1)-c_i)/(tau_total/N)', 'c_0 = feed; all equal-volume stages use the declared initial concentrations'])
    result['charts'][0]['title'] = 'Outlet concentrations'
    result['charts'][1]['title'] = 'Outlet elementary reaction rates'
    result['spatial_profile'] = {'title': params['target_species']+' across reactor stages', 'x_label': 'Stage', 'x_unit': '',
        'y_label': params['target_species'], 'y_unit': 'mol L⁻¹', 'x': list(range(1, stages+1)), 'values': c[:, target].T.tolist()}
    return result


def simulate_catalyst_deactivation(data):
    import numpy as np
    key = 'simulate_catalyst_deactivation'; params = _parameters(data, key); p = _prepare(params)
    selected = params['reaction_ids']; ids = [step['id'] for step in p['network']['reactions']]
    if not isinstance(selected, list) or not 1 <= len(selected) <= 8 or any(not isinstance(sid, str) or sid not in ids for sid in selected) or len(set(selected)) != len(selected):
        fail('reaction_ids must contain 1–8 unique existing reaction IDs.')
    mask = np.array([sid in selected for sid in ids]); kd, kr = params['deactivation_s'], params['regeneration_s']
    def flux(c, activity):
        return r._rates(p, c, p['k']*np.where(mask, max(0, activity), 1))
    def rhs(t, y):
        return np.r_[p['stoich'] @ flux(y[:-1], y[-1]), -kd*y[-1]+kr*(1-y[-1])]
    time, y, diag = r._integrate(rhs, np.r_[p['initial'], params['initial_activity']], p)
    c, activity = y[:-1], y[-1]
    if min(activity) < -1e-8 or max(activity) > 1+1e-8:
        fail('Activity left the physical interval [0,1].', 'ACTIVITY_RANGE')
    diag.update(r._balance(p, c-p['initial'][:, None], max(1, float(max(p['initial'])))))
    rates = np.stack([flux(ci, a) for ci, a in zip(c.T, activity)], axis=1)
    result = _result(key, params, p, time, c, rates, diag,
        [r._chart('activity', 'Catalyst activity', 'fraction', {'Activity': activity})], {'activity': activity},
        ['da/dt = -k_d a + k_r(1-a)', 'Selected rates = a × nominal elementary rates; unselected steps unchanged'])
    result['method']['nominal_rate_constants'] = result['method'].pop('effective_rate_constants')
    result['warnings'].append('Activity is a phenomenological multiplier, not a resolved catalyst mass balance, poisoning or regeneration mechanism. For reversible steps, scaling only one direction changes the implied equilibrium ratio.')
    return result


def simulate_gas_liquid_reaction(data):
    import numpy as np
    key = 'simulate_gas_liquid_reaction'; params = _parameters(data, key)
    network = {'label': 'Dissolved gas A + B → P', 'species': [r._species('A', params['initial_a_mol_l'], {'A': 1}),
        r._species('B', params['initial_b_mol_l'], {'B': 1}), r._species('P', params['initial_p_mol_l'], {'A': 1, 'B': 1})],
        'reactions': [r._reaction('reaction', {'A': 1, 'B': 1}, {'P': 1}, params['reaction_l_mol_s'])]}
    p = r.PREPARE({'network': network, 'duration_s': params['duration_s'], 'points': params['points']}, geometry=False, allow_empty=True)
    kla, saturation = params['kla_s'], params['saturation_mol_l']
    def rhs(t, y):
        transfer = kla*(saturation-y[0]); rate = r._rates(p, y[:3])[0]
        return np.array([transfer-rate, -rate, rate, transfer])
    time, y, diag = r._integrate(rhs, np.r_[p['initial'], 0], p)
    c = y[:3]; inventory = np.zeros_like(c); inventory[0] = y[3]
    diag.update(r._balance(p, c-p['initial'][:, None]-inventory, max(1, saturation, float(max(p['initial'])))))
    rates = np.stack([r._rates(p, ci) for ci in c.T], axis=1); transfer = kla*(saturation-c[0])
    result = _result(key, params, p, time, c, rates, diag,
        [r._chart('transfer', 'Gas–liquid transfer rate', 'mol L⁻¹ s⁻¹', {'Absorption (positive) / stripping (negative)': transfer}),
         r._chart('gas-inventory', 'Cumulative gas transferred', 'mol L⁻¹', {'Net gas transferred': y[3]})],
        {'transfer_mol_l_s': transfer, 'cumulative_transfer_mol_l': y[3]},
        ['J = kLa (C_sat - A)', 'r = k A B', 'dA/dt = J-r; dB/dt = -r; dP/dt = r'])
    result['warnings'].append('Maintained gas reservoir, constant liquid volume and temperature; saturation is supplied explicitly, not inferred from Henry constants. No gas depletion or interfacial reaction enhancement is modeled.')
    return result


def simulate_catalyst_pellet(data):
    import numpy as np
    key = 'simulate_catalyst_pellet'; params = _parameters(data, key)
    radius, diffusion, film, rate, bulk, eps = (params[k] for k in ['radius_m', 'effective_diffusivity_m2_s', 'film_transfer_m_s', 'reaction_rate_s', 'bulk_concentration_mol_m3', 'porosity'])
    cells = params['cells']; faces = np.linspace(0, radius, cells+1); centers = (faces[:-1]+faces[1:])/2
    volumes = np.diff(faces**3)/3; weights = volumes/sum(volumes)
    conductance = diffusion/(1/centers[:-1]-1/centers[1:])
    boundary = 0 if film == 0 else 1/(1/(film*radius**2)+(1/centers[-1]-1/radius)/diffusion)
    def rhs(t, y):
        u = y[:cells]; inter = conductance*np.diff(u)
        flows = np.r_[inter, boundary*(1-u[-1])]-np.r_[0, inter]
        mean = weights @ u
        return np.r_[(flows/volumes-rate*u)/eps, rate*mean, boundary*(1-u[-1])/sum(volumes)]
    p = {'duration': params['duration_s'], 'points': params['points']}
    time, y, diag = r._integrate(rhs, np.r_[np.full(cells, params['initial_fraction']), 0, 0], p)
    u = y[:cells]; r._check_concentrations(u, 1)
    if u.max() > 1+1e-7:
        fail('Pore concentrations exceeded the maintained bulk reservoir.', 'CONCENTRATION_RANGE')
    mean = weights @ u
    balance = eps*(mean-params['initial_fraction'])+y[-2]-y[-1]
    error = float(max(abs(balance)))
    if error > max(1e-8, float(abs(y[-2:]).max())*1e-6):
        fail('Pellet inventory balance exceeded tolerance.', 'MASS_BALANCE_FAILED')
    surface = 1-boundary*(1-u[-1])/(film*radius**2) if film else u[-1]
    influx = boundary*(1-u[-1])*bulk/radius**2
    phi = radius*math.sqrt(rate/diffusion)
    eta = 1-phi**2/15+2*phi**4/315 if phi < 1e-3 else 3*(phi/math.tanh(phi)-1)/phi**2
    # An isolated, nonreacting pellet retains its declared initial concentration.
    steady_surface = 1/(1+eta*rate*radius/(3*film)) if film else (0 if rate else params['initial_fraction'])
    diag.update(max_inventory_balance_error_mol_m3=error*bulk, thiele_modulus=phi, biot_number=film*radius/diffusion,
        analytical_internal_effectiveness=eta, analytical_steady_surface_mol_m3=steady_surface*bulk,
        analytical_steady_inward_flux_mol_m2_s=rate*eta*steady_surface*bulk*radius/3,
        final_profile_derivative_mol_m3_s=float(max(abs(rhs(time[-1], y[:, -1])[:cells])))*bulk,
        minimum_raw_concentration_mol_m3=float(u.min())*bulk, cells=cells)
    rows = [{'time_s': float(t), 'mean_pore_mol_m3': float(mean[i]*bulk), 'surface_mol_m3': float(surface[i]*bulk),
        'inward_flux_mol_m2_s': float(influx[i]), 'consumption_mol_m3_s': float(rate*mean[i]*bulk),
        'stored_mol_m3_pellet': float(eps*mean[i]*bulk), 'cumulative_reacted_mol_m3_pellet': float(y[-2, i]*bulk),
        'cumulative_inflow_mol_m3_pellet': float(y[-1, i]*bulk)} for i, t in enumerate(time)]
    return {'kind': 'reaction-study', 'model': key, 'title': MODELS[key][0], 'time_s': time.tolist(), 'axis_label': 'Time',
        'network': {'label': 'Irreversible first-order pellet consumption', 'species': [r._species('A', 0, {'M': 1}), r._species('P', 0, {'M': 1})],
                    'reactions': [r._reaction('consumption', {'A': 1}, {'P': 1}, rate)]}, 'rows': rows,
        'charts': [r._chart('concentration', 'Pore concentrations', 'mol m⁻³ fluid', {'Volume mean': mean*bulk, 'Outer surface': surface*bulk}),
                   r._chart('transfer', 'Inward external flux', 'mol m⁻² s⁻¹', {'Film flux': influx}),
                   r._chart('consumption', 'Reaction per pellet volume', 'mol m⁻³ s⁻¹', {'Consumption': rate*mean*bulk}),
                   r._chart('inventory', 'Pellet inventory accounting', 'mol m⁻³ pellet', {'Stored': eps*mean*bulk, 'Reacted': y[-2]*bulk, 'Net inflow': y[-1]*bulk})],
        'spatial_profile': {'title': 'Radial pore concentration', 'x_label': 'Radius', 'x_unit': 'm', 'y_label': 'Pore concentration',
                            'y_unit': 'mol m⁻³', 'x': centers.tolist(), 'values': (u.T*bulk).tolist()},
        'diagnostics': diag, 'method': {'parameters': params, 'implementation': 'Independent conservative spherical finite volumes / SciPy BDF',
            'equations': ['epsilon dC/dt = D_eff/r² d/dr(r² dC/dr) - k_v C', 'dC/dr(0)=0; D_eff dC/dr(R)=k_f(C_bulk-C_surface)',
                          'phi=R sqrt(k_v/D_eff); eta=3(phi coth(phi)-1)/phi²',
                          'stored inventory per pellet volume = epsilon × mean pore concentration']},
        'warnings': ['Isothermal spherical homogeneous pellet, fixed bulk reservoir, constant porosity and transport coefficients; dilute or equimolar diffusion and first-order kinetics only.',
                     'Pore concentrations are per fluid volume; reaction and cumulative inventory are per total pellet volume. Product transport is not resolved.',
                     'The radial profile is a continuum model, not molecular motion. Analytical diagnostics are steady-state references; the simulated endpoint is not automatically a steady state.']}


def operator_specs(sim_properties):
    specs = []
    for key, (title, category, network, description, fields, example) in MODELS.items():
        properties = {**({name: sim_properties[name] for name in ['network', 'example']} if network else {}), **_properties(key)}
        schema = {'type': 'object', 'properties': properties, 'additionalProperties': False,
                  'required': [name for name, rule in fields.items() if 'default' not in rule]}
        if network:
            schema['oneOf'] = [{'required': ['network'], 'not': {'required': ['example']}}, {'required': ['example'], 'not': {'required': ['network']}}]
        specs.append((key, title, category, description, schema,
            {**{name: rule['default'] for name, rule in properties.items() if 'default' in rule}, **example},
            'Independent coupled-reaction equations / shared validation / SciPy', ['numpy', 'scipy', *(['rdkit'] if network else [])]))
    return specs


OPERATORS = {name: finite_result(globals()[name]) for name in MODELS}
