"""Independent closed-form expectations for local physical chemistry adapters."""
import copy
import importlib.util
import math
from pathlib import Path
import unittest

WORKER=Path(__file__).resolve().parents[1]/'runtime/chem-integration/chem_science.py'
spec=importlib.util.spec_from_file_location('physical_worker',WORKER)
science=importlib.util.module_from_spec(spec);spec.loader.exec_module(science)

class PhysicalChemistryTests(unittest.TestCase):
    def run_tool(self,name,data):
        receipt=science.execute({'operator':name,'input':data})
        self.assertTrue(receipt['ok'],receipt.get('error'))
        self.assertIn('chem_physical.py',receipt['provenance']['source_files_sha256'])
        return receipt['result']

    def test_langmuir_and_freundlich_recover_known_parameters(self):
        concentrations=[0,.1,.3,1,3,10,30]
        for model in ['langmuir','freundlich']:
            loadings=[12*.8*c/(1+.8*c) if model=='langmuir' else 2.4*c**.7 for c in concentrations]
            result=self.run_tool('fit_adsorption_isotherm',{'concentrations':concentrations,'loadings':loadings,'concentration_unit':'mmol/L','loading_unit':'mmol/g','model':model})
            fitted={p['parameter']:p['value'] for p in result['coefficients']}
            expected={'q_max':12,'K':.8} if model=='langmuir' else {'K_F':2.4,'n':.7}
            for key,value in expected.items():self.assertAlmostEqual(fitted[key],value,places=7)
            self.assertLess(result['diagnostics']['rmse'],1e-8)

    def test_vanthoff_known_enthalpy_entropy_and_constant_equilibrium(self):
        temperatures=[275,290,310,340]
        for enthalpy,entropy in [(20000,80),(0,0)]:
            result=self.run_tool('analyze_vanthoff_equilibrium',{'temperatures_k':temperatures,'equilibrium_constants':[math.exp(-enthalpy/(8.31446261815324*t)+entropy/8.31446261815324) for t in temperatures]})
            self.assertAlmostEqual(result['delta_h_j_mol'],enthalpy,places=6)
            self.assertAlmostEqual(result['delta_s_j_mol_k'],entropy,places=6)

    def test_acid_base_half_equivalence_and_fraction_conservation(self):
        result=self.run_tool('calculate_acid_base_speciation',{'pka_values':[4.76],'ph_values':[4.76],'fully_protonated_charge':0})
        row=result['rows'][0]
        self.assertAlmostEqual(row['alpha_0'],.5);self.assertAlmostEqual(row['alpha_1'],.5);self.assertAlmostEqual(row['mean_charge'],-.5)
        result=self.run_tool('calculate_acid_base_speciation',{'pka_values':[2,7,12],'ph_values':[-10,2,7,12,30],'fully_protonated_charge':1})
        for row in result['rows']:self.assertAlmostEqual(row['fraction_sum'],1,places=13)
        self.assertAlmostEqual(result['rows'][0]['mean_charge'],1,places=9)
        self.assertAlmostEqual(result['rows'][-1]['mean_charge'],-2,places=9)

    def test_complex_impedance_unit_conversion_for_both_weights(self):
        f=[.03,.1,.3,1,3,10,30,100,300,1000]
        z=[7+120/(1+2j*math.pi*hz*120*.0002) for hz in f]
        for weighting in ['uniform','modulus']:
            result=self.run_tool('fit_electrochemical_impedance',{'frequencies_hz':f,'z_real_ohm':[x.real for x in z],'z_imag_ohm':[x.imag for x in z],'weighting':weighting})
            self.assertAlmostEqual(result['r_series_ohm'],7,places=6)
            self.assertAlmostEqual(result['r_transfer_ohm'],120,places=6)
            self.assertAlmostEqual(result['capacitance_f'],.0002,places=11)
            self.assertLess(result['diagnostics']['complex_rmse_ohm'],1e-7)

    def test_invalid_dimensions_units_and_model_inputs_fail(self):
        catalog={t['id']:t['example_input'] for t in science.catalog()['operators']}
        cases=[('fit_adsorption_isotherm','loadings',[1]*6),('fit_adsorption_isotherm','concentration_unit',''),
          ('analyze_vanthoff_equilibrium','temperatures_k',[0,290,300,310,320]),
          ('calculate_acid_base_speciation','pka_values',[7,2]),('calculate_acid_base_speciation','ph_values',[float('nan')]),
          ('fit_electrochemical_impedance','frequencies_hz',[1]*6),('fit_electrochemical_impedance','z_imag_ohm',[-1,-2])]
        for name,key,value in cases:
            with self.subTest(name=name,key=key):
                data=copy.deepcopy(catalog[name]);data[key]=value
                self.assertFalse(science.execute({'operator':name,'input':data})['ok'])

if __name__=='__main__':unittest.main()
