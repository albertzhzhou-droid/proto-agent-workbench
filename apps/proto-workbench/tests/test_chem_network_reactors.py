"""Independent analytical, statistical and discretization tests for network reactors."""
import copy
import importlib.util
import json
import math
from pathlib import Path
import unittest
import numpy as np
from scipy.integrate import quad
from scipy.linalg import expm

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('network_reactor_worker', Path(__file__).resolve().parents[1]/'runtime/chem-integration/chem_science.py')
science = importlib.util.module_from_spec(spec); spec.loader.exec_module(science)
IDS = ['simulate_stochastic_network', 'simulate_axial_dispersion', 'analyze_tracer_rtd',
       'simulate_rtd_segregation', 'analyze_network_structure', 'scan_cstr_steady_states']
NA = 6.02214076e23


def network(k=.2, initial=1.):
    return {'species': [{'id': 'A', 'initial_concentration': initial, 'composition': {'M': 1}},
                        {'id': 'B', 'initial_concentration': 0., 'composition': {'M': 1}}],
            'reactions': [{'id': 'step', 'reactants': {'A': 1}, 'products': {'B': 1}, 'rate_constant': k}]}


def column(result, key):
    return np.array([row[key] for row in result['rows']])


class NetworkReactorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.examples = {op['id']: op['example_input'] for op in science.catalog()['operators'] if op['id'] in IDS}

    def request(self, key, **changes):
        data = {**copy.deepcopy(self.examples[key]), **changes}
        if 'network' in changes:
            data.pop('example', None)
        return science.execute({'operator': key, 'input': data})

    def run_model(self, key, **changes):
        result = self.request(key, **changes)
        self.assertTrue(result['ok'], result.get('error'))
        json.dumps(result, allow_nan=False)
        self.assertIn('chem_network_reactors.py', result['provenance']['source_files_sha256'])
        return result['result']

    def test_stochastic_reproducibility_and_integer_paths(self):
        first = self.run_model(IDS[0], replicates=5)
        second = self.run_model(IDS[0], replicates=5)
        self.assertEqual(first, second)
        for path in first['sampled_trajectories']:
            a, b = np.array(path['counts']['A']), np.array(path['counts']['B'])
            np.testing.assert_array_equal(a+b, 100)
            self.assertTrue(all(type(v) is int and v >= 0 for v in path['counts']['A']))
        different = self.run_model(IDS[0], replicates=5, seed=8)
        self.assertNotEqual(first['sampled_trajectories'], different['sampled_trajectories'])

    def test_stochastic_binomial_death_mean_and_variance(self):
        result = self.run_model(IDS[0], network=network(), replicates=128, duration_s=5, points=11)
        values = np.array([path['counts']['A'][-1] for path in result['sampled_trajectories']])
        p = math.exp(-1); mean = 100*p; variance = 100*p*(1-p)
        self.assertLess(abs(values.mean()-mean), 4*math.sqrt(variance/128))
        self.assertLess(abs(values.var()-variance), .4*variance)

    def test_stochastic_second_order_convention_and_low_count_limit(self):
        import chem_network_reactors as module
        p = {'k': np.array([.5]), 'orders': np.array([[2.], [0.]]), 'ids': ['A', 'B']}
        self.assertAlmostEqual(module._propensities(p, np.array([3, 0]), 10)[0], .3)
        self.assertEqual(module._propensities(p, np.array([1, 0]), 10)[0], 0)
        dimer = {'species': [{'id': 'A', 'initial_concentration': 1, 'composition': {'M': 1}},
                             {'id': 'B', 'initial_concentration': 0, 'composition': {'M': 2}}],
                 'reactions': [{'id': 'dimer', 'reactants': {'A': 2}, 'products': {'B': 1}, 'rate_constant': 1}]}
        result = self.run_model(IDS[0], network=dimer, volume_l=11/NA, replicates=4, duration_s=100)
        for path in result['sampled_trajectories']:
            np.testing.assert_array_equal(np.array(path['counts']['A'])+2*np.array(path['counts']['B']), 11)
            self.assertEqual(path['counts']['A'][-1], 1)

    def test_stochastic_absorbing_empty_state_and_explicit_failures(self):
        result = self.run_model(IDS[0], network=network(initial=0), replicates=1)
        self.assertEqual(result['diagnostics']['total_events'], 0)
        for changes, code in [({'volume_l': 100.4/NA}, 'INVALID_INPUT'), ({'max_events': 1}, 'STOCHASTIC_BUDGET')]:
            result = self.request(IDS[0], **changes)
            self.assertFalse(result['ok']); self.assertEqual(result['error']['code'], code)

    def test_axial_uniform_inert_limit_and_open_inventory(self):
        result = self.run_model(IDS[1], network=network(k=0), target_species='A', cells=12)
        np.testing.assert_allclose(column(result, 'A_outlet_mol_l'), 1, atol=1e-10)
        self.assertLess(result['diagnostics']['normalized_balance_error'], 1e-8)
        empty = self.run_model(IDS[1], network=network(k=0, initial=0), target_species='A', duration_s=60, cells=12)
        self.assertGreater(column(empty, 'A_outlet_mol_l')[-1], .95)
        self.assertLess(empty['diagnostics']['normalized_balance_error'], 1e-8)

    def test_axial_linear_transient_against_matrix_exponential(self):
        cells, tau, pe, k = 8, 4., 3., .2
        result = self.run_model(IDS[1], network=network(k, initial=0), target_species='A', cells=cells,
            residence_time_s=tau, peclet_number=pe, duration_s=8, points=9)
        # Independently assembled scalar A transport matrix and constant source.
        d, a = cells*cells/(tau*pe), cells/tau
        matrix = np.zeros((cells+1, cells+1))
        for i in range(cells):
            matrix[i, i] = -k-a-(d if i in (0, cells-1) else 2*d)
            if i > 0:
                matrix[i, i-1] = a+d
            if i < cells-1:
                matrix[i, i+1] = d
        matrix[0, -1] = a
        initial = np.r_[np.zeros(cells), 1.]
        expected = np.array([(expm(matrix*t) @ initial)[cells-1] for t in result['time_s']])
        np.testing.assert_allclose(column(result, 'A_outlet_mol_l'), expected, atol=3e-8)

    def test_axial_grid_convergence_to_continuum_boundary_solution(self):
        tau, pe, k = 10., 6., .2
        # Analytic steady solution: C=a exp(r+ z)+b exp(r- z), Danckwerts at 0, C'(1)=0.
        roots = np.array([(pe+math.sqrt(pe*pe+4*tau*pe*k))/2, (pe-math.sqrt(pe*pe+4*tau*pe*k))/2])
        coefficients = np.linalg.solve(np.array([1-roots/pe, roots*np.exp(roots)]), np.array([1., 0.]))
        expected = float(coefficients @ np.exp(roots)); errors = []
        for cells in (16, 32, 64):
            result = self.run_model(IDS[1], network=network(k), target_species='A', cells=cells,
                residence_time_s=tau, peclet_number=pe, duration_s=150, points=9)
            errors.append(abs(column(result, 'A_outlet_mol_l')[-1]-expected))
        self.assertLess(errors[1], errors[0]*.65); self.assertLess(errors[2], errors[1]*.65)
        self.assertLess(errors[-1], .008)

    def test_rtd_uniform_and_triangular_exact_moments_quantiles(self):
        uniform = self.run_model(IDS[2], time_s=[0, 1, 2], tracer_signal=[3, 3, 3])['diagnostics']
        self.assertAlmostEqual(uniform['mean_residence_time_s'], 1)
        self.assertAlmostEqual(uniform['variance_s2'], 1/3)
        self.assertAlmostEqual(uniform['t90_s'], 1.8)
        tri = self.run_model(IDS[2], time_s=[0, 1, 2], tracer_signal=[0, 1, 0])['diagnostics']
        self.assertAlmostEqual(tri['mean_residence_time_s'], 1)
        self.assertAlmostEqual(tri['variance_s2'], 1/6)
        self.assertAlmostEqual(tri['t10_s'], math.sqrt(.2))
        self.assertAlmostEqual(tri['t90_s'], 2-math.sqrt(.2))

    def test_rtd_baseline_scaling_and_retained_observations(self):
        base = self.run_model(IDS[2])
        changed = self.run_model(IDS[2], tracer_signal=[v*7+3 for v in self.examples[IDS[2]]['tracer_signal']], baseline=3)
        np.testing.assert_allclose(column(base, 'density_per_s'), column(changed, 'density_per_s'), atol=1e-15)
        self.assertEqual(changed['rows'][0]['raw_signal'], 3)
        self.assertEqual(changed['rows'][0]['corrected_signal'], 0)
        self.assertEqual(base['rows'][-1]['cumulative_fraction'], 1)

    def test_segregation_uniform_rtd_first_order_analytic(self):
        result = self.run_model(IDS[3], network=network(), time_s=[0, 5, 10], tracer_signal=[1, 1, 1])
        a = result['outlet_composition'][0]['outlet_mol_l']
        self.assertAlmostEqual(a, (1-math.exp(-2))/2, delta=2e-8)
        self.assertAlmostEqual(sum(row['outlet_mol_l'] for row in result['outlet_composition']), 1, delta=2e-8)
        self.assertEqual(result['axis_label'], 'Residence time')

    def test_segregation_triangular_rtd_and_nonlinear_kinetics(self):
        dimer = network()
        dimer['reactions'][0].update(reactants={'A': 2}, rate_constant=.2)
        dimer['species'][1]['composition'] = {'M': 2}
        result = self.run_model(IDS[3], network=dimer, time_s=[0, 5, 10], tracer_signal=[0, 1, 0])
        expected = quad(lambda t: (t/25 if t <= 5 else (10-t)/25)/(1+.4*t), 0, 10, points=[5])[0]
        self.assertAlmostEqual(result['outlet_composition'][0]['outlet_mol_l'], expected, delta=3e-8)

    def test_network_rank_cycles_and_basis_residuals(self):
        result = self.run_model(IDS[4], example='reversible')
        diag = result['diagnostics']
        self.assertEqual((diag['stoichiometric_rank'], diag['conservation_dimension'], diag['cycle_dimension']), (1, 1, 1))
        np.testing.assert_allclose(result['conservation_vectors'], [[1, 1]], atol=1e-12)
        np.testing.assert_allclose(result['cycle_vectors'], [[1, 1]], atol=1e-12)
        result = self.run_model(IDS[4], example='catalytic')
        self.assertEqual(result['diagnostics']['conservation_dimension'], 2)
        self.assertLess(result['diagnostics']['max_nullspace_residual'], 1e-12)

    def test_network_missing_composition_is_not_certified(self):
        net = network(); del net['species'][1]['composition']
        result = self.run_model(IDS[4], network=net)
        self.assertIsNone(result['diagnostics']['composition_balance_verified'])
        self.assertTrue(any('Incomplete' in warning for warning in result['warnings']))

    def test_cstr_first_order_branch_and_eigenvalues(self):
        result = self.run_model(IDS[5], network=network())
        for row in result['rows']:
            tau = row['residence_time_s']
            self.assertAlmostEqual(row['A_mol_l'], 1/(1+.2*tau), delta=1e-8)
            self.assertAlmostEqual(row['A_mol_l']+row['B_mol_l'], 1, delta=1e-8)
            self.assertAlmostEqual(row['spectral_abscissa_per_s'], -1/tau, delta=1e-10)
            self.assertEqual(row['local_stability'], 'stable')
        reverse = self.run_model(IDS[5], network=network(), residence_times_s=[40, 20, 10, 5, 2, 1])
        np.testing.assert_allclose(column(reverse, 'A_mol_l')[::-1], column(result, 'A_mol_l'), atol=1e-8)

    def test_cstr_nonlinear_branch_and_jacobian(self):
        net = network(); net['reactions'][0]['reactants'] = {'A': 2}; net['species'][1]['composition'] = {'M': 2}
        result = self.run_model(IDS[5], network=net)
        for row in result['rows']:
            tau = row['residence_time_s']; expected = 2/(1+math.sqrt(1+1.6*tau))
            self.assertAlmostEqual(row['A_mol_l'], expected, delta=1e-8)
        import chem_network_reactors as module
        p = module._prepare({'network': net}); c = np.array([.5, .25]); step = 1e-6
        numeric = np.column_stack([(p['stoich'] @ module.r._rates(p, c+np.eye(2)[i]*step)-p['stoich'] @ module.r._rates(p, c-np.eye(2)[i]*step))/(2*step) for i in range(2)])
        np.testing.assert_allclose(module._jacobian(p, c), numeric, atol=1e-10)

    def test_cstr_unstable_and_marginal_roots_are_labeled(self):
        net = network()
        net['reactions'] = [{'id': 'growth', 'reactants': {'A': 1, 'B': 1}, 'products': {'B': 2}, 'rate_constant': 2},
                            {'id': 'decay', 'reactants': {'B': 1}, 'products': {'A': 1}, 'rate_constant': .2}]
        result = self.run_model(IDS[5], network=net, residence_times_s=[1, 2])
        self.assertEqual(result['rows'][0]['local_stability'], 'unstable')
        self.assertAlmostEqual(result['rows'][0]['spectral_abscissa_per_s'], .8, delta=1e-7)
        net['reactions'][0]['rate_constant'] = 1.2
        result = self.run_model(IDS[5], network=net, residence_times_s=[1, 2])
        self.assertEqual(result['rows'][0]['local_stability'], 'marginal / unresolved')

    def test_invalid_domains_and_no_silent_partial_results(self):
        cases = [(IDS[2], {'time_s': [0, 1, 1], 'tracer_signal': [0, 1, 0]}),
                 (IDS[2], {'tracer_signal': [0]*10}), (IDS[2], {'baseline': .1}),
                 (IDS[2], {'time_s': [0, 1, 2]}), (IDS[1], {'peclet_number': 0}),
                 (IDS[1], {'target_species': 'missing'}), (IDS[0], {'seed': True}),
                 (IDS[5], {'residence_times_s': [1, 3, 2]}), (IDS[5], {'max_evaluations': 1})]
        for key, changes in cases:
            with self.subTest(key=key, changes=changes):
                result = self.request(key, **changes)
                self.assertFalse(result['ok']); self.assertNotIn('result', result)


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(NetworkReactorTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    out = ROOT/'build/chem-network-reactor-qa'; out.mkdir(parents=True, exist_ok=True)
    (out/'numerical-acceptance.json').write_text(json.dumps({'passed': result.wasSuccessful(), 'tests': result.testsRun,
        'failures': [str(test) for test, _ in result.failures], 'errors': [str(test) for test, _ in result.errors]}, indent=2)+'\n', encoding='utf-8')
    raise SystemExit(not result.wasSuccessful())
