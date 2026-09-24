"""Mesoscopic networks, nonideal reactors and structural analysis.

Independent implementations of published equations; see docs/chem-network-reactors.md.
Shares the validated network and bounded solver with chem_reactions.
"""
from __future__ import annotations

import copy
import math
import chem_reactions as r
from chem_analysis import obj, number, integer, array, finite_result, fail, visual, series

NA = 6.02214076e23
n = r.n


def vector_rule(low, high, description, minimum=3, maximum=501):
    return {'type': 'array', 'items': n(low, high, description), 'minItems': minimum,
            'maxItems': maximum, 'description': description}


RTD_FIELDS = {
    'time_s': vector_rule(0, 1e5, 'Pulse-tracer times / s; strictly increasing, starting at zero'),
    'tracer_signal': vector_rule(0, 1e9, 'Linear tracer signal in a consistent arbitrary unit'),
    'baseline': n(0, 1e9, 'Known constant signal baseline; no automatic clipping', 0),
}
RTD_EXAMPLE = {'time_s': [0, 2, 4, 6, 8, 12, 16, 24, 32, 40],
               'tracer_signal': [0, .2, .7, 1, .9, .5, .25, .06, .01, 0]}
MODELS = {
    'simulate_stochastic_network': ('Stochastic reaction ensemble', 'mechanisms', True,
        'Run seeded Gillespie trajectories with integer molecular inventories, elementary propensities and complete sampled ensembles.',
        {**r.COMMON, 'volume_l': n(1e-24, 1e-6, 'Fixed well-mixed volume / L; initial concentration × NA × volume must give integer molecule counts'),
         'replicates': {'type': 'integer', 'minimum': 1, 'maximum': 128, 'default': 32},
         'seed': {'type': 'integer', 'minimum': 0, 'maximum': 2147483647, 'default': 20260919},
         'max_events': {'type': 'integer', 'minimum': 1, 'maximum': 500000, 'default': 100000},
         'target_species': {'type': 'string', 'description': 'Existing species ID for empirical count quantiles'}},
        {'example': 'reversible', 'volume_l': 100/NA, 'target_species': 'A', 'duration_s': 30}),
    'simulate_axial_dispersion': ('Axial dispersion reactor', 'reactors', True,
        'Resolve transient advection, axial mixing and arbitrary network kinetics with inlet-flux and outlet-gradient boundaries.',
        {**r.COMMON, 'residence_time_s': n(.001, 1e5, 'Length / mean flow velocity / s'),
         'peclet_number': n(.01, 1e4, 'u L / axial dispersion coefficient'),
         'cells': {'type': 'integer', 'minimum': 8, 'maximum': 80, 'default': 32},
         'feed_mol_l': r.FEED, 'target_species': {'type': 'string', 'description': 'Existing species ID for the axial profile'}},
        {'example': 'consecutive', 'residence_time_s': 20, 'peclet_number': 10,
         'feed_mol_l': {'A': 1}, 'target_species': 'B', 'duration_s': 100}),
    'analyze_tracer_rtd': ('Pulse-tracer residence time', 'reaction-analysis', False,
        'Normalize a baseline-corrected pulse trace; calculate E(t), F(t), exact piecewise-linear moments and arrival quantiles.',
        RTD_FIELDS, RTD_EXAMPLE),
    'simulate_rtd_segregation': ('RTD segregation reactor', 'reactors', True,
        'Predict mixed outlet composition by weighting independent batch parcels with a measured pulse-tracer residence-time distribution.',
        {**RTD_FIELDS, 'temperature_k': r.COMMON['temperature_k'], 'points': r.COMMON['points']},
        {'example': 'consecutive', **RTD_EXAMPLE}),
    'analyze_network_structure': ('Network conservation & cycles', 'reaction-analysis', True,
        'Inspect stoichiometric rank, conserved linear pools, algebraic cycles and disabled steps without integrating a trajectory.',
        {}, {'example': 'catalytic'}),
    'scan_cstr_steady_states': ('CSTR steady states & stability', 'reactors', True,
        'Follow a local nonnegative steady-state branch across residence times; retain balance residuals and all Jacobian eigenvalues.',
        {'temperature_k': r.COMMON['temperature_k'], 'feed_mol_l': r.FEED,
         'residence_times_s': vector_rule(.001, 1e5, 'Monotone residence-time sweep / s; supplied order controls continuation', 2, 41),
         'max_evaluations': {'type': 'integer', 'minimum': 1, 'maximum': 500, 'default': 200}},
        {'example': 'consecutive', 'feed_mol_l': {'A': 1}, 'residence_times_s': [1, 2, 5, 10, 20, 40]}),
}


def _params(data, key):
    fields = MODELS[key][4]
    obj(data, 'input', set(fields) | ({'network', 'example'} if MODELS[key][2] else set()))
    result = copy.deepcopy(data)
    for name, rule in fields.items():
        value = result.get(name, rule.get('default'))
        if rule['type'] == 'number':
            value = number(value, name, rule['minimum'], rule['maximum'])
        elif rule['type'] == 'integer':
            value = integer(value, name, rule['minimum'], rule['maximum'])
        elif rule['type'] == 'array':
            value = [number(v, name, rule['items']['minimum'], rule['items']['maximum'])
                     for v in array(value, name, rule['minItems'], rule['maxItems'])]
        elif value is None:
            fail(f'{name} is required.')
        result[name] = value
    if MODELS[key][2] and ('network' in data) == ('example' in data):
        fail('Supply exactly one of network or example.')
    return result


def _prepare(params, **overrides):
    return r.PREPARE({**{k: v for k, v in params.items() if k in r.BASE}, **overrides}, geometry=False, allow_empty=True)


def _warnings(p):
    warnings = ['Supplied mass-action coefficients and mechanisms are assumptions, not inferred chemistry. Examples are illustrative.']
    if p['balanced'] is None:
        warnings.append('Incomplete species compositions: algebraic balances do not certify elemental or charge balance.')
    return warnings


def _study(key, params, p, time, charts, rows, diagnostics, equations):
    return {'kind': 'reaction-study', 'model': key, 'title': MODELS[key][0], 'axis_label': 'Time',
            'time_s': time.tolist(), 'network': p['network'], 'charts': charts, 'rows': rows,
            'diagnostics': diagnostics, 'method': {'parameters': params, 'equations': equations,
                'effective_rate_constants': dict(zip([step['id'] for step in p['network']['reactions']], p['k'].tolist()))},
            'warnings': _warnings(p)}


def _propensities(p, counts, omega):
    import numpy as np
    values = p['k'] * omega ** (1-p['orders'].sum(axis=0))
    for i in range(len(p['ids'])):
        for j in range(len(values)):
            for offset in range(int(p['orders'][i, j])):
                values[j] *= max(int(counts[i])-offset, 0)
    if not np.isfinite(values).all() or values.max() > 1e15:
        fail('Stochastic propensity exceeds numerical bounds.', 'PROPENSITY_RANGE')
    return values


def simulate_stochastic_network(data):
    import numpy as np
    key = 'simulate_stochastic_network'; params = _params(data, key); p = _prepare(params)
    target = r._target(params, p); omega = NA*params['volume_l']; count_float = p['initial']*omega
    if np.any(abs(count_float-np.rint(count_float)) > 1e-7) or count_float.sum() > 1e6:
        fail('Initial concentration × NA × volume must give integer molecule counts (total ≤ 1000000); populations are not silently rounded.')
    if p['orders'].sum(axis=0).max() > 3:
        fail('The stochastic model supports elementary molecularity up to three only.')
    size, samples = len(p['ids']), params['replicates']
    if size*p['points']*samples > 300000:
        fail('Stochastic ensemble exceeds 300000 species/sample/time values.')
    initial = np.rint(count_float).astype(np.int64); stoich = p['stoich'].astype(np.int64)
    time = np.linspace(0, p['duration'], p['points'])
    paths = np.zeros((samples, size, len(time)), dtype=np.int64)
    streams = np.random.SeedSequence(params['seed']).spawn(samples); receipts = []; total_events = 0
    for run, stream in enumerate(streams):
        rng = np.random.Generator(np.random.PCG64(stream)); counts = initial.copy(); current = 0.; sample = 0
        events = np.zeros(len(p['k']), dtype=np.int64)
        while sample < len(time):
            prop = _propensities(p, counts, omega); total = float(prop.sum())
            next_time = current+rng.exponential(1/total) if total > 0 else float('inf')
            if next_time <= current:
                fail('Event waiting time fell below floating-point time resolution.', 'STOCHASTIC_TIME_RANGE')
            while sample < len(time) and time[sample] < next_time:
                paths[run, :, sample] = counts; sample += 1
            if sample == len(time):
                break
            if total_events >= params['max_events']:
                fail('Stochastic event budget exhausted; the ensemble is incomplete and no successful subset is reported.', 'STOCHASTIC_BUDGET')
            reaction = min(int(np.searchsorted(np.cumsum(prop), rng.random()*total, side='right')), len(prop)-1)
            counts = counts+stoich[:, reaction]; events[reaction] += 1; total_events += 1; current = next_time
            if counts.min() < 0 or counts.sum() > 1e6:
                fail('Stochastic population left the nonnegative bounded domain.', 'STOCHASTIC_POPULATION')
        if not np.array_equal(counts-initial, stoich @ events):
            fail('Integer event balance failed.', 'MASS_BALANCE_FAILED')
        receipts.append({'replicate': run, 'spawn_key': list(stream.spawn_key), 'events': int(events.sum()),
                         'reaction_event_counts': dict(zip([step['id'] for step in p['network']['reactions']], events.tolist()))})
    mean = paths.mean(axis=0); sd = paths.std(axis=0, ddof=0)
    quantiles = np.quantile(paths[:, target], [.05, .5, .95], axis=0)
    result = _study(key, params, p, time,
        [r._chart('mean_counts', 'Ensemble mean molecular counts', 'molecules', dict(zip(p['ids'], mean))),
         r._chart('count_spread', params['target_species']+' empirical count spread', 'molecules',
                  {'5th percentile': quantiles[0], 'Median': quantiles[1], '95th percentile': quantiles[2]}),
         r._chart('count_sd', 'Ensemble population standard deviation', 'molecules', dict(zip(p['ids'], sd)))],
        [{'time_s': float(t), **{sid+'_mean_count': float(mean[i, j]) for i, sid in enumerate(p['ids'])},
          'target_q05_count': float(quantiles[0, j]), 'target_q50_count': float(quantiles[1, j]), 'target_q95_count': float(quantiles[2, j])} for j, t in enumerate(time)],
        {'replicates_completed': samples, 'total_events': total_events, 'seed': params['seed'], 'volume_l': params['volume_l'],
         'molecules_per_mol_l': omega, 'integer_event_balance_verified': True, 'composition_balance_verified': p['balanced']},
        ['Omega = NA V_L; a_j = k_j Omega^(1-m_j) product_i (N_i)_(nu_ij)',
         'Waiting time ~ Exponential(sum(a)); reaction probabilities = a_j/sum(a); N <- N + S_j'])
    result['sampled_trajectories'] = [{'replicate': i, 'counts': dict(zip(p['ids'], path.tolist()))} for i, path in enumerate(paths)]
    result['replicate_receipts'] = receipts
    result['warnings'] += ['Well-mixed fixed-volume elementary reactions only. Rate constants follow the shared event-rate convention r=k product(c^nu); falling factorials are not divided by factorials.',
        'Quantiles describe stochastic molecular fluctuations, not parameter confidence. All sampled trajectories and stream keys are retained; individual event times are not stored. No spatial or atomic motion is modeled.']
    return result


def simulate_axial_dispersion(data):
    import numpy as np
    from scipy.sparse import lil_matrix
    key = 'simulate_axial_dispersion'; params = _params(data, key); p = _prepare(params)
    feed = r._feed(params, p); target = r._target(params, p); cells = params['cells']; size = len(p['ids'])
    if cells*size > 640:
        fail('Axial reactor exceeds 640 cell/species states; reduce the grid or species count.')
    tau, pe = params['residence_time_s'], params['peclet_number']; dz = 1/cells
    scale = max(float(feed.max()), float(p['initial'].max()), 1e-12); normalized_feed = feed/scale
    def rhs(t, y):
        c = y[:cells*size].reshape(cells, size)
        flux = np.zeros((cells+1, size)); flux[0] = normalized_feed/tau; flux[-1] = c[-1]/tau
        flux[1:-1] = c[:-1]/tau-(c[1:]-c[:-1])/(tau*pe*dz)
        rates = p['k']*np.prod(np.maximum(c*scale, 0)[:, :, None]**p['orders'][None, :, :], axis=1)
        reaction = (rates @ p['stoich'].T)/scale
        return np.r_[((flux[:-1]-flux[1:])/dz+reaction).ravel(), flux[0]-flux[-1], reaction.mean(axis=0)]
    count = cells*size+2*size; pattern = lil_matrix((count, count), dtype=int)
    for cell in range(cells):
        pattern[cell*size:(cell+1)*size, max(0, cell-1)*size:min(cells, cell+2)*size] = 1
    pattern[cells*size:cells*size+size, (cells-1)*size:cells*size] = 1
    pattern[cells*size+size:, :cells*size] = 1
    time, y, diag = r._integrate(rhs, np.r_[np.tile(p['initial']/scale, cells), np.zeros(2*size)], p, jac_sparsity=pattern.tocsr())
    profiles = y[:cells*size].reshape(cells, size, -1)*scale; outlet = profiles[-1]; average = profiles.mean(axis=0)
    flow, reaction = y[cells*size:cells*size+size]*scale, y[cells*size+size:]*scale
    r._check_concentrations(profiles, scale)
    error = float(abs(average-p['initial'][:, None]-flow-reaction).max())
    if error > scale*1e-6:
        fail('Axial reactor integrated species balance failed.', 'MASS_BALANCE_FAILED')
    diag.update(max_species_balance_error_mol_l=error, normalized_balance_error=error/scale,
        cells=cells, cell_peclet_number=pe/cells, numerical_dispersion_to_physical_ratio=pe/(2*cells),
        final_derivative_max_mol_l_s=float(abs(rhs(time[-1], y[:, -1])[:cells*size]).max()*scale),
        composition_balance_verified=p['balanced'])
    result = _study(key, params, p, time,
        [r._chart('outlet', 'Outlet concentrations', 'mol L⁻¹', dict(zip(p['ids'], outlet))),
         r._chart('average', 'Reactor mean concentrations', 'mol L⁻¹', dict(zip(p['ids'], average))),
         r._chart('net_flow', 'Integrated net inlet minus outlet', 'mol L⁻¹', dict(zip(p['ids'], flow)))],
        [{'time_s': float(t), **{sid+'_outlet_mol_l': float(outlet[i, j]) for i, sid in enumerate(p['ids'])},
          **{sid+'_mean_mol_l': float(average[i, j]) for i, sid in enumerate(p['ids'])}} for j, t in enumerate(time)], diag,
        ['dC/dt = -(1/tau)dC/dz + (1/(tau Pe))d²C/dz² + S r; z=x/L',
         'Inlet total flux = C_feed/tau; outlet diffusive flux = 0', 'mean(C)-C0 = integrated net flow + integrated reaction'])
    result['spatial_profile'] = {'title': params['target_species']+' axial concentration', 'x_label': 'Axial position', 'x_unit': 'x/L',
        'y_label': 'Concentration', 'y_unit': 'mol L⁻¹', 'x': ((np.arange(cells)+.5)/cells).tolist(), 'values': profiles[:, target].T.tolist()}
    result['profiles'] = {sid: profiles[:, i].T.tolist() for i, sid in enumerate(p['ids'])}
    result['warnings'] += ['Isothermal constant-density 1D flow with uniform initial concentration. Time is startup time, not residence position; no pressure drop, radial gradients or molecular trajectories.',
        'First-order upwind transport adds numerical dispersion; the reported ratio Pe/(2*cells) diagnoses resolution. Refine the grid before interpreting sharp fronts. An endpoint is not automatically a steady state.']
    return result


def _rtd(params):
    import numpy as np
    time, raw = np.array(params['time_s']), np.array(params['tracer_signal'])
    if len(time) != len(raw) or time[0] != 0 or np.any(np.diff(time) <= 0):
        fail('Tracer arrays must match and times must increase strictly from zero.')
    corrected = raw-params['baseline']
    if corrected.min() < 0:
        fail('Tracer signal is below the supplied baseline; negative observations are not clipped.')
    dt = np.diff(time); areas = dt*(corrected[:-1]+corrected[1:])/2; area = float(areas.sum())
    if area <= 0:
        fail('The baseline-corrected pulse must have positive area.')
    density = corrected/area; cdf = np.r_[0, np.cumsum(areas)/area]
    # Two-point Gauss integration is exact for t^2 times each linear segment.
    midpoint = (time[:-1]+time[1:])/2; offset = dt/(2*math.sqrt(3))
    moment = []
    for power in (1, 2):
        value = 0.
        for sign in (-1, 1):
            q = midpoint+sign*offset
            e = density[:-1]+(density[1:]-density[:-1])*(q-time[:-1])/dt
            value += float(np.sum(dt/2*q**power*e))
        moment.append(value)
    mean = moment[0]; variance = 0.; quantiles = {}
    # Center before squaring to retain narrow late-time pulse variance.
    for sign in (-1, 1):
        q = midpoint+sign*offset
        e = density[:-1]+(density[1:]-density[:-1])*(q-time[:-1])/dt
        variance += float(np.sum(dt/2*(q-mean)**2*e))
    for q in (.1, .5, .9):
        i = min(int(np.searchsorted(cdf, q, side='right'))-1, len(dt)-1)
        left, right = 0., dt[i]
        for _ in range(55):
            x = (left+right)/2
            cumulative = cdf[i]+density[i]*x+(density[i+1]-density[i])*x*x/(2*dt[i])
            if cumulative < q:
                left = x
            else:
                right = x
        quantiles['t'+str(int(q*100))+'_s'] = float(time[i]+(left+right)/2)
    return time, raw, corrected, density, cdf, {'observed_pulse_area_signal_s': area, 'mean_residence_time_s': mean,
        'variance_s2': variance, 'coefficient_of_variation': math.sqrt(variance)/mean,
        'moment_matched_tank_count': mean*mean/variance if variance > 0 else None,
        **quantiles, 'final_signal_fraction_of_peak': float(corrected[-1]/max(corrected)),
        'start_signal_fraction_of_peak': float(corrected[0]/max(corrected)), 'window_end_s': float(time[-1])}


RTD_WARNINGS = ['Pulse injection, passive linear tracer and constant flow are assumed. Finite injection duration and detector dynamics are not deconvolved.',
    'Only the observed window is normalized. Unmeasured tails are not recovered; ending at zero does not establish complete tracer recovery. No injected mass or absolute recovery is inferred.',
    'Moment-matched tank count is a descriptive moment ratio, not a fitted physical reactor count.']


def analyze_tracer_rtd(data):
    key = 'analyze_tracer_rtd'; params = _params(data, key)
    time, raw, corrected, density, cdf, diagnostics = _rtd(params)
    return {'kind': 'tracer-rtd', 'title': MODELS[key][0], 'diagnostics': diagnostics,
        'visualization': visual('Time', 's', 'Residence-time density', 's⁻¹', [series('density', 'E(t)', time.tolist(), density.tolist())]),
        'supplementary_visualizations': [{'title': 'Cumulative exit fraction', **visual('Time', 's', 'F(t)', 'fraction', [series('cdf', 'F(t)', time.tolist(), cdf.tolist())])}],
        'rows': [{'time_s': float(t), 'raw_signal': float(raw[i]), 'corrected_signal': float(corrected[i]),
                  'density_per_s': float(density[i]), 'cumulative_fraction': float(cdf[i])} for i, t in enumerate(time)],
        'method': {'parameters': params, 'equations': ['E=C_corrected / integral(C_corrected dt)', 'F=integral(E dt)',
                   'mean=integral(t E dt); variance=integral(t² E dt)-mean²'], 'interpolation': 'Piecewise linear signal; analytic segment area and moments'},
        'warnings': RTD_WARNINGS.copy()}


def simulate_rtd_segregation(data):
    import numpy as np
    key = 'simulate_rtd_segregation'; params = _params(data, key)
    observed_time, _, _, density, _, rtd_diagnostics = _rtd(params)
    p = _prepare(params, duration_s=float(observed_time[-1])); size = len(p['ids']); scale = max(float(p['initial'].max()), 1e-12)
    smallest_interval = float(np.diff(observed_time).min())
    if p['duration']/smallest_interval > 5000:
        fail('Tracer spacing exceeds the bounded integration resolution; resample explicitly before this study.')
    def rhs(t, y):
        e = float(np.interp(t, observed_time, density))
        return np.r_[p['stoich'] @ r._rates(p, y[:size]*scale)/scale, e*y[:size], e]
    time, y, diag = r._integrate(rhs, np.r_[p['initial']/scale, np.zeros(size+1)], p, max_step=smallest_interval/2)
    c, weighted, cdf = y[:size]*scale, y[size:2*size]*scale, y[-1]
    r._check_concentrations(c, scale)
    diag.update(r._balance(p, c-p['initial'][:, None], scale), **rtd_diagnostics, integrated_density=float(cdf[-1]))
    if abs(cdf[-1]-1) > 2e-6:
        fail('Residence-time density quadrature did not meet normalization tolerance.', 'RTD_QUADRATURE_FAILED')
    result = _study(key, params, p, time,
        [r._chart('parcel', 'Batch parcel concentrations', 'mol L⁻¹', dict(zip(p['ids'], c))),
         r._chart('weighted', 'Cumulative outlet contributions', 'mol L⁻¹', dict(zip(p['ids'], weighted))),
         r._chart('fraction', 'Integrated observed residence distribution', 'fraction', {'Cumulative fraction': cdf})],
        [{'time_s': float(t), **{sid+'_parcel_mol_l': float(c[i, j]) for i, sid in enumerate(p['ids'])},
          **{sid+'_outlet_contribution_mol_l': float(weighted[i, j]) for i, sid in enumerate(p['ids'])}, 'cumulative_rtd': float(cdf[j])} for j, t in enumerate(time)],
        diag, ['dC_parcel/d age = S r(C_parcel)', 'C_out = integral(E(age) C_parcel(age) d age)'])
    result['axis_label'] = 'Residence time'
    result['outlet_composition'] = [{'species': sid, 'feed_mol_l': float(p['initial'][i]), 'outlet_mol_l': float(weighted[i, -1]),
        'conversion': float(1-weighted[i, -1]/p['initial'][i]) if p['initial'][i] > 0 else None} for i, sid in enumerate(p['ids'])]
    result['warnings'] += RTD_WARNINGS + ['Complete segregation: parcels of different ages do not mix until the outlet. Network initial concentrations are parcel feed concentrations. Age is not reactor startup time; micromixing and maximum mixedness are not modeled.']
    return result


def analyze_network_structure(data):
    import numpy as np
    from scipy.linalg import null_space
    key = 'analyze_network_structure'; params = _params(data, key); p = _prepare(params)
    matrix = p['stoich']; rids = [step['id'] for step in p['network']['reactions']]
    left, right = null_space(matrix.T, rcond=1e-10).T, null_space(matrix, rcond=1e-10).T
    def normalize(vectors):
        for v in vectors:
            v /= max(abs(v)); first = np.flatnonzero(abs(v) > 1e-8)[0]
            if v[first] < 0:
                v *= -1
        return vectors
    left, right = normalize(left), normalize(right)
    error = max(float(abs(left @ matrix).max()) if left.size else 0., float(abs(matrix @ right.T).max()) if right.size else 0.)
    return {'kind': 'network-structure', 'title': MODELS[key][0], 'network': p['network'],
        'diagnostics': {'species': len(p['ids']), 'reaction_steps': len(rids), 'stoichiometric_rank': len(p['ids'])-len(left),
            'conservation_dimension': len(left), 'cycle_dimension': len(right), 'max_nullspace_residual': error,
            'relative_svd_cutoff': 1e-10, 'composition_balance_verified': p['balanced']},
        'tables': [
            {'title': 'Stoichiometric coefficients', 'rows': [{'species': sid, 'reaction': rid, 'coefficient': float(matrix[i, j])} for i, sid in enumerate(p['ids']) for j, rid in enumerate(rids)]},
            {'title': 'Conserved pool basis', 'rows': [{'pool': j+1, 'species': sid, 'weight': float(v[i]), 'initial_pool_mol_l': float(v @ p['initial'])} for j, v in enumerate(left) for i, sid in enumerate(p['ids'])]},
            {'title': 'Algebraic cycle basis', 'rows': [{'cycle': j+1, 'reaction': rid, 'weight': float(v[i])} for j, v in enumerate(right) for i, rid in enumerate(rids)]},
            {'title': 'Declared reaction activity', 'rows': [{'reaction': rid, 'effective_rate_constant': float(p['k'][i]), 'enabled': bool(p['k'][i] > 0)} for i, rid in enumerate(rids)]}],
        'conservation_vectors': left.tolist(), 'cycle_vectors': right.tolist(), 'species_order': p['ids'], 'reaction_order': rids,
        'method': {'parameters': params, 'equations': ['L S=0 implies L c is conserved in a closed network', 'S Z=0 identifies algebraic reaction combinations with zero net change']},
        'warnings': _warnings(p)+['SVD bases are nonunique signed linear combinations, not named chemical moieties or necessarily feasible nonnegative flux cycles.',
            'All declared steps, including zero-rate steps, enter the structural matrix. This is not a thermodynamic consistency, detailed-balance, reachability or kinetic stability certificate.']}


def _jacobian(p, c):
    import numpy as np
    derivative = np.zeros((len(p['k']), len(p['ids'])))
    for i in range(len(c)):
        powers = p['orders'].copy(); powers[i] = np.maximum(powers[i]-1, 0)
        derivative[:, i] = p['k']*p['orders'][i]*np.prod(np.maximum(c, 0)[:, None]**powers, axis=0)
    return p['stoich'] @ derivative


def scan_cstr_steady_states(data):
    import numpy as np
    from scipy.optimize import least_squares
    key = 'scan_cstr_steady_states'; params = _params(data, key); p = _prepare(params); feed = r._feed(params, p)
    times = np.array(params['residence_times_s']); delta = np.diff(times)
    if not (np.all(delta > 0) or np.all(delta < 0)):
        fail('Residence times must be strictly monotone; their supplied order controls continuation.')
    size = len(p['ids']); scale = max(float(feed.max()), float(p['initial'].max()), 1e-12)
    state = np.maximum(p['initial']/scale, 1e-10); results = []; eigenvalues = []; curves = []
    for tau in times:
        def residual(x):
            return tau*(p['stoich'] @ r._rates(p, x*scale))/scale+feed/scale-x
        def jac(x):
            return tau*_jacobian(p, x*scale)-np.eye(size)
        fit = least_squares(residual, state, jac=jac, bounds=(0, 1e6/scale),
                            max_nfev=params['max_evaluations'], ftol=1e-13, xtol=1e-13, gtol=1e-14)
        error = float(abs(residual(fit.x)).max())
        if not fit.success or error > 1e-7:
            fail(f'Steady-state continuation failed at residence time {tau:g} s (scaled residual {error:.3g}); no points are silently discarded.', 'STEADY_STATE_FAILED')
        state = fit.x; concentration = state*scale; stability = _jacobian(p, concentration)-np.eye(size)/tau
        eigen = np.linalg.eigvals(stability); spectral = float(eigen.real.max()); tolerance = max(1e-10, float(np.linalg.norm(stability, 2))*1e-8)
        label = 'stable' if spectral < -tolerance else 'unstable' if spectral > tolerance else 'marginal / unresolved'
        curves.append(concentration)
        results.append({'residence_time_s': float(tau), **{sid+'_mol_l': float(concentration[i]) for i, sid in enumerate(p['ids'])},
            'max_scaled_balance_residual': error, 'spectral_abscissa_per_s': spectral, 'stability_tolerance_per_s': tolerance,
            'local_stability': label, 'solver_evaluations': int(fit.nfev), 'at_solver_bound': bool(np.any(fit.active_mask))})
        eigenvalues.extend([{'residence_time_s': float(tau), 'mode': i+1, 'real_per_s': float(e.real), 'imaginary_per_s': float(e.imag)} for i, e in enumerate(eigen)])
    curves = np.array(curves); order = np.argsort(times)
    return {'kind': 'cstr-steady-branch', 'title': MODELS[key][0], 'network': p['network'], 'rows': results,
        'tables': [{'title': 'Linear stability eigenvalues', 'rows': eigenvalues}],
        'visualization': visual('Residence time', 's', 'Steady concentration', 'mol L⁻¹',
            [series(sid, sid, times[order].tolist(), curves[order, i].tolist()) for i, sid in enumerate(p['ids'])]),
        'supplementary_visualizations': [{'title': 'Local branch stability', **visual('Residence time', 's', 'Largest real eigenvalue', 's⁻¹',
            [series('spectral', 'Spectral abscissa', times[order].tolist(), [results[i]['spectral_abscissa_per_s'] for i in order])])}],
        'diagnostics': {'points_completed': len(times), 'max_scaled_balance_residual': max(row['max_scaled_balance_residual'] for row in results),
            'composition_balance_verified': p['balanced']},
        'method': {'parameters': params, 'equations': ['0=S r(C)+(C_feed-C)/tau', 'J_dynamic=S dr/dC-I/tau; stable iff all real eigenvalues < 0'],
                   'continuation': 'Nonnegative bounded least squares; previous accepted root initializes the next supplied residence time'},
        'warnings': _warnings(p)+['One locally found isothermal branch only. Continuation can switch branches or fail at folds; it neither enumerates all steady states nor proves global stability or bifurcation structure.',
            'Initial network concentrations initialize the first nonlinear solve. Solver convergence and a strict material-balance residual are both required; near-zero eigenvalues are unresolved.']}


def operator_specs(sim_properties):
    specs = []
    for key, (title, family, network, description, fields, example) in MODELS.items():
        props = {**({name: sim_properties[name] for name in ['network', 'example']} if network else {}), **fields}
        schema = {'type': 'object', 'properties': props, 'additionalProperties': False,
                  'required': [name for name, rule in fields.items() if 'default' not in rule]}
        if network:
            schema['oneOf'] = [{'required': ['network'], 'not': {'required': ['example']}}, {'required': ['example'], 'not': {'required': ['network']}}]
        specs.append((key, title, 'kinetics', description, schema,
            {**{name: rule['default'] for name, rule in props.items() if 'default' in rule}, **example},
            'Independent network/transport equations / Gillespie / NumPy / SciPy', ['numpy', 'scipy', *(['rdkit'] if network else [])]))
    return specs


OPERATORS = {name: finite_result(globals()[name]) for name in MODELS}
