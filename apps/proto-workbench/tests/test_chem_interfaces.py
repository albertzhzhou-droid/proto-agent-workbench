"""Analytic limits and independent conservation checks for interface models."""
import importlib.util
import json
import math
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]
WORKER = Path(__file__).resolve().parents[1] / 'runtime/chem-integration/chem_science.py'
spec = importlib.util.spec_from_file_location('interfaces_worker', WORKER)
science = importlib.util.module_from_spec(spec)
spec.loader.exec_module(science)


class InterfaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.examples = {op['id']: op['example_input'] for op in science.catalog()['operators'] if op['category'] == 'interfaces'}

    def run_model(self, name, **changes):
        response = science.execute({'operator': name, 'input': {**self.examples[name], **changes}})
        self.assertTrue(response['ok'], response.get('error'))
        self.assertIn('chem_interfaces.py', response['provenance']['source_files_sha256'])
        json.dumps(response, allow_nan=False)
        return response['result']

    def test_single_adsorbate_closed_form_transient(self):
        result = self.run_model('simulate_competitive_adsorption', activity_b=0, initial_coverage_a=.2)
        for row in result['rows']:
            expected = .4/.48 + (.2-.4/.48)*math.exp(-.48*row['time_s'])
            self.assertAlmostEqual(row['A_adsorbed'], expected, delta=2e-8)
            self.assertEqual(row['B_adsorbed'], 0)

    def test_competitive_equilibrium_and_site_sum(self):
        result = self.run_model('simulate_competitive_adsorption', duration_s=300)
        row = result['rows'][-1]
        self.assertAlmostEqual(row['A_adsorbed'], 5/7.5, places=7)
        self.assertAlmostEqual(row['B_adsorbed'], 1.5/7.5, places=7)
        for row in result['rows']:
            self.assertAlmostEqual(row['A_adsorbed']+row['B_adsorbed']+row['vacant'], 1, places=12)
            self.assertGreaterEqual(min(row['A_adsorbed'],row['B_adsorbed'],row['vacant']), -1e-10)

    def test_eley_rideal_analytic_coverage_and_product_integral(self):
        result = self.run_model('simulate_eley_rideal', initial_coverage_a=.3)
        rate = .4+.08+.5*.6
        equilibrium = .4/rate
        for row in result['rows']:
            t = row['time_s']
            coverage = equilibrium+(.3-equilibrium)*math.exp(-rate*t)
            product = 2e-5*.5*.6*(equilibrium*t+(.3-equilibrium)*(1-math.exp(-rate*t))/rate)
            self.assertAlmostEqual(row['A_adsorbed'],coverage,delta=2e-8)
            self.assertAlmostEqual(row['product_mol_m2'],product,delta=1e-11)

    def test_hinshelwood_closed_batch_stoichiometry(self):
        # No adsorption/desorption: A*=B* initially, theta=theta0/(1+k theta0 t).
        result = self.run_model('simulate_langmuir_hinshelwood', initial_coverage_a=.4,
            initial_coverage_b=.4, k_ads_a_s=0, k_ads_b_s=0, k_des_a_s=0, k_des_b_s=0)
        for row in result['rows']:
            expected = .4/(1+.5*.4*row['time_s'])
            self.assertAlmostEqual(row['A_adsorbed'],expected,delta=3e-8)
            self.assertAlmostEqual(row['B_adsorbed'],expected,delta=3e-8)
            self.assertAlmostEqual(row['product_mol_m2']/2e-5+row['A_adsorbed'],.4,places=9)

    def test_electrode_pure_rc_and_both_polarities(self):
        for step in [-.1,.1]:
            result = self.run_model('simulate_electrode_step', exchange_current_a_m2=0, applied_overpotential_v=step)
            for row in result['rows']:
                eta = step*(1-math.exp(-row['time_s']/.2))
                self.assertAlmostEqual(row['overpotential_v'],eta,delta=3e-9)
                self.assertAlmostEqual(row['total_charge_c_m2'],2*eta,delta=1e-8)
                self.assertEqual(row['faradaic_current_a_m2'],0)

    def test_butler_volmer_steady_root_and_charge_balance(self):
        from scipy.optimize import brentq
        expected = brentq(lambda eta:(.1-eta)/.1-math.sinh(96485.33212*eta/(2*8.31446261815324*298.15)),0,.1)
        result = self.run_model('simulate_electrode_step', duration_s=10)
        self.assertAlmostEqual(result['rows'][-1]['overpotential_v'],expected,places=8)
        self.assertLess(result['diagnostics']['maximum_charge_balance_error_c_m2'],1e-8)
        equilibrium = self.run_model('simulate_electrode_step', applied_overpotential_v=0)
        self.assertTrue(all(row['total_current_a_m2']==0 for row in equilibrium['rows']))

    def test_diffusion_steady_linear_profile_and_mass_conservation(self):
        result = self.run_model('simulate_diffusion_film', duration_s=300)
        for x, observed in zip(result['profiles']['distance_m'],result['profiles']['concentration_mol_m3'][-1]):
            self.assertAlmostEqual(observed,1/6+(5/6)*x/1e-4,delta=2e-8)
        self.assertAlmostEqual(result['rows'][-1]['surface_flux_mol_m2_s'],5e-5/6,delta=1e-12)
        self.assertLess(result['diagnostics']['maximum_relative_mass_balance_error'],1e-8)

    def test_diffusion_no_reaction_and_mesh_convergence(self):
        zero = self.run_model('simulate_diffusion_film', surface_rate_m_s=0)
        self.assertTrue(all(abs(row['surface_concentration_mol_m3']-1)<1e-10 and row['surface_flux_mol_m2_s']==0 for row in zero['rows']))
        results = [self.run_model('simulate_diffusion_film',cells=cells,duration_s=3) for cells in [10,20,40,80]]
        fluxes = [result['rows'][-1]['surface_flux_mol_m2_s'] for result in results]
        self.assertLess(abs(fluxes[2]-fluxes[3]),abs(fluxes[0]-fluxes[1])/3)
        self.assertLess(abs(fluxes[2]/fluxes[3]-1),.002)

    def test_input_failures_never_yield_successful_trajectories(self):
        cases=[('simulate_competitive_adsorption',{'initial_coverage_a':.8,'initial_coverage_b':.8}),
               ('simulate_competitive_adsorption',{'activity_a':True}),
               ('simulate_eley_rideal',{'k_ads_b_s':1}),
               ('simulate_electrode_step',{'capacitance_f_m2':0}),
               ('simulate_diffusion_film',{'cells':8.5}),
               ('simulate_diffusion_film',{'bulk_concentration_mol_m3':0}),
               ('simulate_diffusion_film',{'surface_rate_m_s':float('nan')})]
        for name,change in cases:
            response=science.execute({'operator':name,'input':{**self.examples[name],**change}})
            self.assertFalse(response['ok'],(name,change));self.assertNotIn('result',response)
        self.assertFalse(science.execute({'operator':'simulate_electrode_step','input':{}})['ok'])


if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(InterfaceTests))
    path=ROOT/'build/chem-interface-qa/numerical-acceptance.json'
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps({'passed':result.wasSuccessful(),'tests':result.testsRun,'failures':len(result.failures),
        'errors':len(result.errors),'runtime':science.dependencies(),'provenance':science.source_provenance()},indent=2),encoding='utf-8')
    raise SystemExit(not result.wasSuccessful())
