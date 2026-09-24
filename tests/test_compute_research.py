"""Independent numerical and input-boundary cases for new biological methods."""
import copy
import math
import unittest
import contextlib
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from proto_agent import compute_research as research
from proto_agent.cli import main

class ResearchBiologyTests(unittest.TestCase):
    def test_cli_catalog_returns_json_without_falling_through(self):
        output=io.StringIO()
        with contextlib.redirect_stdout(output):
            status=main(['compute','catalog','--tool','analyze_qpcr_relative_expression'])
        self.assertEqual(status,0)
        self.assertEqual(json.loads(output.getvalue())['tools'][0]['id'],'analyze_qpcr_relative_expression')

    def test_cli_run_publishes_a_real_result_and_returns_success(self):
        directory=Path('build/test-compute-cli');directory.mkdir(parents=True,exist_ok=True)
        with TemporaryDirectory(dir=directory) as temp:
            path=Path(temp)/'request.json'
            path.write_text(json.dumps({'tool':'analyze_qpcr_relative_expression','arguments':research.TOOLS['analyze_qpcr_relative_expression']['example']}),encoding='utf-8')
            output=io.StringIO()
            with contextlib.redirect_stdout(output):status=main(['compute','run',path.resolve().relative_to(Path.cwd()).as_posix()])
            self.assertEqual(status,0)
            result=json.loads(output.getvalue());self.assertTrue(result['ok'])
            self.assertEqual(result['result']['rows'][1]['relative_expression'],4)
            self.assertTrue(Path(result['manifest_path']).is_file())

    def test_qpcr_technical_replicates_are_one_biological_sample(self):
        result=research.analyze_qpcr_relative_expression(copy.deepcopy(research.TOOLS['analyze_qpcr_relative_expression']['example']))
        self.assertAlmostEqual(result['rows'][1]['relative_expression'],4)
        self.assertEqual(result['groups'][1]['biological_samples'],1)
        self.assertIsNone(result['groups'][1]['sd_delta_ct'])
        self.assertEqual(result['rows'][1]['target_technical_replicates'],2)

    def test_count_normalization_known_values_and_library_sums(self):
        a={'gene_ids':['a','b'],'sample_ids':['s'],'counts':[[100],[100]],'lengths_bp':[1000,2000],'method':'tpm'}
        result=research.normalize_gene_expression_counts(a)
        self.assertAlmostEqual(result['rows'][0]['s'],2e6/3)
        self.assertAlmostEqual(result['libraries'][0]['normalized_sum'],1e6)
        a['method']='rpkm';result=research.normalize_gene_expression_counts(a)
        self.assertAlmostEqual(result['rows'][0]['s'],500000);self.assertAlmostEqual(result['rows'][1]['s'],250000)
        a['method']='cpm';del a['lengths_bp'];result=research.normalize_gene_expression_counts(a)
        self.assertAlmostEqual(result['rows'][0]['s'],500000)

    def test_diversity_known_distribution_and_empty_community(self):
        a=copy.deepcopy(research.TOOLS['analyze_ecological_diversity']['example']);a['samples'].append({'id':'empty','counts':[0,0,0]})
        result=research.analyze_ecological_diversity(a)
        row=result['rows'][0]
        self.assertAlmostEqual(row['shannon_nats'],math.log(2));self.assertAlmostEqual(row['simpson_diversity'],.5);self.assertAlmostEqual(row['pielou_evenness'],1)
        self.assertAlmostEqual(result['pairwise_distances'][0]['bray_curtis'],.5)
        self.assertIsNone(result['rows'][2]['shannon_nats']);self.assertIsNone(result['pairwise_distances'][1]['bray_curtis'])

    def test_protein_mass_extinction_and_monotonic_charge(self):
        result=research.analyze_protein_physicochemistry({'sequence':'GG','ph_values':[2,7,12]})
        self.assertAlmostEqual(result['molecular_weight_da'],2*75.0666-18.0153,places=3)
        self.assertEqual(result['extinction_reduced_m_inv_cm_inv'],0)
        charge=[r['estimated_charge'] for r in result['charge_profile']];self.assertGreater(charge[0],charge[1]);self.assertGreater(charge[1],charge[2])
        result=research.analyze_protein_physicochemistry({'sequence':'WYCC'})
        self.assertEqual(result['extinction_reduced_m_inv_cm_inv'],5500+1490)
        self.assertEqual(result['extinction_cystine_m_inv_cm_inv'],5500+1490+125)

    def test_dna_unknowns_half_open_windows_and_cpg(self):
        result=research.analyze_sequence_composition({'sequence':'ACGTN','window':3,'step':3})
        self.assertEqual(result['summary']['known_bases'],4);self.assertEqual(result['summary']['unknown_bases'],1)
        self.assertAlmostEqual(result['summary']['gc_fraction'],.5)
        self.assertEqual(result['summary']['valid_adjacent_pairs'],3)
        self.assertAlmostEqual(result['summary']['cpg_observed_expected'],16/3)
        self.assertEqual([(r['start_zero_based'],r['end_exclusive']) for r in result['windows']],[(0,3),(3,5)])
        self.assertIsNone(research.analyze_sequence_composition({'sequence':'NN'})['summary']['gc_fraction'])

    def test_invalid_and_ambiguous_inputs_fail(self):
        cases=[('analyze_qpcr_relative_expression','control_group','absent'),
          ('normalize_gene_expression_counts','counts',[[0,0],[0,0]]),('normalize_gene_expression_counts','counts',[[.5,1],[1,1]]),
          ('analyze_ecological_diversity','taxa',['duplicate','duplicate']),('analyze_protein_physicochemistry','sequence','ABZ'),
          ('analyze_sequence_composition','sequence','ACGR'),('analyze_sequence_composition','window',True)]
        for name,key,value in cases:
            with self.subTest(name=name,key=key):
                a=copy.deepcopy(research.TOOLS[name]['example']);a[key]=value
                with self.assertRaises(ValueError):research.HANDLERS[name](a)

if __name__=='__main__':unittest.main()
