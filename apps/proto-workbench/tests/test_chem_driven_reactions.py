"""Analytical and independent-reference tests for driven reactions and inference."""
import copy
import importlib.util
import json
import math
from pathlib import Path
import unittest
import numpy as np
from scipy.linalg import expm
from scipy.optimize import minimize_scalar

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('driven_worker', Path(__file__).resolve().parents[1]/'runtime/chem-integration/chem_science.py')
science = importlib.util.module_from_spec(spec); spec.loader.exec_module(science)
R, F = 8.31446261815324, 96485.33212
IDS = ['simulate_photochemical_isomerization', 'simulate_excited_state_quenching', 'simulate_cyclic_voltammetry',
       'simulate_chronoamperometry', 'fit_arrhenius_eyring', 'compare_integrated_rate_laws']


def column(result, key):
    return np.array([row[key] for row in result['rows']])


class DrivenReactionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.examples = {op['id']: op['example_input'] for op in science.catalog()['operators'] if op['id'] in IDS}

    def request(self, key, **changes):
        return science.execute({'operator': key, 'input': {**copy.deepcopy(self.examples[key]), **changes}})

    def run_model(self, key, **changes):
        result = self.request(key, **changes)
        self.assertTrue(result['ok'], result.get('error'))
        json.dumps(result, allow_nan=False)
        self.assertIn('chem_driven_reactions.py', result['provenance']['source_files_sha256'])
        return result['result']

    def test_examples_have_complete_curves_and_source_provenance(self):
        for key in IDS:
            with self.subTest(key=key):
                result = self.run_model(key)
                if result['kind'] == 'reaction-study':
                    for chart in result['charts']:
                        for line in chart['series']:
                            self.assertEqual(len(line['values']), len(result['time_s']))
                    if 'spatial_profile' in result:
                        self.assertEqual(len(result['spatial_profile']['values']), len(result['time_s']))

    def test_dark_photochemistry_and_zero_absorption(self):
        for changes in [{'photon_flux_mol_m2_s': 0}, {'epsilon_a_l_mol_cm': 0, 'epsilon_b_l_mol_cm': 0}]:
            result = self.run_model(IDS[0], initial_a_mol_l=0, initial_b_mol_l=.0001, **changes)
            expected = .0001*np.exp(-.003*np.array(result['time_s']))
            np.testing.assert_allclose(column(result, 'B_mol_l'), expected, rtol=3e-8, atol=1e-12)
            self.assertEqual(result['diagnostics']['absorbed_photons_mol_l'], 0)
            self.assertIsNone(result['diagnostics']['event_yield_per_absorbed_photon'])

    def test_equal_absorptivity_exact_photostationary_solution(self):
        # Equal absorptivities make absorbed photons constant while concentrations change.
        result = self.run_model(IDS[0], epsilon_a_l_mol_cm=10000, epsilon_b_l_mol_cm=10000, modulation_depth=0,
                                dark_back_rate_s=0, duration_s=400)
        total = .0001; absorbed = .0001/10*(1-10**(-10000*total))
        forward, back = .4*absorbed/total, .15*absorbed/total
        expected = total*back/(forward+back)+(total-total*back/(forward+back))*np.exp(-(forward+back)*np.array(result['time_s']))
        np.testing.assert_allclose(column(result, 'A_mol_l'), expected, rtol=3e-8, atol=1e-12)
        self.assertLessEqual(result['diagnostics']['event_yield_per_absorbed_photon'], 1)

    def test_modulated_incident_photon_inventory(self):
        result = self.run_model(IDS[0], duration_s=37)
        t = np.array(result['time_s']); w = 2*math.pi/20
        expected = .0001/10*(t+.5*(1-np.cos(w*t))/w)
        np.testing.assert_allclose(column(result, 'cumulative_incident_mol_l'), expected, atol=2e-11)
        self.assertTrue(np.all(column(result, 'cumulative_absorbed_mol_l') <= expected+2e-11))

    def test_excited_state_matrix_exponential_and_inventory(self):
        result = self.run_model(IDS[1])
        matrix = np.array([[-.2, 8, .3, 0], [.2, -9, 0, 0], [0, 1, -.4, 0], [0, 0, .1, 0]])
        expected = np.stack([expm(matrix*t) @ [.0001, 0, 0, 0] for t in result['time_s']])
        actual = np.stack([column(result, name+'_mol_l') for name in ['G', 'S', 'T', 'P']], axis=1)
        np.testing.assert_allclose(actual, expected, atol=2e-12)
        self.assertLess(result['diagnostics']['max_inventory_balance_error_mol_l'], 1e-12)

    def test_quenched_pulse_decay_and_fluorescence_yield_at_small_scale(self):
        result = self.run_model(IDS[1], total_mol_l=1e-10, excitation_s=0, initial_excited_fraction=1, duration_s=4)
        t = np.array(result['time_s'])
        np.testing.assert_allclose(column(result, 'S_mol_l')/1e-10, np.exp(-9*t), atol=2e-9)
        np.testing.assert_allclose(column(result, 'cumulative_emitted_mol_l')/1e-10, 5/9*(1-np.exp(-9*t)), atol=2e-9)
        self.assertAlmostEqual(result['diagnostics']['singlet_lifetime_s'], 1/9)

    def test_cv_triangle_vertex_capacitive_current_and_charge(self):
        result = self.run_model(IDS[2], standard_rate_m_s=0)
        t = np.array(result['time_s']); potential = .25-.05*np.where(t <= 10, t, 20-t)
        np.testing.assert_allclose(column(result, 'potential_v'), potential, atol=1e-12)
        self.assertEqual(potential[150], -.25)
        np.testing.assert_allclose(column(result, 'faradaic_a_m2'), 0, atol=1e-12)
        np.testing.assert_allclose(column(result, 'capacitive_a_m2'), np.where(t < 10, -.01, .01), atol=1e-12)
        np.testing.assert_allclose(column(result, 'capacitive_charge_c_m2'), .2*(potential-.25), atol=1e-12)
        self.assertEqual(result['phase_plot']['series'][0]['x'], result['phase_plot']['series'][1]['x'])

    def test_electrode_equilibrium_no_current(self):
        result = self.run_model(IDS[3], step_potential_v=0, initial_oxidized_fraction=.5)
        np.testing.assert_allclose(column(result, 'faradaic_a_m2'), 0, atol=1e-12)
        np.testing.assert_allclose(result['spatial_profile']['values'], .5, atol=1e-12)

    def test_chronoamperometry_cottrell_limit_and_grid_refinement(self):
        errors = []
        for cells in [40, 80, 160]:
            result = self.run_model(IDS[3], standard_rate_m_s=.01, step_potential_v=-.4, cells=cells, duration_s=10)
            t = np.array(result['time_s']); keep = (t >= 1)&(t <= 5)
            expected = -F*np.sqrt(1e-9/(math.pi*t[keep]))
            errors.append(float(np.max(abs(column(result, 'faradaic_a_m2')[keep]/expected-1))))
            self.assertLess(result['diagnostics']['max_charge_balance_error_c_m2'], 1e-8)
        self.assertLess(errors[-1], .006)
        self.assertLess(errors[-1], errors[0]/3)

    def test_cv_cathodic_then_anodic_and_charge_inventory(self):
        result = self.run_model(IDS[2]); t = np.array(result['time_s']); i = column(result, 'faradaic_a_m2')
        self.assertLess(min(i[t <= 10]), -.1); self.assertGreater(max(i[t > 10]), .1)
        balance = F*.0005*(column(result, 'mean_O_mol_m3')-1)
        np.testing.assert_allclose(column(result, 'faradaic_charge_c_m2'), balance, atol=1e-8)
        self.assertTrue(np.all(column(result, 'surface_O_mol_m3') >= -1e-8))

    def test_arrhenius_exact_parameters_and_uncertainty_scaling(self):
        result = self.run_model(IDS[4])
        self.assertAlmostEqual(result['parameters'][0]['value'], 50000, places=6)
        self.assertAlmostEqual(result['parameters'][1]['value'], math.log(1e8), places=8)
        doubled = self.run_model(IDS[4], log_rate_sd=.1)
        self.assertAlmostEqual(doubled['parameters'][0]['standard_error']/result['parameters'][0]['standard_error'], 2)

    def test_eyring_recovers_activation_enthalpy_entropy(self):
        temps = [280, 290, 300, 310, 320, 330]; kb_h = 20836619123.327576
        rates = [kb_h*t*math.exp(-40/R-45000/(R*t)) for t in temps]
        result = self.run_model(IDS[4], model='eyring', temperatures_k=temps, rate_constants_s=rates)
        self.assertAlmostEqual(result['parameters'][0]['value'], 45000, places=6)
        self.assertAlmostEqual(result['parameters'][1]['value'], -40, places=7)

    def test_each_rate_law_is_recovered_on_its_own_data(self):
        times = np.array([0, 1, 2, 3, 4, 5, 7, 10.]); k = .07
        for order in [0, 1, 2]:
            concentrations = 1-k*times if order == 0 else np.exp(-k*times) if order == 1 else 1/(1+k*times)
            result = self.run_model(IDS[5], time_s=times.tolist(), concentrations_mol_l=concentrations.tolist(), measurement_sd_mol_l=.001)
            winner = result['ranking'][0]
            self.assertEqual(winner['order'], order)
            self.assertAlmostEqual(winner['rate_constant'], k, places=7)
            self.assertAlmostEqual(sum(item['akaike_weight'] for item in result['ranking']), 1)
            self.assertEqual(len(result['rows']), len(times))

    def test_comparison_against_independent_scalar_optimizer_and_likelihood(self):
        result = self.run_model(IDS[5]); p = self.examples[IDS[5]]
        t, observed = np.array(p['time_s']), np.array(p['concentrations_mol_l'])
        for row in result['ranking']:
            order = row['order']
            def prediction(k):
                return np.maximum(1-k*t, 0) if order == 0 else np.exp(-k*t) if order == 1 else 1/(1+k*t)
            opt = minimize_scalar(lambda k: sum((prediction(k)-observed)**2), bounds=(0, 1), method='bounded', options={'xatol': 1e-13})
            self.assertAlmostEqual(row['rate_constant'], opt.x, places=6)
            chi = sum(((prediction(row['rate_constant'])-observed)/.01)**2)
            self.assertAlmostEqual(row['aicc'], chi+len(t)*math.log(2*math.pi*.01**2)+2+4/(len(t)-2), places=7)

    def test_invalid_inputs_fail_explicitly(self):
        cases = [(IDS[0], {'quantum_yield_ab': 1.1}), (IDS[0], {'initial_a_mol_l': 0, 'initial_b_mol_l': 0}),
            (IDS[0], {'light_period_s': .00001}), (IDS[1], {'quencher_mol_l': -1}),
            (IDS[2], {'points': 300}), (IDS[2], {'vertex_potential_v': .25}),
            (IDS[2], {'start_potential_v': 5}), (IDS[3], {'cells': True}),
            (IDS[4], {'temperatures_k': [300]*6}), (IDS[4], {'rate_constants_s': [0]*6}),
            (IDS[4], {'temperatures_k': [280, 290, 300]}), (IDS[5], {'time_s': [0, 2, 1, 3]}),
            (IDS[5], {'measurement_sd_mol_l': 0}), (IDS[5], {'concentrations_mol_l': [None]*8}),
            (IDS[1], {'unknown': 1})]
        for key, changes in cases:
            with self.subTest(key=key, changes=changes):
                result = self.request(key, **changes)
                self.assertFalse(result['ok']); self.assertNotIn('result', result)


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(DrivenReactionTests))
    root = ROOT/'build/chem-driven-reaction-qa'; root.mkdir(parents=True, exist_ok=True)
    (root/'numerical-acceptance.json').write_text(json.dumps({'passed': result.wasSuccessful(), 'tests': result.testsRun,
        'failures': [(str(test), trace) for test, trace in result.failures], 'errors': [(str(test), trace) for test, trace in result.errors]}, indent=2)+'\n')
    raise SystemExit(not result.wasSuccessful())
