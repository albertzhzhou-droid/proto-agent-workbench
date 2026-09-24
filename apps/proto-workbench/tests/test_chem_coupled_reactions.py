"""Coupled reaction verification against analytical limits and independent solvers."""
import copy
import importlib.util
import json
import math
from pathlib import Path
import unittest
import numpy as np
from scipy.integrate import solve_ivp

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('coupled_worker', Path(__file__).resolve().parents[1]/'runtime/chem-integration/chem_science.py')
science = importlib.util.module_from_spec(spec)
spec.loader.exec_module(science)
IDS = ['simulate_nonisothermal_batch', 'simulate_nonisothermal_cstr', 'simulate_tanks_in_series',
       'simulate_catalyst_deactivation', 'simulate_gas_liquid_reaction', 'simulate_catalyst_pellet']


def network(k=.2, initial=1, activation=0):
    return {'species': [{'id': 'A', 'initial_concentration': initial, 'composition': {'M': 1}},
                        {'id': 'B', 'initial_concentration': 0, 'composition': {'M': 1}}],
            'reactions': [{'id': 'r', 'reactants': {'A': 1}, 'products': {'B': 1}, 'rate_constant': k,
                           'activation_energy_j_mol': activation, 'reference_temperature_k': 300}]}


def column(result, key):
    return np.array([row[key] for row in result['rows']])


class CoupledReactionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.examples = {op['id']: op['example_input'] for op in science.catalog()['operators'] if op['id'] in IDS}

    def request(self, key, **changes):
        params = {**copy.deepcopy(self.examples[key]), **changes}
        if 'network' in changes:
            params.pop('example', None)
        return science.execute({'operator': key, 'input': params})

    def run_model(self, key, **changes):
        envelope = self.request(key, **changes)
        self.assertTrue(envelope['ok'], envelope.get('error'))
        self.assertIn('chem_coupled_reactions.py', envelope['provenance']['source_files_sha256'])
        json.dumps(envelope, allow_nan=False)
        return envelope['result']

    def test_examples_and_synchronized_profiles(self):
        for key in IDS:
            with self.subTest(key=key):
                result = self.run_model(key)
                for chart in result['charts']:
                    for series in chart['series']:
                        self.assertEqual(len(series['values']), len(result['time_s']))
                if 'spatial_profile' in result:
                    profile = result['spatial_profile']
                    self.assertEqual(len(profile['values']), len(result['time_s']))
                    self.assertTrue(all(len(row) == len(profile['x']) for row in profile['values']))

    def test_adiabatic_first_order_material_and_energy_solution(self):
        result = self.run_model(IDS[0], network=network(), reaction_enthalpy_j_mol={'r': -40000},
                                heat_transfer_w_l_k=0, initial_temperature_k=300)
        t = np.array(result['time_s']); expected_a = np.exp(-.2*t)
        np.testing.assert_allclose(column(result, 'A_mol_l'), expected_a, atol=2e-8)
        np.testing.assert_allclose(column(result, 'temperature_k'), 300+20*(1-expected_a), atol=5e-7)
        self.assertLess(result['diagnostics']['max_energy_balance_error_j_l'], 1e-5)
        self.assertNotIn('effective_rate_constants', result['method'])

    def test_newton_cooling_without_reaction(self):
        result = self.run_model(IDS[0], network=network(0), reaction_enthalpy_j_mol={'r': 0},
                                initial_temperature_k=330, coolant_temperature_k=290, heat_transfer_w_l_k=100)
        t = np.array(result['time_s'])
        np.testing.assert_allclose(column(result, 'temperature_k'), 290+40*np.exp(-.05*t), atol=2e-6)

    def test_arrhenius_feedback_against_independent_explicit_integrator(self):
        result = self.run_model(IDS[0], network=network(.05, activation=30000), reaction_enthalpy_j_mol={'r': -40000},
                                initial_temperature_k=300, coolant_temperature_k=290, heat_transfer_w_l_k=10)
        def rhs(t, y):
            rate = .05*math.exp(-30000/8.314462618*(1/y[1]-1/300))*y[0]
            return [-rate, (40000*rate-10*(y[1]-290))/2000]
        reference = solve_ivp(rhs, (0, 60), [1, 300], method='DOP853', t_eval=result['time_s'], rtol=1e-12, atol=1e-13)
        self.assertTrue(reference.success)
        np.testing.assert_allclose(column(result, 'A_mol_l'), reference.y[0], atol=2e-8)
        np.testing.assert_allclose(column(result, 'temperature_k'), reference.y[1], atol=2e-6)

    def test_nonreactive_cstr_feed_and_cooling_solution(self):
        result = self.run_model(IDS[1], network=network(0, initial=0), reaction_enthalpy_j_mol={'r': 0},
            initial_temperature_k=320, feed_temperature_k=300, coolant_temperature_k=280, heat_transfer_w_l_k=100,
            feed_mol_l={'A': 2}, residence_time_s=10)
        t = np.array(result['time_s']); equilibrium = (300/10+.05*280)/.15
        np.testing.assert_allclose(column(result, 'temperature_k'), equilibrium+(320-equilibrium)*np.exp(-.15*t), atol=2e-6)
        np.testing.assert_allclose(column(result, 'A_mol_l'), 2*(1-np.exp(-t/10)), atol=2e-8)
        self.assertLess(result['diagnostics']['max_energy_balance_error_j_l'], 1e-5)

    def test_one_tank_matches_existing_cstr(self):
        changes = {'network': network(initial=0), 'feed_mol_l': {'A': 1}, 'residence_time_s': 10, 'duration_s': 60, 'points': 151}
        result = self.run_model(IDS[2], **changes, stages=1, target_species='A')
        reference = science.execute({'operator': 'simulate_cstr', 'input': changes})
        self.assertTrue(reference['ok'], reference.get('error'))
        np.testing.assert_allclose(column(result, 'A_mol_l'), column(reference['result'], 'A_mol_l'), atol=2e-8)
        self.assertEqual(result['spatial_profile']['x'], [1])

    def test_tank_train_steady_solution_and_inventory(self):
        result = self.run_model(IDS[2], network=network(initial=0), stages=5, target_species='A', duration_s=300)
        self.assertAlmostEqual(column(result, 'A_mol_l')[-1], 1/(1+.2*20/5)**5, places=8)
        np.testing.assert_allclose(result['spatial_profile']['values'][-1], [1/(1+.2*4)**i for i in range(1, 6)], atol=2e-8)
        self.assertLess(result['diagnostics']['max_inventory_balance_error'], 1e-7)

    def test_activity_and_conversion_analytical_solution(self):
        for kd, kr, a0 in [(.08, .02, .8), (.1, 0, 1), (0, 0, .3)]:
            with self.subTest(kd=kd, kr=kr):
                result = self.run_model(IDS[3], network=network(), reaction_ids=['r'], deactivation_s=kd, regeneration_s=kr, initial_activity=a0)
                t = np.array(result['time_s']); total = kd+kr
                eq = kr/total if total else a0
                activity = eq+(a0-eq)*np.exp(-total*t)
                exposure = eq*t+(a0-eq)*(1-np.exp(-total*t))/total if total else a0*t
                np.testing.assert_allclose(column(result, 'activity'), activity, atol=2e-8)
                np.testing.assert_allclose(column(result, 'A_mol_l'), np.exp(-.2*exposure), atol=2e-8)

    def test_unselected_pathway_remains_active(self):
        source = network()
        source['species'].append({'id': 'C', 'initial_concentration': 0, 'composition': {'M': 1}})
        source['reactions'].append({'id': 'other', 'reactants': {'A': 1}, 'products': {'C': 1}, 'rate_constant': .1})
        result = self.run_model(IDS[3], network=source, reaction_ids=['r'], initial_activity=0, regeneration_s=0)
        np.testing.assert_allclose(column(result, 'A_mol_l'), np.exp(-.1*np.array(result['time_s'])), atol=2e-8)
        np.testing.assert_allclose(column(result, 'B_mol_l'), 0, atol=1e-12)

    def test_absorption_and_stripping_analytical_limits(self):
        for initial in [0, .5]:
            result = self.run_model(IDS[4], initial_a_mol_l=initial, reaction_l_mol_s=0)
            expected = .1+(initial-.1)*np.exp(-.15*np.array(result['time_s']))
            np.testing.assert_allclose(column(result, 'A_mol_l'), expected, atol=2e-8)
            np.testing.assert_allclose(column(result, 'cumulative_transfer_mol_l'), expected-initial, atol=2e-8)
            self.assertLess(result['diagnostics']['max_inventory_balance_error'], 1e-7)

    def test_closed_second_order_gas_liquid_limit(self):
        result = self.run_model(IDS[4], initial_a_mol_l=1, initial_b_mol_l=1, kla_s=0, duration_s=10)
        expected = 1/(1+2*np.array(result['time_s']))
        np.testing.assert_allclose(column(result, 'A_mol_l'), expected, atol=2e-8)
        np.testing.assert_allclose(column(result, 'P_mol_l'), 1-expected, atol=2e-8)

    def test_closed_pellet_uniform_decay_and_porosity_storage(self):
        result = self.run_model(IDS[5], film_transfer_m_s=0, initial_fraction=.8, duration_s=50)
        expected = .8*np.exp(-.02/.4*np.array(result['time_s']))
        np.testing.assert_allclose(column(result, 'mean_pore_mol_m3'), expected, atol=2e-8)
        np.testing.assert_allclose(column(result, 'stored_mol_m3_pellet'), .4*expected, atol=2e-8)
        np.testing.assert_allclose(column(result, 'cumulative_reacted_mol_m3_pellet'), .4*(.8-expected), atol=2e-8)
        self.assertLess(result['diagnostics']['max_inventory_balance_error_mol_m3'], 1e-8)

    def test_pellet_steady_profile_and_grid_convergence(self):
        errors = []
        for cells in [20, 40, 80]:
            result = self.run_model(IDS[5], cells=cells, duration_s=500)
            phi = .0005*math.sqrt(.02/1e-9)
            eta = 3*(phi/math.tanh(phi)-1)/phi**2
            cs = 1/(1+eta*.02*.0005/(3*1e-5))
            x = np.array(result['spatial_profile']['x'])/.0005
            expected = cs*np.sinh(phi*x)/(x*math.sinh(phi))
            errors.append(float(max(abs(np.array(result['spatial_profile']['values'][-1])-expected))))
            self.assertLess(abs(column(result, 'inward_flux_mol_m2_s')[-1]/(.02*eta*cs*.0005/3)-1), .003)
            self.assertLess(result['diagnostics']['max_inventory_balance_error_mol_m3'], 1e-7)
        self.assertLess(errors[2], errors[0]/3)
        self.assertLess(errors[2], .0003)

    def test_nonreacting_uniform_pellet(self):
        result = self.run_model(IDS[5], initial_fraction=1, reaction_rate_s=0)
        np.testing.assert_allclose(result['spatial_profile']['values'], 1, atol=1e-12)
        np.testing.assert_allclose(column(result, 'inward_flux_mol_m2_s'), 0, atol=1e-12)
        self.assertEqual(result['diagnostics']['analytical_internal_effectiveness'], 1)

    def test_invalid_inputs_rejected_without_fabricated_results(self):
        cases = [(IDS[0], {'reaction_enthalpy_j_mol': {'A_to_B': -1}}),
                 (IDS[0], {'network': network(), 'reaction_enthalpy_j_mol': {'r': None}}),
                 (IDS[0], {'temperature_k': 300}),
                 (IDS[1], {'feed_mol_l': {'ghost': 1}}),
                 (IDS[2], {'stages': 0}), (IDS[2], {'target_species': 'ghost'}),
                 (IDS[3], {'reaction_ids': ['ghost']}), (IDS[3], {'reaction_ids': ['A_to_B', 'A_to_B']}),
                 (IDS[3], {'initial_activity': 1.01}), (IDS[4], {'kla_s': -1}),
                 (IDS[4], {'saturation_mol_l': float('nan')}), (IDS[5], {'cells': True}),
                 (IDS[5], {'porosity': 0}), (IDS[5], {'radius_m': 0})]
        for key, changes in cases:
            with self.subTest(key=key, changes=changes):
                envelope = self.request(key, **changes)
                self.assertFalse(envelope['ok'])
                self.assertNotIn('result', envelope)

    def test_inconsistent_reversible_heat_cycle_rejected(self):
        source = network()
        source['reactions'].append({'id': 'back', 'reactants': {'B': 1}, 'products': {'A': 1}, 'rate_constant': .1})
        result = self.request(IDS[0], network=source, reaction_enthalpy_j_mol={'r': -40000, 'back': -40000})
        self.assertFalse(result['ok'])
        self.assertIn('cycle', result['error']['message'])
        valid = self.run_model(IDS[0], network=source, reaction_enthalpy_j_mol={'r': -40000, 'back': 40000})
        self.assertLess(valid['diagnostics']['thermochemical_cycle_residual_j_mol'], 1e-6)

    def test_thermal_range_failure_is_explicit(self):
        result = self.request(IDS[0], network=network(), reaction_enthalpy_j_mol={'r': -1e6}, heat_capacity_j_l_k=1, heat_transfer_w_l_k=0)
        self.assertFalse(result['ok'])
        self.assertEqual(result['error']['code'], 'THERMAL_RANGE')


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(CoupledReactionTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    root = ROOT/'build/chem-coupled-reaction-qa'; root.mkdir(parents=True, exist_ok=True)
    (root/'numerical-acceptance.json').write_text(json.dumps({'passed': result.wasSuccessful(), 'tests': result.testsRun,
        'failures': [(str(test), trace) for test, trace in result.failures], 'errors': [(str(test), trace) for test, trace in result.errors]}, indent=2)+'\n')
    raise SystemExit(not result.wasSuccessful())
