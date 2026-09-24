"""Contract, file-input, and connector tests for the third Biomni port batch.

Covers the file-input extension of the compute contract, the self-contained
FCS reader and four flow-cytometry tools, structural tools (PDB Kabsch
comparison, chain liftover, prealigned NJ phylogeny, SBML writer), heavy
dependency tools (torch fine-mapping, Kalman decoding, image analysis,
cheminformatics, RNA folding), and the connector-gated remote subsystem
(disabled-by-default, host allowlist, program whitelist, DDInter data lake).
"""
from __future__ import annotations

import importlib
import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from proto_agent.compute import TOOLS as ALL_TOOLS, compute_catalog, run_compute
from proto_agent import remote_tools as rt

BATCH3_MODULES = ("compute_flowcyto", "compute_structures", "compute_ml", "compute_imaging", "compute_chem")
MODULES = {name: importlib.import_module(f"proto_agent.{name}") for name in BATCH3_MODULES}
COUNTS = {"compute_flowcyto": 4, "compute_structures": 4, "compute_ml": 2, "compute_imaging": 3, "compute_chem": 2}


def _synthetic_fcs(seed=7, events=4000):
    import random

    random.seed(seed)
    cfse = ([random.gauss(1000, 90) for _ in range(events // 3)]
            + [random.gauss(500, 45) for _ in range(events // 3)]
            + [random.gauss(250, 22) for _ in range(events - 2 * (events // 3))])
    channels = ["FSC-A", "SSC-A", "FITC-A", "CD3", "CD4", "IFN-G APC", "7-AAD PerCP"]
    columns = [ [random.gauss(65000, 8000) for _ in range(events)],
                [random.gauss(30000, 4000) for _ in range(events)],
                cfse,
                [3000.0] * events,
                [random.gauss(1500 if i % 2 == 0 else 400, 150) for i in range(events)],
                [random.gauss(800 if i % 8 == 0 else 200, 80) for i in range(events)],
                [random.gauss(900 if i % 10 == 0 else 150, 60) for i in range(events)] ]
    keywords = {"$DATATYPE": "F", "$BYTEORD": "4,3,2,1", "$NEXTDATA": "0", "$BEGINDATA": "000000", "$ENDDATA": "000000"}
    for index, name in enumerate(channels, start=1):
        keywords[f"$P{index}N"] = name
        keywords[f"$P{index}B"] = "32"
    data = bytearray()
    for row in zip(*columns):
        for value in row:
            data += struct.pack("<f", value)
    def build(kws):
        pairs = [item for pair in kws.items() for item in pair]
        return b"/" + b"/".join(value.encode("latin-1") for value in pairs) + b"/"
    text = build(keywords)
    begin, end = 256 + len(text), 256 + len(text) + len(data) - 1
    keywords["$BEGINDATA"], keywords["$ENDDATA"] = f"{begin:06d}", f"{end:06d}"
    text2 = build(keywords)
    header = bytearray(b"FCS3.1".ljust(10, b" "))
    header += f"{256:8d}".encode() + f"{256 + len(text2) - 1:8d}".encode() + f"{begin:8d}".encode() + f"{end:8d}".encode()
    header += b" " * (256 - len(header))
    return bytes(header) + text2 + bytes(data)


class Batch3ContractTests(unittest.TestCase):
    def test_registry_counts_and_file_input_declarations(self):
        self.assertEqual(compute_catalog()["count"], 127)
        file_tools = {identifier for identifier, metadata in ALL_TOOLS.items() if metadata.get("file_inputs")}
        self.assertGreaterEqual(len(file_tools), 9)
        for identifier, metadata in ALL_TOOLS.items():
            for declaration in metadata.get("file_inputs", {}).values():
                self.assertTrue(declaration["extensions"])
                self.assertGreater(declaration["max_bytes"], 0)

    def test_module_registries_match(self):
        for name, module in MODULES.items():
            self.assertEqual(set(module.TOOLS), set(module.HANDLERS), name)
            self.assertEqual(len(module.TOOLS), COUNTS[name], name)

    def test_every_catalog_example_validates(self):
        from proto_agent.compute import _validate
        for identifier in ALL_TOOLS:
            detail = compute_catalog(identifier)["tools"][0]
            _validate(json.loads(json.dumps(detail["example"])), detail["input_schema"])

    def test_file_inputs_are_path_contained_and_hashed(self):
        with tempfile.TemporaryDirectory() as workspace:
            root = Path(workspace)
            (root / "build/compute-inputs").mkdir(parents=True)
            (root / "build/compute-inputs/sample.fcs").write_bytes(_synthetic_fcs())
            (root / "outside.fcs").write_bytes(_synthetic_fcs())
            request = root / "request.json"
            request.write_text(json.dumps({"tool": "analyze_cfse_cell_proliferation",
                                           "arguments": {"fcs_path": "build/compute-inputs/sample.fcs"}}), encoding="utf-8")
            manifest = run_compute("request.json", workspace_root=root)
            self.assertGreater(manifest["result"]["division_index"], 0)
            self.assertIn("file:fcs_path", manifest["inputs"])
            request.write_text(json.dumps({"tool": "analyze_cfse_cell_proliferation",
                                           "arguments": {"fcs_path": "../outside.fcs"}}), encoding="utf-8")
            with self.assertRaises(ValueError):
                run_compute("request.json", workspace_root=root)


class FlowCytometryTests(unittest.TestCase):
    def test_parser_and_four_tools(self):
        fcs = _synthetic_fcs()
        flow = MODULES["compute_flowcyto"]
        parsed = flow._parse_fcs(fcs)
        self.assertEqual(parsed["events"], 4000)
        self.assertEqual(len(parsed["channels"]), 7)
        populations = flow.HANDLERS["analyze_flow_cytometry_immunophenotyping"](
            {"fcs_path": "x", "populations": [{"name": "cd3", "gates": [{"marker": "CD3", "operator": ">", "threshold": 1000}]}]},
            {"fcs_path": fcs})
        self.assertEqual(populations["populations"][0]["events"], 4000)
        proliferation = flow.HANDLERS["analyze_cfse_cell_proliferation"]({"fcs_path": "x"}, {"fcs_path": fcs})
        self.assertIn(len(proliferation["generation_counts"]), (3, 4))
        self.assertGreater(proliferation["percent_proliferating"], 60)
        cytokines = flow.HANDLERS["analyze_cytokine_production_in_cd4_tcells"]({"fcs_path": "x"}, {"fcs_path": fcs})
        self.assertTrue(20 < cytokines["frequencies_percent_of_cd4_positive"]["IFN-gamma"] < 30)
        senescence = flow.HANDLERS["analyze_cell_senescence_and_apoptosis"]({"fcs_path": "x"}, {"fcs_path": fcs})
        self.assertAlmostEqual(senescence["senescent_percent"], 20, delta=2)


class StructuresTests(unittest.TestCase):
    def test_phylogeny_clusters_identical_pair(self):
        result = MODULES["compute_structures"].HANDLERS["analyze_protein_phylogeny"](
            json.loads(json.dumps(MODULES["compute_structures"].TOOLS["analyze_protein_phylogeny"]["example"])))
        top = result["most_similar_pairs"][0]
        self.assertEqual(top["identity"], 1.0)
        self.assertEqual({top["a"], top["b"]}, {"kinase_human", "kinase_mouse"})
        self.assertTrue(result["newick_tree"].endswith(";"))

    def test_liftover_forward_reverse_and_gap(self):
        tool = MODULES["compute_structures"].HANDLERS["liftover_coordinates"]
        forward = tool({"chain_path": "x", "intervals": [{"chromosome": "chr1", "start": 150, "end": 250}]},
                       {"chain_path": b"chain 1000 chr1 3000 + 100 300 1 chr3 3000 + 500 700 9\n200 20 20\n"})
        self.assertEqual((forward["results"][0]["target_start"], forward["results"][0]["target_end"]), (550, 650))
        reverse = tool({"chain_path": "x", "intervals": [{"chromosome": "chr1", "start": 10050, "end": 10060}]},
                       {"chain_path": b"chain 49 chr1 3000000 + 10000 10100 1 chr2 3000000 - 5000 5100 2\n100 10 5\n"})
        self.assertEqual(reverse["results"][0]["target_start"], 3000000 - 5060)
        gap = tool({"chain_path": "x", "intervals": [{"chromosome": "chr1", "start": 290, "end": 320}]},
                   {"chain_path": b"chain 1000 chr1 3000 + 100 300 1 chr3 3000 + 500 700 9\n200 20 20\n"})
        self.assertFalse(gap["results"][0]["mapped"])

    def test_pdb_comparison_rmsd_and_region(self):
        def pdb(coordinates):
            return ("\n".join(f"ATOM  {i+1:5d}  CA  ALA A{i+1:4d}    {x:8.3f}{y:8.3f}{z:8.3f}  1.00  0.00           C"
                              for i, (x, y, z) in enumerate(coordinates)) + "\n").encode()
        coordinates = [(i * 3.8, 0, 0) for i in range(20)]
        shifted = [(x, y, z + (4.0 if 8 <= i < 12 else 0.0)) for i, (x, y, z) in enumerate(coordinates)]
        tool = MODULES["compute_structures"].HANDLERS["compare_protein_structures"]
        moved = tool({"structure_a_path": "a", "structure_b_path": "b"}, {"structure_a_path": pdb(coordinates), "structure_b_path": pdb(shifted)})
        self.assertGreater(moved["ca_rmsd_a"], 1.5)
        self.assertEqual(len(moved["conformational_regions"]), 1)
        same = tool({"structure_a_path": "a", "structure_b_path": "b"}, {"structure_a_path": pdb(coordinates), "structure_b_path": pdb(coordinates)})
        self.assertLess(same["ca_rmsd_a"], 1e-6)

    def test_sbml_writer_round_trips_through_libsbml(self):
        result = MODULES["compute_structures"].HANDLERS["create_biochemical_network_sbml_model"](
            json.loads(json.dumps(MODULES["compute_structures"].TOOLS["create_biochemical_network_sbml_model"]["example"])))
        import libsbml

        self.assertIsNotNone(libsbml.readSBMLFromString(result["sbml"]).getModel())


class HeavyDependencyTests(unittest.TestCase):
    def test_fine_mapping_is_seeded(self):
        example = json.loads(json.dumps(MODULES["compute_ml"].TOOLS["bayesian_finemapping_with_deep_vi"]["example"]))
        first = MODULES["compute_ml"].HANDLERS["bayesian_finemapping_with_deep_vi"](json.loads(json.dumps(example)))
        second = MODULES["compute_ml"].HANDLERS["bayesian_finemapping_with_deep_vi"](json.loads(json.dumps(example)))
        self.assertEqual(first["top_variants"], second["top_variants"])

    def test_kalman_decoding_reports_metrics(self):
        result = MODULES["compute_ml"].HANDLERS["decode_behavior_from_neural_trajectories"](
            json.loads(json.dumps(MODULES["compute_ml"].TOOLS["decode_behavior_from_neural_trajectories"]["example"])))
        self.assertGreater(result["explained_variance_percent"], 99)
        self.assertTrue(0 <= result["test_mse"] < 10)

    def test_image_tools_on_synthetic_fixtures(self):
        import cv2
        import numpy as np

        blot = np.full((120, 200), 255, np.uint8)
        blot[15:30, 20:60] = 40
        blot[60:75, 20:60] = 80
        ok, png = cv2.imencode(".png", blot)
        self.assertTrue(ok)
        blob = png.tobytes()
        distribution = MODULES["compute_imaging"].HANDLERS["analyze_pixel_distribution"]({"image_path": "x"}, {"image_path": blob})
        self.assertEqual(distribution["intensity_stats"]["max"], 255)
        densitometry = MODULES["compute_imaging"].HANDLERS["analyze_western_blot"](
            {"blot_image_path": "x", "loading_control_band": {"name": "actin", "roi": [20, 15, 40, 15]},
             "target_bands": [{"name": "t1", "roi": [20, 60, 40, 15]}]}, {"blot_image_path": blob})
        self.assertAlmostEqual(densitometry["targets"][0]["relative_expression"], 2.0, places=6)
        plate = np.full((300, 300), 210, np.uint8)
        yy, xx = np.mgrid[:300, :300]
        for x, y in [(40, 40), (120, 60), (200, 100), (80, 200), (220, 220), (160, 160)]:
            plate[(xx - x) ** 2 + (yy - y) ** 2 < 12 ** 2] = 30
        ok, plate_png = cv2.imencode(".png", plate)
        colonies = MODULES["compute_imaging"].HANDLERS["count_bacterial_colonies"](
            {"image_path": "x", "dilution_factor": 10, "plate_area_cm2": 25}, {"image_path": plate_png.tobytes()})
        self.assertEqual(colonies["colony_count"], 6)

    def test_cheminformatics_and_rna_folding(self):
        properties = MODULES["compute_chem"].HANDLERS["calculate_physicochemical_properties"]({"smiles": "CC(=O)Oc1ccccc1C(=O)O"})
        self.assertTrue(180 < properties["molecular_weight_g_per_mol"] < 181)
        folded = MODULES["compute_chem"].HANDLERS["predict_rna_secondary_structure"]({"sequence": "GGGAAACCCGUUUACGGCAUGU"})
        self.assertLess(folded["mfe_kcal_per_mol"], 0)
        self.assertGreater(folded["base_pair_count"], 0)


class RemoteConnectorTests(unittest.TestCase):
    def test_catalog_is_disabled_by_default_and_lists_upstream_sources(self):
        catalog = rt.remote_catalog()
        self.assertEqual(catalog["count"], 12)
        self.assertTrue(all(tool["connector_status"] == "disabled" for tool in catalog["tools"]))
        self.assertTrue(all(tool["upstream_functions"][0]["path"].startswith("biomni/tool/") for tool in catalog["tools"]))

    def test_remote_run_fails_closed_when_disabled(self):
        with self.assertRaises(rt.RemoteError) as raised:
            rt.remote_run({"tool": "fda_drug_label", "arguments": {"drug_name": "aspirin"}})
        self.assertEqual(raised.exception.code, "REMOTE_CONNECTOR_DISABLED")

    def test_host_allowlist_rejects_other_hosts(self):
        import io

        connectors = rt.load_connectors()
        enabled = {**connectors, "jaspar": {**connectors["jaspar"], "enabled": True}}
        with self.assertRaises(rt.RemoteError) as raised:
            rt._http_get("https://evil.example.com/api", enabled, "jaspar")
        self.assertEqual(raised.exception.code, "REMOTE_HOST_REJECTED")

        class FakeResponse(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *args): return False
        body = json.dumps({"results": [{"matrix_id": "MA0001.1"}]}).encode()
        with patch.object(rt.urllib.request, "urlopen", return_value=FakeResponse(body)):
            result = rt.remote_run.__call__ if False else rt.REMOTE_TOOLS
        # Direct handler check with a stubbed PFM fetch.
        pfm = b">MA0001.1\n1 2 3 4\n5 1 1 1\n1 5 1 1\n1 1 5 1\n"
        class FakeResponse2(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *args): return False
        with patch.object(rt.urllib.request, "urlopen", side_effect=[FakeResponse(body), FakeResponse2(pfm)]):
            scan = rt.jaspar_tfbs_scan({"tf_name": "NF-kB", "sequence": "ACGT" * 8}, enabled)
        self.assertEqual(scan["matrix_id"], "MA0001.1")

    def test_program_whitelist_and_execution(self):
        import os
        import stat

        connectors = rt.load_connectors()
        enabled = {**connectors, "muscle_exec": {**connectors["muscle_exec"], "enabled": True}}
        with self.assertRaises(rt.RemoteError) as raised:
            rt._run_program("macs2", ["--version"], enabled, "muscle_exec")
        self.assertEqual(raised.exception.code, "REMOTE_PROGRAM_REJECTED")
        with tempfile.TemporaryDirectory() as folder:
            fake = Path(folder) / "muscle.cmd"
            fake.write_text("@echo off\necho aligned-ok\n")
            os.chmod(fake, stat.S_IWRITE | stat.S_IREAD)
            previous = os.environ.get("PATH", "")
            os.environ["PATH"] = str(folder) + os.pathsep + previous
            try:
                output = rt._run_program("muscle", ["-in", "x.fasta"], enabled, "muscle_exec")
            finally:
                os.environ["PATH"] = previous
            self.assertEqual(output["returncode"], 0)
            self.assertIn("aligned-ok", output["stdout"])

    def test_ddinter_data_lake_combination_check(self):
        connectors = rt.load_connectors()
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "interaction_matrix.json").write_text(
                json.dumps({"druga": {"drubg": [{"level": "Major", "category": "alimentary_tract_metabolism"}]}}), encoding="utf-8")
            Path(folder, "name_mapping.json").write_text(json.dumps({"drug a": "druga", "drug b": "drubg"}), encoding="utf-8")
            enabled = {**connectors, "ddinter_datalake": {**connectors["ddinter_datalake"], "enabled": True, "datalake_root": folder}}
            result = rt.ddinter_check_combination({"drug_list": ["drug a", "drug b"]}, enabled)
        self.assertEqual(result["major_count"], 1)
        self.assertEqual(result["risk_level"], "High Risk")


if __name__ == "__main__":
    unittest.main()
