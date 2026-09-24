"""Contract and analytic tests for the fourth Biomni port batch.

Covers the popgen/genetics module (msprime, Cas9/CRISPR alignment, DDR
network), the medical registration suite (geometry-centered SimpleITK), and
the histology/microscopy module (frame tracking, FFT ciliary frequency,
watershed multiplex quantification, ROI detection) against synthetic
fixtures, plus the registry wiring for all one hundred nineteen tools.
"""
from __future__ import annotations

import io
import json
import unittest
import warnings

warnings.filterwarnings("ignore")

from proto_agent.compute import TOOLS as ALL_TOOLS, compute_catalog
from proto_agent import compute_histology, compute_medical, compute_popgen

import cv2
import numpy as np
import tifffile


def png(image):
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    return encoded.tobytes()


def tif(image):
    buffer = io.BytesIO()
    tifffile.imwrite(buffer, image)
    return buffer.getvalue()


def nifti(array):
    import nibabel as nib
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "v.nii.gz"
        nib.save(nib.Nifti1Image(array.astype(np.float32), np.eye(4)), str(path))
        return path.read_bytes()


class Batch4ContractTests(unittest.TestCase):
    def test_registry_includes_research_biology_companions(self):
        catalog = compute_catalog()
        self.assertEqual(catalog["count"], 127)
        self.assertEqual(len({tool["id"] for tool in catalog["tools"]}), 127)
        for module in (compute_popgen, compute_medical, compute_histology):
            self.assertEqual(set(module.TOOLS), set(module.HANDLERS))

    def test_every_catalog_example_validates(self):
        from proto_agent.compute import _validate

        for identifier in ALL_TOOLS:
            detail = compute_catalog(identifier)["tools"][0]
            _validate(json.loads(json.dumps(detail["example"])), detail["input_schema"])

    def test_list_file_inputs_declare_maxima(self):
        lists = [(identifier, field, declaration)
                 for identifier, metadata in ALL_TOOLS.items()
                 for field, declaration in metadata.get("file_inputs", {}).items()
                 if declaration.get("list")]
        self.assertGreaterEqual(len(lists), 6)
        for _identifier, _field, declaration in lists:
            self.assertGreaterEqual(declaration["max_files"], 2)


class PopgenTests(unittest.TestCase):
    def test_cas9_alignment_categorizes_outcomes(self):
        reference = "ACGTACGTGGGACGTACGTACGTACGTCACGT"
        example = {"target_sites": [{"reference": reference, "reads": [
            reference, reference[:20] + reference[24:], reference[:20] + "TTTT" + reference[20:], reference[:18] + reference[27:]]}]}
        result = compute_popgen.HANDLERS["analyze_cas9_mutation_outcomes"](example)
        counts = result["mutation_counts"]
        self.assertEqual((counts["no_mutation"], counts["short_deletion"], counts["longer_insertion"]), (1, 2, 1))
        self.assertEqual([row["deleted_bases"] for row in result["reads_detail"][1:]], [4, 0, 9])

    def test_crispr_editing_finds_on_target_substitution(self):
        original = "TTTACGTACGTGGGACGTACGTACGTACGTACGTCCC"
        result = compute_popgen.HANDLERS["analyze_crispr_genome_editing"]({
            "original_sequence": original, "edited_sequence": original[:13] + "T" + original[14:],
            "guide_rna": "ACGTACGTGGGACGTACGTA", "repair_template": original})
        self.assertTrue(result["guide_found"])
        self.assertEqual(result["substitution_count"], 1)
        self.assertEqual(len(result["on_target_edits"]), 1)

    def test_ddr_network_identifies_mutated_hub(self):
        example = json.loads(json.dumps(compute_popgen.TOOLS["analyze_ddr_network_in_cancer"]["example"]))
        result = compute_popgen.HANDLERS["analyze_ddr_network_in_cancer"](example)
        self.assertEqual(result["ddr_genes_found"], 5)
        self.assertIn(result["top_mutated"][0]["gene"], ("ATM", "TP53"))
        self.assertEqual(result["top_mutated"][0]["frequency"], 0.75)

    def test_demographic_simulation_runs_seeded(self):
        first = compute_popgen.HANDLERS["simulate_demographic_history"](
            {"num_samples": 6, "sequence_length": 40000, "mutation_rate": 1e-7, "random_seed": 3})
        second = compute_popgen.HANDLERS["simulate_demographic_history"](
            {"num_samples": 6, "sequence_length": 40000, "mutation_rate": 1e-7, "random_seed": 3})
        self.assertEqual(first["segregating_sites"], second["segregating_sites"])
        self.assertGreater(first["segregating_sites"], 0)


class MedicalTests(unittest.TestCase):
    def test_rigid_registration_reduces_displacement(self):
        x, y, z = np.mgrid[0:24, 0:24, 0:24]
        reference = np.exp(-((x - 12) ** 2 + (y - 12) ** 2 + (z - 12) ** 2) / 40.0)
        moving = np.exp(-((x - 14) ** 2 + (y - 12) ** 2 + (z - 12) ** 2) / 40.0)
        result = compute_medical.HANDLERS["quick_rigid_registration"](
            {"number_of_iterations": 40},
            {"fixed_image_path": nifti(reference), "moving_image_path": nifti(moving)})
        self.assertGreater(result["metrics_after"]["correlation"], 0.99)

    def test_adc_map_recovers_known_diffusivity(self):
        reference = np.exp(-((np.mgrid[0:24, 0:24, 0:24][0] - 12) ** 2 + (np.mgrid[0:24, 0:24, 0:24][1] - 12) ** 2) / 40)
        roi = np.where(reference[8:16, 8:16, 8:14] > 0.3, 1.0, 0.05)
        dwi = np.zeros((8, 8, 6, 2))
        dwi[..., 0] = 5000.0 * roi
        dwi[..., 1] = dwi[..., 0] * np.exp(-1000.0 * 0.0009)
        result = compute_medical.HANDLERS["calculate_brain_adc_map"]({"b_values": [0, 1000]}, {"dwi_path": nifti(dwi)})
        mean = result["adc_stats_mm2_per_s"]["mean"]
        self.assertLess(abs(mean - 0.0009) / 0.0009, 0.05)

    def test_modality_split_reports_four_channels(self):
        volume = np.zeros((8, 8, 8, 4), np.float32)
        volume[..., 1] = 1.0
        result = compute_medical.HANDLERS["split_modalities"]({}, {"mri_path": nifti(volume)})
        self.assertEqual([entry["modality"] for entry in result["modalities"]], ["FLAIR", "T1w", "t1gd", "T2w"])


class HistologyTests(unittest.TestCase):
    def test_migration_track_displacement(self):
        import math

        frames = []
        for step in range(6):
            frame = np.zeros((100, 100), np.uint8)
            cv2.circle(frame, (20 + 4 * step, 20), 6, 255, -1)
            frames.append(png(frame))
        result = compute_histology.HANDLERS["analyze_cell_migration_metrics"](
            {"pixel_size_um": 0.5, "time_interval_min": 2.0, "min_track_length": 4}, {"frame_paths": frames})
        self.assertAlmostEqual(result["tracks"][0]["net_displacement"], math.hypot(20, 0) * 0.5, places=6)
        self.assertAlmostEqual(result["tracks"][0]["directionality"], 1.0, places=6)

    def test_ciliary_frequency_at_exact_fft_bin(self):
        frames = []
        for t in range(48):
            frame = np.full((80, 80), 50, np.uint8)
            cv2.rectangle(frame, (30, 30), (50, 50), int(50 + 100 * (0.5 + 0.5 * np.sin(2 * np.pi * 8 * t / 96.0))), -1)
            frames.append(png(frame))
        result = compute_histology.HANDLERS["analyze_ciliary_beat_frequency"](
            {"fps": 96.0, "roi_count": 4}, {"frame_paths": frames})
        self.assertGreaterEqual(result["valid_rois"], 1)
        self.assertLess(abs(result["median_beat_frequency_hz"] - 8.0), 1.0)

    def test_multiplex_quantifies_cd3_positive_cells(self):
        dapi = np.zeros((100, 140), np.uint8)
        cd3 = np.zeros((100, 140), np.uint8)
        for i in range(6):
            cv2.circle(dapi, (20 + 20 * i, 50), 6, 255, -1)
            if i % 2 == 0:
                cv2.circle(cd3, (20 + 20 * i, 50), 9, 200, -1)
        result = compute_histology.HANDLERS["segment_and_quantify_cells_in_multiplexed_images"](
            {"markers_list": ["DAPI", "CD3"], "nuclear_channel_index": 0},
            {"image_path": tif(np.stack([dapi, cd3], axis=-1))})
        self.assertEqual(result["nuclei_count"], 6)
        self.assertEqual(sum(1 for cell in result["cells"] if cell["CD3"] and cell["CD3"] > 0), 3)

    def test_find_roi_detects_three_bands(self):
        image = np.full((260, 200), 240, np.uint8)
        for y in (30, 110, 190):
            cv2.rectangle(image, (30, y), (170, y + 60), 160, -1)
        result = compute_histology.HANDLERS["find_roi_from_image"](
            {"lower_threshold": 0, "upper_threshold": 170, "min_contour_area": 100}, {"image_path": png(image)})
        self.assertEqual(len(result["rois"]), 3)

    def test_colocalization_extremes(self):
        channel = np.zeros((60, 60), np.uint8)
        cv2.circle(channel, (30, 30), 12, 220, -1)
        independent = np.zeros((60, 60), np.uint8)
        cv2.circle(independent, (10, 10), 8, 220, -1)
        same = compute_histology.HANDLERS["analyze_protein_colocalization"](
            {}, {"channel1_path": png(channel), "channel2_path": png(channel)})
        self.assertGreater(same["pearson_whole_image"], 0.9)
        disjoint = compute_histology.HANDLERS["analyze_protein_colocalization"](
            {}, {"channel1_path": png(channel), "channel2_path": png(independent)})
        self.assertLess(disjoint["pearson_whole_image"], 0.2)

    def test_thrombus_components_sum_to_hundred(self):
        image = np.full((100, 150, 3), 220, np.uint8)
        image[10:50, 10:70] = (80, 40, 60)
        image[10:50, 80:140] = (120, 110, 90)
        result = compute_histology.HANDLERS["analyze_thrombus_histology"]({}, {"image_path": png(image)})
        total = sum(result[key] for key in ("fresh_percent", "cellular_lysis_percent", "endothelialization_percent", "fibroblastic_percent"))
        self.assertLess(abs(total - 100.0), 5.0)


if __name__ == "__main__":
    unittest.main()
