"""Reaction studies using the shared validated network contract.

Independent equations, not a Cantera runtime adapter. See docs/chem-reaction-studies.md.
No user code, filesystem paths, instruments or network access are accepted.
"""
from __future__ import annotations

import copy
import math
from chem_analysis import obj, number, integer, finite_result, fail

PREPARE = None
RTOL, ATOL = 1e-9, 1e-12
BASE = {'network', 'example', 'temperature_k', 'duration_s', 'points'}


def bind_kernel(prepare):
    global PREPARE
    PREPARE = prepare


def n(low, high, description, default=None):
    return {'type': 'number', 'minimum': low, 'maximum': high, 'description': description,
            **({'default': default} if default is not None else {})}


COMMON = {'duration_s': n(1e-6, 1e5, 'Simulation duration / s', 30),
          'points': {'type': 'integer', 'minimum': 2, 'maximum': 501, 'default': 151},
          'temperature_k': n(200, 1500, 'Isothermal temperature / K', 298.15)}
SELECT = {'type': 'array', 'items': {'type': 'string'}, 'minItems': 1, 'maxItems': 8, 'uniqueItems': True}
FEED = {'type': 'object', 'description': 'Inlet concentrations / mol L^-1; omitted known species have zero feed',
        'minProperties': 1, 'additionalProperties': n(0, 1e6, 'mol/L')}
CHAIN = {**{f'k_{step}_s': n(1e-10, 1e4, 'First-order rate coefficient / s^-1') for step in ['ab', 'ba', 'bc', 'cb']},
         **{f'initial_{sid}_mol_l': n(0, 1e3, 'Initial concentration / mol L^-1', 0) for sid in ['a', 'b', 'c']}}
CATALYST = {
    'substrate_mol_l': n(0, 1e3, 'Initial free substrate / mol L^-1'),
    'product_mol_l': n(0, 1e3, 'Initial free product / mol L^-1', 0),
    'catalyst_mol_l': n(1e-9, 1e3, 'Initial free catalyst / mol L^-1'),
    'inhibitor_mol_l': n(0, 1e3, 'Initial free competitive inhibitor / mol L^-1', 0),
    'binding_l_mol_s': n(0, 1e6, 'E + S -> ES association / L mol^-1 s^-1'),
    'dissociation_s': n(0, 1e4, 'ES -> E + S dissociation / s^-1'),
    'turnover_s': n(0, 1e4, 'ES -> E + P turnover / s^-1'),
    'product_binding_l_mol_s': n(0, 1e6, 'E + P -> ES reverse turnover / L mol^-1 s^-1', 0),
    'inhibitor_binding_l_mol_s': n(0, 1e6, 'E + I -> EI binding / L mol^-1 s^-1', 0),
    'inhibitor_dissociation_s': n(0, 1e4, 'EI -> E + I dissociation / s^-1', 0),
}
MODELS = {
    'simulate_reversible_chain': ('Reversible reaction cascade', 'mechanisms',
        'Resolve A ⇌ B ⇌ C, forward/reverse fluxes, kinetic equilibrium and relaxation times.', CHAIN,
        {'k_ab_s': .4, 'k_ba_s': .1, 'k_bc_s': .2, 'k_cb_s': .05, 'initial_a_mol_l': 1, 'duration_s': 40}),
    'simulate_catalytic_cycle': ('Catalytic cycle & inhibition', 'mechanisms',
        'Resolve free catalyst, substrate complex, competitive inhibitor binding and reversible product release without a steady-state approximation.', CATALYST,
        {'substrate_mol_l': 1, 'catalyst_mol_l': .05, 'inhibitor_mol_l': .1,
         'binding_l_mol_s': 2, 'dissociation_s': .2, 'turnover_s': .5,
         'product_binding_l_mol_s': .05, 'inhibitor_binding_l_mol_s': 3, 'inhibitor_dissociation_s': .1, 'duration_s': 80}),
    'simulate_cstr': ('Stirred flow reactor', 'reactors',
        'Simulate isothermal constant-volume CSTR startup with arbitrary validated kinetics, inlet/outlet accounting and steady-state residuals.',
        {'residence_time_s': n(1e-4, 1e5, 'Volume / volumetric flow / s'), 'feed_mol_l': FEED},
        {'example': 'consecutive', 'residence_time_s': 10, 'feed_mol_l': {'A': 1}, 'duration_s': 100}),
    'simulate_pfr': ('Plug flow reactor', 'reactors',
        'Resolve steady isothermal, constant-density plug flow along residence time, including conversion and reaction-rate profiles.',
        {'residence_time_s': n(1e-4, 1e5, 'Outlet residence time / s')},
        {'example': 'consecutive', 'residence_time_s': 30}),
    'simulate_semibatch': ('Fed-batch reactor', 'reactors',
        'Integrate species amounts with a continuous feed, increasing volume, dilution and explicit inventory balances.',
        {'initial_volume_l': n(1e-6, 1e6, 'Initial liquid volume / L'),
         'feed_l_s': n(0, 1e3, 'Constant liquid feed / L s^-1'), 'feed_mol_l': FEED},
        {'example': 'consecutive', 'initial_volume_l': 1, 'feed_l_s': .01, 'feed_mol_l': {'A': 2}, 'duration_s': 60}),
    'analyze_reaction_sensitivity': ('Kinetic parameter sensitivity', 'reaction-analysis',
        'Integrate forward log-rate sensitivities using the mass-action Jacobian; inspect signed concentration response and parameter ranking.',
        {'reaction_ids': SELECT, 'target_species': {'type': 'string', 'description': 'Existing species ID'}},
        {'example': 'consecutive', 'reaction_ids': ['A_to_B', 'B_to_C'], 'target_species': 'B', 'duration_s': 30}),
    'analyze_reaction_flux': ('Reaction extents & pathway flux', 'reaction-analysis',
        'Integrate reaction extents and resolve each step’s contribution to formation or consumption of a selected species.',
        {'target_species': {'type': 'string', 'description': 'Existing species ID'}},
        {'example': 'parallel', 'target_species': 'A', 'duration_s': 30}),
    'propagate_reaction_uncertainty': ('Kinetic uncertainty propagation', 'reaction-analysis',
        'Propagate independently declared lognormal rate uncertainty with a fixed seed; inspect empirical concentration quantiles and saved rate draws.',
        {'reaction_ids': SELECT, 'target_species': {'type': 'string', 'description': 'Existing species ID'},
         'log_rate_sd': n(0, 1, 'Standard deviation of ln(k); supplied rate is the median'),
         'samples': {'type': 'integer', 'minimum': 8, 'maximum': 128, 'default': 32},
         'seed': {'type': 'integer', 'minimum': 0, 'maximum': 2147483647, 'default': 20260919}},
        {'example': 'consecutive', 'reaction_ids': ['A_to_B', 'B_to_C'], 'target_species': 'B', 'log_rate_sd': .2, 'samples': 32, 'duration_s': 30}),
}


def _parameters(data, operator):
    props = {**COMMON, **MODELS[operator][3]}
    network_model = MODELS[operator][1] != 'mechanisms'
    if operator == 'simulate_pfr':
        props.pop('duration_s')
    obj(data, 'input', set(props) | ({'network', 'example'} if network_model else set()))
    result = copy.deepcopy(data)
    for name, rule in props.items():
        if name not in result and 'default' in rule:
            result[name] = rule['default']
        value = result.get(name)
        if rule['type'] == 'number':
            result[name] = number(value, name, rule['minimum'], rule['maximum'])
        elif rule['type'] == 'integer':
            result[name] = integer(value, name, rule['minimum'], rule['maximum'])
        elif value is None:
            fail(f'{name} is required.')
    if network_model and ('network' in data) == ('example' in data):
        fail('Supply exactly one of network or example.')
    return result


def _prepared(params, operator):
    base = {key: value for key, value in params.items() if key in BASE}
    if operator == 'simulate_pfr':
        base['duration_s'] = params['residence_time_s']
    return PREPARE(base, geometry=False, allow_empty=operator in {'simulate_cstr', 'simulate_semibatch'})


def _rates(p, c, k=None):
    import numpy as np
    with np.errstate(over='raise', invalid='raise'):
        return (p['k'] if k is None else k) * np.prod(np.maximum(c, 0)[:, None] ** p['orders'], axis=0)


def _integrate(rhs, initial, p, *, max_step=float('inf'), jac_sparsity=None):
    import numpy as np
    from scipy.integrate import solve_ivp
    calls = 0
    def bounded(t, y):
        nonlocal calls
        calls += 1
        if calls > 60000:
            fail('Reaction study exceeded its solver evaluation budget.', 'SOLVER_BUDGET')
        value = rhs(t, y)
        if not np.isfinite(value).all():
            fail('Nonfinite derivative; check rate constants, units and time range.', 'SOLVER_RANGE')
        return value
    time = np.linspace(0, p['duration'], p['points'])
    sol = solve_ivp(bounded, (0, p['duration']), initial, method='BDF', t_eval=time, rtol=RTOL, atol=ATOL, max_step=max_step, jac_sparsity=jac_sparsity)
    if not sol.success or sol.y.shape[1] != len(time) or not np.isfinite(sol.y).all():
        fail('Reaction integration did not complete: ' + str(sol.message), 'SOLVER_FAILED')
    return time, sol.y, {'solver': 'SciPy solve_ivp / BDF', 'rtol': RTOL, 'atol': ATOL, 'nfev': int(sol.nfev)}


def _check_concentrations(c, scale):
    if c.min() < -max(1e-9, scale * 1e-7):
        fail('Concentrations became negative beyond numerical tolerance.', 'NEGATIVE_CONCENTRATION')


def _balance(p, corrected, scale):
    import numpy as np
    from scipy.linalg import null_space
    residual = 0.0
    invariants = []
    for vector in null_space(p['stoich'].T).T:
        vector /= max(np.abs(vector))
        error = vector @ corrected
        drift = float(np.max(np.abs(error)))
        residual = max(residual, drift)
        invariants.append({'weights': dict(zip(p['ids'], vector.tolist())), 'max_absolute_error': drift})
    if residual > max(1e-8, scale * 1e-6):
        fail('Reaction inventory balance exceeded tolerance.', 'MASS_BALANCE_FAILED')
    return {'max_inventory_balance_error': residual, 'balance_scale': scale,
            'composition_balance_verified': p['balanced'], 'stoichiometric_invariants': invariants}


def _chart(key, title, unit, columns):
    return {'id': key, 'title': title, 'unit': unit,
            'series': [{'id': name, 'label': name, 'values': values.tolist()} for name, values in columns.items()]}


def _result(operator, params, p, time, c, rates, diag, extra_charts=(), extra_rows=None, equations=(), *, title=None):
    import numpy as np
    _check_concentrations(c, max(float(p['initial'].max()), 1e-8))
    rids = [r['id'] for r in p['network']['reactions']]
    axis = 'Residence time' if operator == 'simulate_pfr' else 'Time'
    rows = [{'time_s': float(t), **{sid + '_mol_l': float(c[j, i]) for j, sid in enumerate(p['ids'])},
             **{rid + '_rate_mol_l_s': float(rates[j, i]) for j, rid in enumerate(rids)},
             **{key: float(values[i]) for key, values in (extra_rows or {}).items()}} for i, t in enumerate(time)]
    warnings = ['Isothermal ideal liquid kinetics; coefficients and mechanism are supplied assumptions, not inferred from chemical identity.',
                'Examples use abstract species or conserved moieties. Population graphics are schematics, not atomic reaction trajectories.']
    if p['balanced'] is None:
        warnings.append('Species compositions are incomplete: only declared stoichiometric invariants, not elemental or charge balance, can be checked.')
    result = {'kind': 'reaction-study', 'model': operator, 'title': title or MODELS[operator][0], 'time_s': time.tolist(),
              'axis_label': axis, 'network': p['network'], 'rows': rows,
              'charts': [_chart('concentration', 'Concentration', 'mol L⁻¹', dict(zip(p['ids'], c))),
                         _chart('rates', 'Elementary reaction rates', 'mol L⁻¹ s⁻¹', dict(zip(rids, rates))), *extra_charts],
              'diagnostics': {**diag, 'minimum_raw_concentration': float(c.min())},
              'method': {'parameters': params, 'equations': ['r_j = k_j(T) product(c_i ^ order_ij)', *equations],
                         'implementation': 'Shared validated mass-action network / independent SciPy reaction study',
                         'effective_rate_constants': dict(zip(rids, p['k'].tolist()))}, 'warnings': warnings}
    return result


def _batch(p, rates=None):
    import numpy as np
    time, c, diag = _integrate(lambda t, y: p['stoich'] @ _rates(p, y, rates), p['initial'], p)
    _check_concentrations(c, float(p['initial'].max()))
    diag.update(_balance(p, c-p['initial'][:, None], float(p['initial'].max())))
    flux = np.stack([_rates(p, y, rates) for y in c.T], axis=1)
    return time, c, flux, diag


def _species(sid, initial, composition):
    return {'id': sid, 'initial_concentration': initial, 'composition': composition}


def _reaction(rid, reactants, products, rate):
    return {'id': rid, 'reactants': reactants, 'products': products, 'rate_constant': rate}


def simulate_reversible_chain(data):
    import numpy as np
    operator = 'simulate_reversible_chain'
    params = _parameters(data, operator)
    network = {'label': 'A ⇌ B ⇌ C', 'provenance': 'Abstract equal-moiety first-order cascade; supplied kinetic constants.',
               'species': [_species(sid, params[f'initial_{sid.lower()}_mol_l'], {'M': 1}) for sid in ['A', 'B', 'C']],
               'reactions': [_reaction(step.upper(), {step[0].upper(): 1}, {step[1].upper(): 1}, params[f'k_{step}_s']) for step in ['ab', 'ba', 'bc', 'cb']]}
    p = PREPARE({'network': network, **{k: params[k] for k in COMMON}}, geometry=False)
    time, c, flux, diag = _batch(p)
    ratio1, ratio2 = p['k'][0]/p['k'][1], p['k'][2]/p['k'][3]
    equilibrium = np.array([1, ratio1, ratio1*ratio2]); equilibrium *= sum(p['initial'])/sum(equilibrium)
    ab, ba, bc, cb = p['k']
    total, pairs = ab+ba+bc+cb, ab*bc+ab*cb+ba*cb
    fast = (total + math.sqrt(max(0, total*total-4*pairs)))/2
    decay = [pairs/fast, fast]
    diag.update(kinetic_equilibrium_mol_l=dict(zip(p['ids'], equilibrium.tolist())),
                final_equilibrium_distance_mol_l=float(max(abs(c[:, -1]-equilibrium))), relaxation_times_s=[1/v for v in decay])
    result = _result(operator, params, p, time, c, flux, diag,
        [_chart('net', 'Net reversible flux', 'mol L⁻¹ s⁻¹', {'A → B net': flux[0]-flux[1], 'B → C net': flux[2]-flux[3]})],
        equations=['dc/dt = S r', 'At kinetic equilibrium: B/A=k_ab/k_ba; C/B=k_bc/k_cb'])
    result['warnings'].append('Kinetic equilibrium follows supplied forward/reverse ratios; no thermochemical equilibrium database is used.')
    return result


def simulate_catalytic_cycle(data):
    operator = 'simulate_catalytic_cycle'
    params = _parameters(data, operator)
    network = {'label': 'Catalytic cycle with competitive inhibition',
        'species': [_species('E', params['catalyst_mol_l'], {'E': 1}), _species('S', params['substrate_mol_l'], {'M': 1}),
                    _species('ES', 0, {'E': 1, 'M': 1}), _species('P', params['product_mol_l'], {'M': 1}),
                    _species('I', params['inhibitor_mol_l'], {'I': 1}), _species('EI', 0, {'E': 1, 'I': 1})],
        'reactions': [_reaction('binding', {'E': 1, 'S': 1}, {'ES': 1}, params['binding_l_mol_s']),
                      _reaction('dissociation', {'ES': 1}, {'E': 1, 'S': 1}, params['dissociation_s']),
                      _reaction('turnover', {'ES': 1}, {'E': 1, 'P': 1}, params['turnover_s']),
                      _reaction('product_binding', {'E': 1, 'P': 1}, {'ES': 1}, params['product_binding_l_mol_s']),
                      _reaction('inhibitor_binding', {'E': 1, 'I': 1}, {'EI': 1}, params['inhibitor_binding_l_mol_s']),
                      _reaction('inhibitor_release', {'EI': 1}, {'E': 1, 'I': 1}, params['inhibitor_dissociation_s'])]}
    p = PREPARE({'network': network, **{k: params[k] for k in COMMON}}, geometry=False)
    time, c, flux, diag = _batch(p)
    fractions = {'Free catalyst': c[0]/params['catalyst_mol_l'], 'Substrate-bound': c[2]/params['catalyst_mol_l'],
                 'Inhibited': c[5]/params['catalyst_mol_l']}
    return _result(operator, params, p, time, c, flux, diag,
        [_chart('occupancy', 'Catalyst fractions', 'fraction', fractions),
         _chart('product', 'Net product formation', 'mol L⁻¹ s⁻¹', {'Product': flux[2]-flux[3]})],
        equations=['E + S ⇌ ES ⇌ E + P; E + I ⇌ EI', 'E + ES + EI = E_total; S + ES + P = substrate_total; I + EI = inhibitor_total'])


def _feed(params, p):
    import numpy as np
    data = obj(params['feed_mol_l'], 'feed_mol_l', set(p['ids']))
    if not data:
        fail('Provide at least one feed concentration; omitted known species have zero feed.')
    return np.array([number(data.get(sid, 0), 'feed.' + sid, 0, 1e6) for sid in p['ids']])


def _reactor(data, operator):
    import numpy as np
    params = _parameters(data, operator)
    p = _prepared(params, operator)
    size = len(p['ids'])
    if operator == 'simulate_pfr':
        time, c, flux, diag = _batch(p)
        conversion = {sid: 1-c[j]/p['initial'][j] for j, sid in enumerate(p['ids']) if p['initial'][j] > 0}
        result = _result(operator, params, p, time, c, flux, diag,
            [_chart('conversion', 'Conversion from inlet', 'fraction', conversion)],
            equations=['dc/d tau = S r(c); tau is residence time along a steady constant-density plug-flow reactor'])
        result['warnings'].append('Residence time is the axial flow coordinate, not startup time. No axial dispersion, pressure drop, heat release or gas-density change is modeled.')
        return result
    feed = _feed(params, p)
    if operator == 'simulate_cstr':
        tau = params['residence_time_s']
        def rhs(t, y):
            flow = (feed-y[:size])/tau
            return np.r_[p['stoich'] @ _rates(p, y[:size]) + flow, flow]
        time, y, diag = _integrate(rhs, np.r_[p['initial'], np.zeros(size)], p)
        c = y[:size]
        corrected = c-p['initial'][:, None]-y[size:]
        scale = max(float(feed.max()), float(p['initial'].max()), float(np.abs(y[size:]).max()))
        diag.update(_balance(p, corrected, scale))
        diag['final_derivative_max_mol_l_s'] = float(max(abs(rhs(time[-1], y[:, -1])[:size])))
        diag['residence_times_elapsed'] = p['duration']/tau
        equations = ['dc/dt = S r(c) + (c_feed-c)/tau', 'tau = V/Q; inventory change = reaction + integrated net flow']
        extra = {'net_flow_' + sid + '_mol_l': y[size+j] for j, sid in enumerate(p['ids'])}
        extra_charts = [_chart('flow', 'Cumulative net inlet minus outlet', 'mol L⁻¹', dict(zip(p['ids'], y[size:])))]
    else:
        volume0, q = params['initial_volume_l'], params['feed_l_s']
        if volume0 + q*p['duration'] > 1e7:
            fail('Final model volume exceeds 1e7 L; check input units.')
        def rhs(t, amounts):
            volume = volume0+q*t
            return volume * (p['stoich'] @ _rates(p, amounts/volume)) + q*feed
        time, amounts, diag = _integrate(rhs, volume0*p['initial'], p)
        volumes = volume0+q*time
        c = amounts/volumes
        supplied = q*feed[:, None]*time
        scale = max(float((volume0*p['initial']).max()), float(supplied.max()), 1e-12)
        diag.update(_balance(p, amounts-volume0*p['initial'][:, None]-supplied, scale))
        diag['final_volume_l'] = float(volumes[-1])
        equations = ['V(t)=V0+Qt; dn/dt = V S r(n/V) + Q c_feed; c=n/V', 'No outlet; feed and initial solution volumes are additive']
        extra = {'volume_l': volumes, **{sid+'_amount_mol': amounts[j] for j, sid in enumerate(p['ids'])}}
        extra_charts = [_chart('volume', 'Liquid volume', 'L', {'Volume': volumes}), _chart('amounts', 'Species inventory', 'mol', dict(zip(p['ids'], amounts)))]
    flux = np.stack([_rates(p, row) for row in c.T], axis=1)
    result = _result(operator, params, p, time, c, flux, diag, extra_charts, extra, equations)
    result['warnings'].append('Constant feed and ideal mixing; calculated endpoint is not automatically labeled a steady state.')
    return result


def _selected(params, p):
    ids = [r['id'] for r in p['network']['reactions']]
    selected = params['reaction_ids']
    if not isinstance(selected, list) or not 1 <= len(selected) <= 8 or any(not isinstance(v, str) or v not in ids for v in selected) or len(set(selected)) != len(selected):
        fail('Choose 1–8 unique existing reaction_ids.')
    indexes = [ids.index(rid) for rid in selected]
    if any(p['k'][i] <= 0 for i in indexes):
        fail('Log-rate analysis requires positive selected rate constants.')
    return indexes


def _target(params, p):
    target = params['target_species']
    if not isinstance(target, str) or target not in p['ids']:
        fail('target_species must identify an existing species.')
    return p['ids'].index(target)


def analyze_reaction_sensitivity(data):
    import numpy as np
    operator = 'analyze_reaction_sensitivity'
    params = _parameters(data, operator); p = _prepared(params, operator)
    indexes, target = _selected(params, p), _target(params, p)
    size, count = len(p['ids']), len(indexes)
    def rhs(t, y):
        c = np.maximum(y[:size], 0)
        rates = _rates(p, c)
        # Differentiate polynomial mass action without dividing by zero concentrations.
        dr = np.zeros((len(p['k']), size))
        for i in range(size):
            powers = p['orders'].copy(); powers[i] = np.maximum(powers[i]-1, 0)
            dr[:, i] = p['k'] * p['orders'][i] * np.prod(c[:, None]**powers, axis=0)
        jacobian = p['stoich'] @ dr
        response = y[size:].reshape(size, count)
        forcing = p['stoich'][:, indexes] * rates[indexes]
        return np.r_[p['stoich'] @ rates, (jacobian @ response + forcing).ravel()]
    time, y, diag = _integrate(rhs, np.r_[p['initial'], np.zeros(size*count)], p)
    c, sensitivities = y[:size], y[size:].reshape(size, count, -1)
    flux = np.stack([_rates(p, row) for row in c.T], axis=1)
    diag.update(_balance(p, c-p['initial'][:, None], float(p['initial'].max())))
    selected = params['reaction_ids']; response = sensitivities[target]
    scale = max(float(p['initial'].max()), 1e-12)
    diag.update(sensitivity_definition='d concentration / d ln(k)', normalization_concentration_mol_l=scale)
    result = _result(operator, params, p, time, c, flux, diag,
        [_chart('sensitivity', params['target_species']+' log-rate sensitivity', 'mol L⁻¹', dict(zip(selected, response))),
         _chart('scaled', 'Sensitivity / initial concentration scale', 'dimensionless', dict(zip(selected, response/scale)))],
        {'sensitivity_'+rid+'_mol_l': response[j] for j, rid in enumerate(selected)},
        ['dZ/dt = J(c) Z + S_selected diag(r_selected); Z(0)=0', 'Z_ij = d c_i / d ln(k_j); normalized Z uses max initial concentration, not instantaneous c_i'])
    result['ranking'] = sorted([{'reaction': rid, 'final_signed_sensitivity_mol_l': float(response[j, -1]),
                                'maximum_absolute_sensitivity_mol_l': float(max(abs(response[j])))} for j, rid in enumerate(selected)],
                               key=lambda item: item['maximum_absolute_sensitivity_mol_l'], reverse=True)
    result['sensitivities'] = {sid: {rid: sensitivities[i, j].tolist() for j, rid in enumerate(selected)} for i, sid in enumerate(p['ids'])}
    result['warnings'].append('Local derivatives around supplied constants; ranking is not causal evidence or global identifiability.')
    return result


def analyze_reaction_flux(data):
    import numpy as np
    operator = 'analyze_reaction_flux'
    params = _parameters(data, operator); p = _prepared(params, operator); target = _target(params, p)
    size = len(p['ids'])
    def rhs(t, y):
        r = _rates(p, y[:size]); return np.r_[p['stoich'] @ r, r]
    time, y, diag = _integrate(rhs, np.r_[p['initial'], np.zeros(len(p['k']))], p)
    c, extents = y[:size], y[size:]
    flux = np.stack([_rates(p, row) for row in c.T], axis=1)
    reconstruction = c-p['initial'][:, None]-p['stoich'] @ extents
    residual = float(abs(reconstruction).max())
    if residual > max(1e-8, float(c.max())*1e-6):
        fail('Integrated extent reconstruction failed.', 'MASS_BALANCE_FAILED')
    diag.update(_balance(p, c-p['initial'][:, None], float(p['initial'].max())), max_extent_reconstruction_error_mol_l=residual)
    ids = [r['id'] for r in p['network']['reactions']]
    contributions = p['stoich'][target, :, None]*flux
    result = _result(operator, params, p, time, c, flux, diag,
        [_chart('extents', 'Integrated reaction extents', 'mol L⁻¹', dict(zip(ids, extents))),
         _chart('contributions', params['target_species']+' formation / consumption', 'mol L⁻¹ s⁻¹', dict(zip(ids, contributions)))],
        {'extent_'+rid+'_mol_l': extents[j] for j, rid in enumerate(ids)}, ['d xi_j/dt = r_j; c-c0 = S xi', 'Species contribution of step j = S_ij r_j'])
    result['pathways'] = [{'reaction': rid, 'extent_mol_l': float(extents[j, -1]),
                           'target_net_change_mol_l': float(p['stoich'][target, j]*extents[j, -1])} for j, rid in enumerate(ids)]
    result['warnings'].append('Forward/reverse cycling can make cumulative extents larger than net conversion; flux is a model quantity, not an experimentally traced pathway.')
    return result


def propagate_reaction_uncertainty(data):
    import numpy as np
    operator = 'propagate_reaction_uncertainty'
    params = _parameters(data, operator); p = _prepared(params, operator)
    indexes, target = _selected(params, p), _target(params, p)
    if params['samples']*p['points']*len(p['ids']) > 300000:
        fail('Uncertainty study exceeds 300000 sample/species/time values; reduce samples or points.')
    time, c, flux, diag = _batch(p)
    rng = np.random.default_rng(params['seed'])
    draws = p['k'][indexes] * np.exp(rng.normal(0, params['log_rate_sd'], (params['samples'], len(indexes))))
    if draws.max() > 1e15:
        fail('Sampled rate exceeds numerical bounds; reduce log-rate spread.')
    curves, evaluations, max_balance = [], 0, 0.0
    for draw in draws:
        constants = p['k'].copy(); constants[indexes] = draw
        _, values, _, checks = _batch(p, constants)
        curves.append(values); evaluations += checks['nfev']
        max_balance = max(max_balance, checks['max_inventory_balance_error'])
    quantiles = np.quantile(np.asarray(curves), [.05, .5, .95], axis=0)
    target_quantiles = {'5th percentile': quantiles[0, target], 'Median': quantiles[1, target], '95th percentile': quantiles[2, target]}
    diag.update(samples_completed=params['samples'], sample_solver_evaluations=evaluations, seed=params['seed'],
                max_sample_inventory_balance_error=max_balance, sampling='Independent lognormal rates; declared constants are medians')
    result = _result(operator, params, p, time, c, flux, diag,
        [_chart('uncertainty', params['target_species']+' empirical uncertainty', 'mol L⁻¹', target_quantiles)],
        {'target_'+name: values for name, values in zip(['q05', 'q50', 'q95'], quantiles[:, target])},
        ['ln(k_sample) = ln(k_declared) + Normal(0, log_rate_sd)', 'Empirical 5th/50th/95th concentration quantiles from all successful draws'])
    result['rate_samples'] = [{'sample': i, **dict(zip(params['reaction_ids'], draw.tolist()))} for i, draw in enumerate(draws)]
    result['quantiles'] = {sid: {'q05': quantiles[0, i].tolist(), 'q50': quantiles[1, i].tolist(), 'q95': quantiles[2, i].tolist()} for i, sid in enumerate(p['ids'])}
    result['warnings'].append('Empirical parameter-propagation quantiles are not confidence intervals, observation-noise predictions or mechanism uncertainty. Rates are independent; no failed draws are discarded.')
    return result


def simulate_cstr(data):
    return _reactor(data, 'simulate_cstr')


def simulate_pfr(data):
    return _reactor(data, 'simulate_pfr')


def simulate_semibatch(data):
    return _reactor(data, 'simulate_semibatch')


def operator_specs(sim_properties):
    specs = []
    for key, (title, family, description, fields, example) in MODELS.items():
        network_model = family != 'mechanisms'
        properties = {**({name: sim_properties[name] for name in ['network', 'example']} if network_model else {}), **COMMON, **fields}
        if key == 'simulate_pfr':
            properties.pop('duration_s')
        schema = {'type': 'object', 'properties': properties,
                  'required': [name for name, rule in fields.items() if 'default' not in rule], 'additionalProperties': False}
        if network_model:
            schema['oneOf'] = [{'required': ['network'], 'not': {'required': ['example']}}, {'required': ['example'], 'not': {'required': ['network']}}]
        specs.append((key, title, 'kinetics', description, schema,
                      {**{name: rule['default'] for name, rule in properties.items() if 'default' in rule}, **example},
                      'Independent reaction equations / shared network validation / SciPy', ['numpy', 'scipy', *(['rdkit'] if network_model else [])]))
    return specs


OPERATORS = {name: finite_result(globals()[name]) for name in MODELS}
