"""Independent analytical limits, balances and perturbation checks."""
import copy
import importlib.util
import json
import math
from pathlib import Path
import unittest
import numpy as np
from scipy.linalg import expm

ROOT = Path(__file__).resolve().parents[3]
WORKER = Path(__file__).resolve().parents[1] / 'runtime/chem-integration/chem_science.py'
spec = importlib.util.spec_from_file_location('reaction_study_worker', WORKER)
science = importlib.util.module_from_spec(spec)
spec.loader.exec_module(science)


def first_order(k=.2, initial=1):
    return {'species': [{'id': 'A', 'initial_concentration': initial, 'composition': {'M': 1}},
                        {'id': 'B', 'initial_concentration': 0, 'composition': {'M': 1}}],
            'reactions': [{'id': 'r', 'reactants': {'A': 1}, 'products': {'B': 1}, 'rate_constant': k}]}


class ReactionStudyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ids = {'simulate_reversible_chain', 'simulate_catalytic_cycle', 'simulate_cstr', 'simulate_pfr', 'simulate_semibatch',
               'analyze_reaction_sensitivity', 'analyze_reaction_flux', 'propagate_reaction_uncertainty'}
        cls.examples = {op['id']: op['example_input'] for op in science.catalog()['operators'] if op['id'] in ids}

    def run_model(self, name, **changes):
        data = {**copy.deepcopy(self.examples[name]), **changes}
        if 'network' in changes:
            data.pop('example', None)
        result = science.execute({'operator': name, 'input': data})
        self.assertTrue(result['ok'], result.get('error'))
        self.assertIn('chem_reactions.py', result['provenance']['source_files_sha256'])
        json.dumps(result, allow_nan=False)
        return result['result']

    def test_all_examples_finite_with_matching_chart_samples(self):
        for name in self.examples:
            with self.subTest(name=name):
                r = self.run_model(name)
                self.assertEqual(r['kind'], 'reaction-study')
                for chart in r['charts']:
                    for series in chart['series']:
                        self.assertEqual(len(series['values']), len(r['time_s']))
                        self.assertTrue(all(math.isfinite(v) for v in series['values']))

    def test_reversible_cascade_matrix_exponential_and_equilibrium(self):
        r = self.run_model('simulate_reversible_chain', duration_s=400)
        matrix = np.array([[-.4, .1, 0], [.4, -.3, .05], [0, .2, -.05]])
        for row in r['rows']:
            expected = expm(matrix*row['time_s']) @ [1, 0, 0]
            np.testing.assert_allclose([row[s+'_mol_l'] for s in ['A', 'B', 'C']], expected, atol=3e-9, rtol=3e-8)
        np.testing.assert_allclose(list(r['diagnostics']['kinetic_equilibrium_mol_l'].values()), np.array([1, 4, 16])/21)
        self.assertLess(r['diagnostics']['final_equilibrium_distance_mol_l'], 1e-8)
        self.assertEqual(len(r['diagnostics']['relaxation_times_s']), 2)

    def test_catalyst_substrate_inhibitor_conservation_and_inhibition(self):
        inhibited = self.run_model('simulate_catalytic_cycle')
        free = self.run_model('simulate_catalytic_cycle', inhibitor_mol_l=0)
        self.assertLess(inhibited['rows'][-1]['P_mol_l'], free['rows'][-1]['P_mol_l'])
        for row in inhibited['rows']:
            self.assertAlmostEqual(row['E_mol_l']+row['ES_mol_l']+row['EI_mol_l'], .05, delta=2e-10)
            self.assertAlmostEqual(row['S_mol_l']+row['ES_mol_l']+row['P_mol_l'], 1, delta=2e-9)
            self.assertAlmostEqual(row['I_mol_l']+row['EI_mol_l'], .1, delta=2e-10)
        reverse = self.run_model('simulate_catalytic_cycle', substrate_mol_l=0, product_mol_l=1, inhibitor_mol_l=0)
        self.assertGreater(reverse['rows'][-1]['S_mol_l'], 0)
        self.assertLess(reverse['rows'][-1]['P_mol_l'], 1)

    def test_cstr_empty_initial_vessel_startup_and_steady_limit(self):
        r = self.run_model('simulate_cstr', network=first_order(initial=0), residence_time_s=5, duration_s=60)
        for row in r['rows']:
            expected = .5*(1-math.exp(-.4*row['time_s']))
            self.assertAlmostEqual(row['A_mol_l'], expected, delta=4e-9)
            total = 1-math.exp(-row['time_s']/5)
            self.assertAlmostEqual(row['A_mol_l']+row['B_mol_l'], total, delta=4e-9)
        self.assertLess(r['diagnostics']['max_inventory_balance_error'], 1e-8)
        self.assertLess(r['diagnostics']['final_derivative_max_mol_l_s'], 2e-6)

    def test_pfr_exponential_residence_coordinate(self):
        r = self.run_model('simulate_pfr', network=first_order(), residence_time_s=15)
        self.assertEqual(r['axis_label'], 'Residence time')
        self.assertEqual(r['time_s'][-1], 15)
        for row in r['rows']:
            self.assertAlmostEqual(row['A_mol_l'], math.exp(-.2*row['time_s']), delta=4e-9)
            self.assertAlmostEqual(row['A_mol_l']+row['B_mol_l'], 1, delta=2e-9)

    def test_fed_batch_amount_solution_and_dilution(self):
        r = self.run_model('simulate_semibatch', network=first_order(), initial_volume_l=2, feed_l_s=.02, feed_mol_l={'A': 3})
        for row in r['rows']:
            t = row['time_s']; volume = 2+.02*t
            amount = .3+(2-.3)*math.exp(-.2*t)
            self.assertAlmostEqual(row['volume_l'], volume, delta=1e-12)
            self.assertAlmostEqual(row['A_mol_l'], amount/volume, delta=5e-9)
            self.assertAlmostEqual(row['A_amount_mol']+row['B_amount_mol'], 2+.06*t, delta=2e-8)
        r = self.run_model('simulate_semibatch', network=first_order(k=0), feed_mol_l={'A': 0}, feed_l_s=.1)
        for row in r['rows']:
            self.assertAlmostEqual(row['A_mol_l'], 1/(1+.1*row['time_s']), delta=2e-9)

    def test_forward_sensitivity_matches_closed_form(self):
        r = self.run_model('analyze_reaction_sensitivity', network=first_order(), reaction_ids=['r'], target_species='A')
        for i, row in enumerate(r['rows']):
            t = row['time_s']; expected = -.2*t*math.exp(-.2*t)
            self.assertAlmostEqual(r['sensitivities']['A']['r'][i], expected, delta=5e-9)
            self.assertAlmostEqual(r['sensitivities']['B']['r'][i], -expected, delta=5e-9)

    def test_nonlinear_sensitivity_zero_initial_species_against_perturbation(self):
        network = {'species': [{'id': 'A', 'initial_concentration': 1, 'composition': {'M': 1}},
                               {'id': 'D', 'initial_concentration': 0, 'composition': {'M': 2}}],
                   'reactions': [{'id': 'associate', 'reactants': {'A': 2}, 'products': {'D': 1}, 'rate_constant': .3},
                                 {'id': 'dissociate', 'reactants': {'D': 1}, 'products': {'A': 2}, 'rate_constant': .1}]}
        r = self.run_model('analyze_reaction_sensitivity', network=network, reaction_ids=['associate', 'dissociate'], target_species='D', duration_s=10)
        for j, rid in enumerate(['associate', 'dissociate']):
            curves = []
            for sign in [-1, 1]:
                perturbed = copy.deepcopy(network); perturbed['reactions'][j]['rate_constant'] *= math.exp(sign*1e-3)
                sample = self.run_model('simulate_pfr', network=perturbed, residence_time_s=10)
                curves.append(np.array([row['D_mol_l'] for row in sample['rows']]))
            np.testing.assert_allclose(r['sensitivities']['D'][rid], (curves[1]-curves[0])/.002, atol=8e-8, rtol=1e-5)

    def test_integrated_flux_reconstructs_species_and_branching(self):
        r = self.run_model('analyze_reaction_flux')
        for row in r['rows']:
            extent = 1-math.exp(-.16*row['time_s'])
            self.assertAlmostEqual(row['extent_A_to_B_mol_l'], .75*extent, delta=4e-9)
            self.assertAlmostEqual(row['extent_A_to_C_mol_l'], .25*extent, delta=4e-9)
            self.assertAlmostEqual(row['A_mol_l']+row['extent_A_to_B_mol_l']+row['extent_A_to_C_mol_l'], 1, delta=3e-9)

    def test_uncertainty_seed_quantiles_draws_and_zero_spread(self):
        kwargs = {'network': first_order(), 'reaction_ids': ['r'], 'target_species': 'A', 'samples': 16, 'points': 31}
        r = self.run_model('propagate_reaction_uncertainty', **kwargs)
        repeated = self.run_model('propagate_reaction_uncertainty', **kwargs)
        self.assertEqual(r['rate_samples'], repeated['rate_samples']); self.assertEqual(r['quantiles'], repeated['quantiles'])
        times = np.array(r['time_s'])
        analytic = np.array([np.exp(-draw['r']*times) for draw in r['rate_samples']])
        for key, q in [('q05', .05), ('q50', .5), ('q95', .95)]:
            np.testing.assert_allclose(r['quantiles']['A'][key], np.quantile(analytic, q, axis=0), atol=4e-9)
        zero = self.run_model('propagate_reaction_uncertainty', **kwargs, log_rate_sd=0)
        self.assertEqual(zero['quantiles']['A']['q05'], zero['quantiles']['A']['q95'])
        other = self.run_model('propagate_reaction_uncertainty', **kwargs, seed=7)
        self.assertNotEqual(r['rate_samples'], other['rate_samples'])

    def test_invalid_inputs_fail_instead_of_fabricating_results(self):
        cases = [('simulate_cstr', {'feed_mol_l': {'unknown': 1}}),
                 ('simulate_cstr', {'feed_mol_l': {}}), ('simulate_cstr', {'residence_time_s': 0}),
                 ('simulate_pfr', {'duration_s': 30}), ('simulate_reversible_chain', {'k_ab_s': 0}),
                 ('simulate_catalytic_cycle', {'inhibitor_mol_l': -1}),
                 ('analyze_reaction_sensitivity', {'reaction_ids': ['A_to_B', 'A_to_B']}),
                 ('analyze_reaction_sensitivity', {'target_species': 'missing'}),
                 ('propagate_reaction_uncertainty', {'seed': True}),
                 ('propagate_reaction_uncertainty', {'log_rate_sd': float('nan')}),
                 ('simulate_semibatch', {'feed_l_s': -1}), ('analyze_reaction_flux', {'unexpected': 1})]
        for name, changes in cases:
            response = science.execute({'operator': name, 'input': {**self.examples[name], **changes}})
            self.assertFalse(response['ok'], (name, changes))
            self.assertNotIn('result', response)
        zero_rate = {**self.examples['analyze_reaction_sensitivity'], 'network': first_order(k=0), 'reaction_ids': ['r'], 'target_species': 'A'}
        zero_rate.pop('example')
        self.assertFalse(science.execute({'operator': 'analyze_reaction_sensitivity', 'input': zero_rate})['ok'])


if __name__ == '__main__':
    run = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ReactionStudyTests))
    output = ROOT/'build/chem-reaction-qa'; output.mkdir(parents=True, exist_ok=True)
    (output/'numerical-acceptance.json').write_text(json.dumps({'passed': run.wasSuccessful(), 'tests': run.testsRun,
        'failures': len(run.failures), 'errors': len(run.errors), 'runtime': science.dependencies(), 'provenance': science.source_provenance()}, indent=2)+'\n')
    raise SystemExit(not run.wasSuccessful())
