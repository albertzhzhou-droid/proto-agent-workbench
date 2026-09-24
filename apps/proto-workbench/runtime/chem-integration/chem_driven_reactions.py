"""Independent driven-reaction and kinetic-inference equations; no device execution.

See docs/chem-driven-reactions.md for units, limitations and public references.
"""
from __future__ import annotations

import copy
import math
import chem_reactions as r
from chem_analysis import obj, number, integer, array, choice, finite_result, fail, visual, series

R, F, KB_OVER_H = 8.31446261815324, 96485.33212, 20836619123.327576
n = r.n
TIME = {key: r.COMMON[key] for key in ['duration_s', 'points']}
ELECTRO = {
    'diffusivity_m2_s': n(1e-13, 1e-7, 'Equal oxidized/reduced diffusion coefficient / m² s^-1'),
    'domain_length_m': n(1e-7, .01, 'Finite diffusion slab thickness; reflecting far wall / m'),
    'total_concentration_mol_m3': n(1e-9, 1e5, 'Initial uniform O + R / mol m^-3'),
    'initial_oxidized_fraction': n(0, 1, 'Initial uniform O / (O+R)', 1),
    'standard_rate_m_s': n(0, .1, 'Heterogeneous electron-transfer coefficient / m s^-1'),
    'alpha': n(.05, .95, 'Cathodic transfer coefficient; anodic coefficient is 1-alpha', .5),
    'electrons': {'type': 'integer', 'minimum': 1, 'maximum': 4, 'default': 1},
    'temperature_k': n(200, 1000, 'Constant temperature / K', 298.15),
    'formal_potential_v': n(-5, 5, 'Formal potential relative to the chosen reference / V', 0),
    'cells': {'type': 'integer', 'minimum': 16, 'maximum': 160, 'default': 80},
}
ELECTRO_EXAMPLE = {'diffusivity_m2_s': 1e-9, 'domain_length_m': .0005,
    'total_concentration_mol_m3': 1, 'standard_rate_m_s': .001}


def vec(low, high, minimum=4):
    return {'type': 'array', 'items': n(low, high, 'Supplied measurement'), 'minItems': minimum, 'maxItems': 201}


MODELS = {
    'simulate_photochemical_isomerization': ('Photochemical isomerization', 'kinetics',
        'Couple A ⇌ B to Beer–Lambert absorption, species-specific quantum yields, modulated illumination and thermal back reaction.',
        {**TIME, 'initial_a_mol_l': n(0, 1, 'Initial A / mol L^-1'), 'initial_b_mol_l': n(0, 1, 'Initial B / mol L^-1', 0),
         'epsilon_a_l_mol_cm': n(0, 1e7, 'A molar absorption coefficient / L mol^-1 cm^-1'),
         'epsilon_b_l_mol_cm': n(0, 1e7, 'B molar absorption coefficient / L mol^-1 cm^-1'),
         'path_length_cm': n(1e-4, 100, 'Optical path and illuminated solution depth / cm'),
         'photon_flux_mol_m2_s': n(0, 1, 'Mean incident monochromatic photon flux / mol photons m^-2 s^-1'),
         'quantum_yield_ab': n(0, 1, 'A → B events per photon absorbed by A'),
         'quantum_yield_ba': n(0, 1, 'B → A events per photon absorbed by B'),
         'dark_back_rate_s': n(0, 1e4, 'Thermal B → A coefficient / s^-1', 0),
         'modulation_depth': n(0, 1, 'Sinusoidal relative modulation depth; zero is constant light', 0),
         'light_period_s': n(1e-5, 1e5, 'Illumination period / s', 10)},
        {'initial_a_mol_l': .0001, 'epsilon_a_l_mol_cm': 12000, 'epsilon_b_l_mol_cm': 4000, 'path_length_cm': 1,
         'photon_flux_mol_m2_s': .0001, 'quantum_yield_ab': .4, 'quantum_yield_ba': .15, 'dark_back_rate_s': .003,
         'modulation_depth': .5, 'light_period_s': 20, 'duration_s': 120}),
    'simulate_excited_state_quenching': ('Excited-state kinetics & quenching', 'kinetics',
        'Resolve ground, singlet, triplet and product populations with excitation, fluorescence, nonradiative relaxation and reservoir quenching.',
        {**TIME, 'total_mol_l': n(1e-12, 1, 'Total chromophore inventory / mol L^-1'),
         'initial_excited_fraction': n(0, 1, 'Initially excited singlet fraction', 0),
         'excitation_s': n(0, 1e9, 'Prescribed pseudo-first-order ground → singlet pump / s^-1'),
         'fluorescence_s': n(0, 1e9, 'Singlet radiative relaxation / s^-1'),
         'nonradiative_s': n(0, 1e9, 'Singlet nonradiative relaxation / s^-1'),
         'intersystem_crossing_s': n(0, 1e9, 'Singlet → triplet coefficient / s^-1'),
         'triplet_decay_s': n(0, 1e9, 'Triplet → ground coefficient / s^-1'),
         'quenching_l_mol_s': n(0, 1e12, 'Collisional singlet quenching / L mol^-1 s^-1'),
         'quencher_mol_l': n(0, 100, 'Maintained quencher concentration / mol L^-1'),
         'product_formation_s': n(0, 1e9, 'Triplet → product pseudo-first-order coefficient / s^-1')},
        {'total_mol_l': .0001, 'excitation_s': .2, 'fluorescence_s': 5, 'nonradiative_s': 2,
         'intersystem_crossing_s': 1, 'triplet_decay_s': .3, 'quenching_l_mol_s': 100, 'quencher_mol_l': .01,
         'product_formation_s': .1, 'duration_s': 40}),
    'simulate_cyclic_voltammetry': ('Diffusion-coupled cyclic voltammetry', 'interfaces',
        'Simulate one triangular potential cycle with Butler–Volmer surface kinetics, finite-slab diffusion, capacitive current and a synchronized voltammogram.',
        {**ELECTRO, 'points': {'type': 'integer', 'minimum': 3, 'maximum': 501, 'default': 301, 'description': 'Odd count, including the exact reversal sample'},
         'start_potential_v': n(-5, 5, 'Start and return potential / V'), 'vertex_potential_v': n(-5, 5, 'Reversal potential / V'),
         'scan_rate_v_s': n(1e-5, 100, 'Absolute potential scan rate / V s^-1'),
         'capacitance_f_m2': n(0, 100, 'Ideal double-layer capacitance / F m^-2', 0)},
        {**ELECTRO_EXAMPLE, 'start_potential_v': .25, 'vertex_potential_v': -.25, 'scan_rate_v_s': .05, 'capacitance_f_m2': .2}),
    'simulate_chronoamperometry': ('Diffusion-coupled potential step', 'interfaces',
        'Resolve faradaic step current, electrode concentrations, diffusion profiles and charge balance in a finite closed slab.',
        {**TIME, **ELECTRO, 'step_potential_v': n(-5, 5, 'Held potential after the ideal step at t=0 / V')},
        {**ELECTRO_EXAMPLE, 'step_potential_v': -.25, 'duration_s': 10}),
    'fit_arrhenius_eyring': ('Arrhenius & Eyring parameter fit', 'kinetics',
        'Fit supplied first-order rate constants across temperature in log space, with explicit log-rate uncertainty, residuals and conditional parameter standard errors.',
        {'temperatures_k': vec(150, 2000, 3), 'rate_constants_s': vec(1e-20, 1e15, 3),
         'model': {'type': 'string', 'enum': ['arrhenius', 'eyring'], 'default': 'arrhenius'},
         'log_rate_sd': n(1e-6, 10, 'Known common standard deviation of ln(k), not a fitted residual spread', .05)},
        {'temperatures_k': [280, 290, 300, 310, 320, 330],
         'rate_constants_s': [1e8*math.exp(-50000/(R*t)) for t in [280, 290, 300, 310, 320, 330]]}),
    'compare_integrated_rate_laws': ('Integrated rate-law comparison', 'kinetics',
        'Fit zero-, first- and second-order depletion laws to the same concentration data; retain all residuals, AICc weights and fit diagnostics.',
        {'time_s': vec(0, 1e5), 'concentrations_mol_l': vec(0, 1e6),
         'initial_concentration_mol_l': n(1e-12, 1e6, 'Independently supplied fixed initial concentration / mol L^-1'),
         'measurement_sd_mol_l': n(1e-12, 1e6, 'Known common Gaussian measurement SD / mol L^-1'),
         'max_evaluations': {'type': 'integer', 'minimum': 10, 'maximum': 500, 'default': 150}},
        {'time_s': [0, 1, 2, 4, 6, 8, 12, 16], 'concentrations_mol_l': [1.003, .816, .673, .446, .304, .2, .093, .039],
         'initial_concentration_mol_l': 1, 'measurement_sd_mol_l': .01}),
}


def _params(data, key):
    props = MODELS[key][3]; obj(data, 'input', set(props)); out = copy.deepcopy(data)
    for name, rule in props.items():
        value = out.get(name, rule.get('default'))
        if rule['type'] == 'number':
            value = number(value, name, rule['minimum'], rule['maximum'])
        elif rule['type'] == 'integer':
            value = integer(value, name, rule['minimum'], rule['maximum'])
        elif rule['type'] == 'array':
            value = [number(v, name, rule['items']['minimum'], rule['items']['maximum'])
                     for v in array(value, name, rule['minItems'], rule['maxItems'])]
        else:
            value = choice(value, name, tuple(rule['enum']))
        out[name] = value
    return out


def _study(key, params, time, charts, rows, diagnostics, equations, warnings, network):
    return {'kind': 'reaction-study', 'model': key, 'title': MODELS[key][0], 'time_s': time.tolist(), 'axis_label': 'Time',
        'charts': charts, 'rows': rows, 'network': network, 'diagnostics': diagnostics,
        'method': {'parameters': params, 'equations': equations, 'implementation': 'Independent driven-reaction equations / shared bounded SciPy BDF'},
        'warnings': warnings}


def _network(ids, reactions):
    return {'label': 'Abstract state scheme; rate laws are defined in method equations',
            'species': [r._species(sid, 0, {'M': 1}) for sid in ids],
            'reactions': [r._reaction(name, {a: 1}, {b: 1}, 0) for name, a, b in reactions]}


def simulate_photochemical_isomerization(data):
    import numpy as np
    key = 'simulate_photochemical_isomerization'; p = _params(data, key)
    initial = np.array([p['initial_a_mol_l'], p['initial_b_mol_l']]); total = sum(initial)
    if total <= 0:
        fail('A positive initial A+B inventory is required.')
    if p['modulation_depth'] and p['duration_s']/p['light_period_s'] > 200:
        fail('Resolve at most 200 illumination periods per run.')
    eps = np.array([p['epsilon_a_l_mol_cm'], p['epsilon_b_l_mol_cm']]); length = p['path_length_cm']
    def rates(t, c):
        absorb = eps*np.maximum(c, 0); strength = sum(absorb)
        incident = p['photon_flux_mol_m2_s']*(1+p['modulation_depth']*math.sin(2*math.pi*t/p['light_period_s']))/(10*length)
        absorbed = incident*(-math.expm1(-math.log(10)*strength*length))
        partial = absorbed*absorb/strength if strength else np.zeros(2)
        return np.array([p['quantum_yield_ab']*partial[0], p['quantum_yield_ba']*partial[1], p['dark_back_rate_s']*c[1]]), incident, absorbed
    def rhs(t, y):
        flux, incident, absorbed = rates(t, y[:2]*total); net = flux[0]-flux[1]-flux[2]
        return np.r_[-net, net, incident, absorbed, flux[0]+flux[1]]/total
    time, y, diag = r._integrate(rhs, np.r_[initial/total, 0, 0, 0], {'duration': p['duration_s'], 'points': p['points']},
        max_step=p['light_period_s']/24 if p['modulation_depth'] else float('inf'))
    y *= total
    r._check_concentrations(y[:2], total)
    drift = float(max(abs(y[0]+y[1]-total)))
    if drift > max(1e-12, total*1e-6) or np.any(y[4]-y[3] > max(1e-12, float(y[3].max())*1e-6)):
        fail('Molecular or absorbed-photon accounting failed.', 'BALANCE_FAILED')
    evaluated = [rates(t, c) for t, c in zip(time, y[:2].T)]
    flux = np.stack([item[0] for item in evaluated], axis=1)
    incident, absorbed = (np.array([item[i] for item in evaluated]) for i in [1, 2])
    absorbance = eps @ y[:2]*length
    diag.update(max_inventory_balance_error_mol_l=drift, photochemical_events_mol_l=float(y[4, -1]),
        absorbed_photons_mol_l=float(y[3, -1]), event_yield_per_absorbed_photon=float(y[4, -1]/y[3, -1]) if y[3, -1] > 0 else None)
    rows = [{'time_s': float(t), 'A_mol_l': float(y[0, i]), 'B_mol_l': float(y[1, i]), 'absorbance': float(absorbance[i]),
        'incident_photons_mol_l_s': float(incident[i]), 'absorbed_photons_mol_l_s': float(absorbed[i]),
        'cumulative_incident_mol_l': float(y[2, i]), 'cumulative_absorbed_mol_l': float(y[3, i]), 'cumulative_photo_events_mol_l': float(y[4, i])} for i, t in enumerate(time)]
    return _study(key, p, time, [r._chart('concentration', 'Isomer populations', 'mol L⁻¹', {'A': y[0], 'B': y[1]}),
        r._chart('rates', 'Forward, reverse and dark rates', 'mol L⁻¹ s⁻¹', dict(zip(['Photo A → B', 'Photo B → A', 'Dark B → A'], flux))),
        r._chart('photons', 'Incident and absorbed photon rates', 'mol L⁻¹ s⁻¹', {'Incident': incident, 'Absorbed': absorbed}),
        r._chart('absorbance', 'Optical absorbance', 'dimensionless', {'Absorbance': absorbance})], rows, diag,
        ['Abs=path*(epsilon_A*A+epsilon_B*B); I_abs=I_vol*(1-10^(-Abs))',
         'Absorbed photons partition in proportion to epsilon_i*C_i; r_photo_i=Phi_i*I_abs_i',
         'I_vol=I_area/(10*path_cm); dB/dt=r_AB-r_BA-k_dark*B'],
        ['Homogeneous well-mixed monochromatic solution, constant absorption coefficients and quantum yields. No scattering, heating, excited-state saturation or radical-chain amplification.',
         'Quantum yields are restricted to [0,1] for this one-photon isomerization model. Concentration populations are schematics, not molecular trajectories.'],
        _network(['A', 'B'], [('photo_ab', 'A', 'B'), ('photo_ba', 'B', 'A'), ('dark_back', 'B', 'A')]))


def simulate_excited_state_quenching(data):
    import numpy as np
    key = 'simulate_excited_state_quenching'; p = _params(data, key)
    total, excited = p['total_mol_l'], p['initial_excited_fraction']
    pump, fluorescence, nonrad, isc, decay, product = (p[k] for k in ['excitation_s', 'fluorescence_s', 'nonradiative_s', 'intersystem_crossing_s', 'triplet_decay_s', 'product_formation_s'])
    quench = p['quenching_l_mol_s']*p['quencher_mol_l']; loss = fluorescence+nonrad+isc+quench
    def rhs(t, y):
        g, s, tr, prod = y[:4]; excitation = pump*g; emission = fluorescence*s
        return np.array([-excitation+(fluorescence+nonrad+quench)*s+decay*tr,
            excitation-loss*s, isc*s-(decay+product)*tr, product*tr, emission, quench*s, excitation])
    time, y, diag = r._integrate(rhs, [1-excited, excited, 0, 0, 0, 0, 0], {'duration': p['duration_s'], 'points': p['points']})
    y *= total
    r._check_concentrations(y[:4], total); drift = float(max(abs(y[:4].sum(axis=0)-total)))
    if drift > max(1e-12, total*1e-6):
        fail('Chromophore inventory balance exceeded tolerance.', 'MASS_BALANCE_FAILED')
    diag.update(max_inventory_balance_error_mol_l=drift, singlet_lifetime_s=1/loss if loss else None,
                fluorescence_branch_yield=fluorescence/loss if loss else None)
    rows = [{'time_s': float(t), **{name+'_mol_l': float(y[j, i]) for j, name in enumerate(['G', 'S', 'T', 'P'])},
        'fluorescence_mol_l_s': float(fluorescence*y[1, i]), 'cumulative_emitted_mol_l': float(y[4, i]),
        'cumulative_quenched_mol_l': float(y[5, i]), 'cumulative_excitation_mol_l': float(y[6, i])} for i, t in enumerate(time)]
    return _study(key, p, time, [r._chart('concentration', 'Chromophore state populations', 'mol L⁻¹', dict(zip(['G', 'S', 'T', 'P'], y[:4]))),
        r._chart('emission', 'Emission and product formation', 'mol L⁻¹ s⁻¹', {'Fluorescence': fluorescence*y[1], 'Product': product*y[2]}),
        r._chart('events', 'Cumulative state events', 'mol L⁻¹', {'Emitted': y[4], 'Quenched': y[5], 'Excitation': y[6]})], rows, diag,
        ['dS/dt=k_pump*G-(k_f+k_nr+k_isc+k_q*Q)*S', 'dT/dt=k_isc*S-(k_decay+k_product)*T; dP/dt=k_product*T',
         'G+S+T+P=constant; fluorescence=k_f*S'],
        ['Abstract linear state kinetics with a maintained quencher reservoir and prescribed pseudo-first-order pump. No spectrum, electronic structure or optical attenuation is inferred.',
         'The singlet branch yield is conditional on the supplied decay rates; it is not an experimental fluorescence quantum-yield determination.'],
        _network(['G', 'S', 'T', 'P'], [('excitation', 'G', 'S'), ('fluorescence', 'S', 'G'), ('nonradiative', 'S', 'G'),
            ('quenching', 'S', 'G'), ('intersystem_crossing', 'S', 'T'), ('triplet_decay', 'T', 'G'), ('product', 'T', 'P')]))


def _electrochemical(data, key):
    import numpy as np
    p = _params(data, key); cyclic = key == 'simulate_cyclic_voltammetry'
    diffusion, length, total, k0 = (p[name] for name in ['diffusivity_m2_s', 'domain_length_m', 'total_concentration_mol_m3', 'standard_rate_m_s'])
    if cyclic:
        delta = p['vertex_potential_v']-p['start_potential_v']
        if abs(delta) < 1e-6 or p['points'] % 2 != 1:
            fail('A cycle needs distinct start/vertex potentials and an odd sample count.')
        half = abs(delta)/p['scan_rate_v_s']; duration = 2*half
        number(duration, 'derived cycle duration', 1e-6, 1e5)
        start = p['start_potential_v']; direction = 1 if delta > 0 else -1
        def potential(t):
            return start+direction*p['scan_rate_v_s']*(t if t <= half else duration-t)
    else:
        duration = p['duration_s']; start = p['step_potential_v']
        def potential(t):
            return start
    factor = p['electrons']*F/(R*p['temperature_k']); alpha = p['alpha']
    extrema = [start, p['vertex_potential_v']] if cyclic else [start]
    if max(abs(factor*(e-p['formal_potential_v'])) for e in extrema) > 50:
        fail('Potential / temperature combination exceeds the Butler–Volmer exponent limit.', 'POTENTIAL_RANGE')
    cells = p['cells']; dx = length/cells; conductance = diffusion/dx; surface_conductance = 2*conductance
    def flux(t, u):
        eta = factor*(potential(t)-p['formal_potential_v'])
        reduction, oxidation = k0*math.exp(-alpha*eta), k0*math.exp((1-alpha)*eta)
        surface = (surface_conductance*u+oxidation)/(surface_conductance+reduction+oxidation)
        # Elimination of the boundary concentrations includes half-cell diffusion resistance.
        net = surface_conductance*(reduction*u-oxidation*(1-u))/(surface_conductance+reduction+oxidation)
        return net, surface
    def rhs(t, y):
        u = y[:cells]; j, surface = flux(t, u[0]); internal = conductance*np.diff(u)
        change = (np.r_[internal, 0]-np.r_[j, internal])/dx
        return np.r_[change, j]
    time, y, diag = r._integrate(rhs, np.r_[np.full(cells, p['initial_oxidized_fraction']), 0],
        {'duration': duration, 'points': p['points']}, max_step=half/80 if cyclic else float('inf'))
    u = y[:cells]
    if u.min() < -1e-7 or u.max() > 1+1e-7:
        fail('Electrode concentrations left the physical interval.', 'CONCENTRATION_RANGE')
    error = float(max(abs(dx*(u-p['initial_oxidized_fraction']).sum(axis=0)+y[-1])))
    if error > max(1e-13, length*1e-6):
        fail('Electrode material/electron inventory failed.', 'CHARGE_BALANCE_FAILED')
    boundary = np.array([flux(t, ui) for t, ui in zip(time, u[0])])
    j, surface = boundary[:, 0]*total, boundary[:, 1]*total
    potentials = np.array([potential(t) for t in time]); faradaic = -p['electrons']*F*j
    capacitive = p['capacitance_f_m2']*direction*p['scan_rate_v_s']*np.where(time < half, 1, -1) if cyclic else np.zeros(len(time))
    charge = -p['electrons']*F*y[-1]*total
    capacitive_charge = p['capacitance_f_m2']*(potentials-start) if cyclic else np.zeros(len(time))
    mean = u.mean(axis=0)*total; current = faradaic+capacitive
    diag.update(max_inventory_balance_error_mol_m2=error*total, max_charge_balance_error_c_m2=error*total*p['electrons']*F,
        diffusion_length_ratio=math.sqrt(diffusion*duration)/length, cells=cells, duration_s=duration,
        maximum_faradaic_current_a_m2=float(max(faradaic)), minimum_faradaic_current_a_m2=float(min(faradaic)))
    rows = [{'time_s': float(t), 'potential_v': float(potentials[i]), 'surface_O_mol_m3': float(surface[i]),
        'surface_R_mol_m3': float(total-surface[i]), 'mean_O_mol_m3': float(mean[i]), 'mean_R_mol_m3': float(total-mean[i]),
        'faradaic_a_m2': float(faradaic[i]), 'capacitive_a_m2': float(capacitive[i]), 'total_current_a_m2': float(current[i]),
        'faradaic_charge_c_m2': float(charge[i]), 'capacitive_charge_c_m2': float(capacitive_charge[i])} for i, t in enumerate(time)]
    result = _study(key, p, time, [r._chart('potential', 'Applied potential', 'V', {'Potential': potentials}),
        r._chart('current', 'Electrode current density', 'A m⁻²', {'Faradaic': faradaic, 'Capacitive': capacitive, 'Total': current}),
        r._chart('concentration', 'Electrode surface concentrations', 'mol m⁻³', {'O at surface': surface, 'R at surface': total-surface}),
        r._chart('charge', 'Integrated electrode charge', 'C m⁻²', {'Faradaic': charge, 'Capacitive': capacitive_charge})], rows, diag,
        ['dO/dt=D d²O/dx²; R=C_total-O (equal diffusivities)',
         'j_reduction=k0[exp(-alpha*nF*eta/RT)*O_s-exp((1-alpha)*nF*eta/RT)*R_s]',
         'D dO/dx(0)=j_reduction; dO/dx(L)=0; i_F=-nF*j_reduction',
         'Anodic current positive; i_C=Cdl*dE/dt and Q_C=Cdl*(E-E_start) for cyclic scans'],
        ['Planar finite closed slab, equal diffusion coefficients, supporting electrolyte, no migration/convection, uncompensated resistance, adsorption or coupled homogeneous chemistry.',
         'The reflecting far wall matters once diffusion reaches the domain edge; this is not an automatically semi-infinite diffusion result.',
         'Anodic current is positive. CV capacitive current jumps at reversal (the reversal sample uses the return-scan value); the potential-step model omits the ideal instantaneous capacitive impulse.'],
        _network(['O', 'R'], [('reduction', 'O', 'R'), ('oxidation', 'R', 'O')]))
    result['spatial_profile'] = {'title': 'Oxidized-species diffusion profile', 'x_label': 'Distance from electrode', 'x_unit': 'm',
        'y_label': 'O concentration', 'y_unit': 'mol m⁻³', 'x': ((np.arange(cells)+.5)*dx).tolist(), 'values': (u.T*total).tolist()}
    if cyclic:
        result['phase_plot'] = {'title': 'Cyclic voltammogram', **visual('Potential', 'V', 'Current density', 'A m⁻²',
            [series('faradaic', 'Faradaic', potentials.tolist(), faradaic.tolist()), series('total', 'Total', potentials.tolist(), current.tolist())])}
    return result


def simulate_cyclic_voltammetry(data):
    return _electrochemical(data, 'simulate_cyclic_voltammetry')


def simulate_chronoamperometry(data):
    return _electrochemical(data, 'simulate_chronoamperometry')


def fit_arrhenius_eyring(data):
    import numpy as np
    key = 'fit_arrhenius_eyring'; p = _params(data, key)
    temperature, rate = np.array(p['temperatures_k']), np.array(p['rate_constants_s'])
    if len(temperature) != len(rate):
        fail('Temperature and rate arrays must have matching lengths.')
    x = 1/temperature; center = x.mean(); span = np.ptp(x)
    if span < 1e-10:
        fail('Temperature variation is insufficient to identify activation parameters.', 'UNIDENTIFIABLE')
    design = np.column_stack([np.ones(len(x)), (x-center)/span]); sigma = p['log_rate_sd']
    transformed = np.log(rate)-(np.log(temperature) if p['model'] == 'eyring' else 0)
    coef, _, rank, singular = np.linalg.lstsq(design, transformed, rcond=None)
    if rank != 2:
        fail('Activation fit is rank deficient.', 'UNIDENTIFIABLE')
    covariance = sigma**2*np.linalg.inv(design.T @ design)
    transform = np.array([[1, -center/span], [0, 1/span]])
    intercept, slope = transform @ coef; cov = transform @ covariance @ transform.T
    predicted_log = design @ coef+(np.log(temperature) if p['model'] == 'eyring' else 0)
    residual = predicted_log-np.log(rate)
    parameter_rows = [{'parameter': 'Activation energy' if p['model'] == 'arrhenius' else 'Activation enthalpy',
        'value': float(-R*slope), 'standard_error': float(R*math.sqrt(cov[1, 1])), 'unit': 'J mol^-1'}]
    if p['model'] == 'arrhenius':
        parameter_rows.append({'parameter': 'ln(A / s^-1)', 'value': float(intercept), 'standard_error': float(math.sqrt(cov[0, 0])), 'unit': 'dimensionless'})
    else:
        parameter_rows.append({'parameter': 'Activation entropy (transmission coefficient=1)', 'value': float(R*(intercept-math.log(KB_OVER_H))),
            'standard_error': float(R*math.sqrt(cov[0, 0])), 'unit': 'J mol^-1 K^-1'})
    order = np.argsort(x); predicted = np.exp(predicted_log)
    return {'kind': 'activation-fit', 'title': MODELS[key][0], 'parameters': parameter_rows,
        'rows': [{'temperature_k': float(t), 'observed_rate_s': float(rate[i]), 'fitted_rate_s': float(predicted[i]),
                  'log_residual': float(residual[i])} for i, t in enumerate(temperature)],
        'visualization': visual('Inverse temperature', 'K⁻¹', 'ln(k / s⁻¹)' if p['model'] == 'arrhenius' else 'ln(k/T / s⁻¹ K⁻¹)', '',
            [series('observed', 'Observed', x.tolist(), transformed.tolist(), 'points'),
             series('fit', 'Fitted', x[order].tolist(), (design @ coef)[order].tolist())]),
        'residual_visualization': visual('Temperature', 'K', 'ln(k_fit/k_observed)', '', [series('residual', 'Log residual', temperature.tolist(), residual.tolist(), 'points')]),
        'diagnostics': {'rank': int(rank), 'observations': len(x), 'degrees_of_freedom': len(x)-2,
            'chi_square': float(sum((residual/sigma)**2)), 'reduced_chi_square': float(sum((residual/sigma)**2)/(len(x)-2)),
            'intercept_slope_covariance': cov.tolist()},
        'method': {'parameters': p, 'equation': 'ln(k)=ln(A)-Ea/(RT)' if p['model'] == 'arrhenius' else 'ln(k/T)=ln(kB/h)+ΔS/R-ΔH/(RT)'},
        'warnings': ['First-order rate constants in s^-1 only. Standard errors condition on the supplied independent Gaussian log-rate SD; they are not inferred experimental uncertainties.',
                     'A straight-line fit does not establish mechanism or justify extrapolation. Eyring parameters assume a unit transmission coefficient and temperature-independent activation enthalpy/entropy.']}


def compare_integrated_rate_laws(data):
    import numpy as np
    from scipy.optimize import least_squares
    key = 'compare_integrated_rate_laws'; p = _params(data, key)
    time, observed = np.array(p['time_s']), np.array(p['concentrations_mol_l'])
    if len(time) != len(observed) or time[0] != 0 or np.any(np.diff(time) <= 0):
        fail('Matched observations require strictly increasing times starting at zero.')
    initial, sigma = p['initial_concentration_mol_l'], p['measurement_sd_mol_l']; end = time[-1]
    rows, predictions, residuals = [], {}, {}
    for order in [0, 1, 2]:
        # A dimensionless extent parameter keeps unlike rate units comparably scaled.
        def predict(theta):
            extent = theta*time/end
            return initial*(np.maximum(1-extent, 0) if order == 0 else np.exp(-extent) if order == 1 else 1/(1+extent))
        def fun(theta):
            return (predict(theta[0])-observed)/sigma
        fit = least_squares(fun, [.5], bounds=(0, 1e6), max_nfev=p['max_evaluations'], ftol=1e-11, xtol=1e-11, gtol=1e-11)
        if not fit.success:
            fail(f'Order {order} fit did not converge; no candidate was discarded: {fit.message}', 'FIT_FAILED')
        prediction = predict(fit.x[0]); error = prediction-observed
        k = float(fit.x[0]*initial/end if order == 0 else fit.x[0]/end if order == 1 else fit.x[0]/(end*initial))
        # Known measurement variance and fixed independently supplied C0: one fitted parameter.
        chi = float(sum((error/sigma)**2)); aic = chi+len(time)*math.log(2*math.pi*sigma**2)+2
        label = ['Zero order', 'First order', 'Second order'][order]
        predictions[label], residuals[label] = prediction, error
        rows.append({'model': label, 'order': order, 'rate_constant': k,
            'rate_unit': ['mol L^-1 s^-1', 's^-1', 'L mol^-1 s^-1'][order], 'rmse_mol_l': float(np.sqrt(np.mean(error**2))),
            'chi_square': chi, 'aicc': aic+4/(len(time)-2), 'evaluations': int(fit.nfev),
            'at_parameter_boundary': bool(fit.active_mask[0] != 0),
            'locally_identifiable': bool(np.linalg.norm(fit.jac) > 1e-8), 'converged': True})
    scores = np.array([row['aicc'] for row in rows]); delta = scores-min(scores); weights = np.exp(-delta/2); weights /= sum(weights)
    for row, d, weight in zip(rows, delta, weights):
        row.update(delta_aicc=float(d), akaike_weight=float(weight))
    rows.sort(key=lambda row: row['aicc'])
    return {'kind': 'rate-law-comparison', 'title': MODELS[key][0], 'ranking': rows,
        'rows': [{'time_s': float(t), 'observed_mol_l': float(observed[i]),
            **{name+'_predicted_mol_l': float(values[i]) for name, values in predictions.items()},
            **{name+'_residual_mol_l': float(values[i]) for name, values in residuals.items()}} for i, t in enumerate(time)],
        'visualization': visual('Time', 's', 'Concentration', 'mol L⁻¹', [series('observed', 'Observed', time.tolist(), observed.tolist(), 'points'),
            *[series(name, name, time.tolist(), values.tolist()) for name, values in predictions.items()]]),
        'residual_visualization': visual('Time', 's', 'Predicted − observed', 'mol L⁻¹', [series(name, name, time.tolist(), values.tolist()) for name, values in residuals.items()]),
        'diagnostics': {'observations': len(time), 'fitted_parameters_per_model': 1, 'fixed_initial_concentration_mol_l': initial,
                        'measurement_sd_mol_l': sigma, 'best_aicc_model': rows[0]['model']},
        'method': {'parameters': p, 'equations': ['C0−k0*t (clamped at depletion)', 'C0 exp(-k1*t)', 'C0/(1+k2*C0*t)',
                      'AICc=chi²+n ln(2πσ²)+2p+2p(p+1)/(n-p-1); p=1, known sigma, fixed C0']},
        'warnings': ['AICc ranks only these three models under independent Gaussian errors with the supplied known SD and independently fixed C0. Weights are relative support within this candidate set, not mechanism probabilities.',
                     'Zero-order depletion has a boundary kink; boundary or locally unidentifiable fits make regular AICc assumptions approximate. Inspect each candidate flag. Residuals and all candidates are retained, and any nonconverged candidate fails the comparison.']}


def operator_specs():
    return [(key, title, category, description,
        {'type': 'object', 'properties': fields, 'required': [name for name, rule in fields.items() if 'default' not in rule], 'additionalProperties': False},
        {**{name: rule['default'] for name, rule in fields.items() if 'default' in rule}, **example},
        'Independent photochemical/electrochemical/inference equations / NumPy / SciPy', ['numpy', 'scipy'])
        for key, (title, category, description, fields, example) in MODELS.items()]


OPERATORS = {name: finite_result(globals()[name]) for name in MODELS}
