from __future__ import annotations

import hashlib
import unittest
from unittest.mock import patch

from proto_agent.materials import MaterialsError, PROMOTION_ROUND_IDS
from proto_agent.materials_promotion import audit_promotion_candidates


def candidate(resource_id: str = "fixture:promoter/a", sequence: str = "TTGACATATAAT") -> dict:
    sequence_sha256 = hashlib.sha256(sequence.encode("ascii")).hexdigest()
    return {
        "resource_id": resource_id,
        "kind": "genetic_part",
        "name": "Reviewed promoter fixture",
        "aliases": ["fixture promoter"],
        "description_en": "A deterministic software catalog fixture.",
        "description_zh": "确定性软件目录测试记录。",
        "chassis": ["ecoli_k12"],
        "role_terms": ["Promoter"],
        "part_type": "promoter",
        "sequence": sequence,
        "sequence_sha256": sequence_sha256,
        "sequence_kind": "DNA",
        "source": {
            "provider": "fixture",
            "record_id": resource_id,
            "revision": "fixture-1",
            "release": "fixture-1",
            "url": f"https://example.invalid/records/{resource_id.rsplit('/', 1)[-1]}",
            "retrieved_at": "2026-09-01T00:00:00Z",
            "content_sha256": "1" * 64,
            "sequence_sha256": sequence_sha256,
        },
        "license": {
            "id": "CC0-1.0",
            "url": "https://creativecommons.org/publicdomain/zero/1.0/",
            "attribution": "Fixture author",
            "rights_notes": "Fixture rights are explicit for deterministic tests.",
            "redistribution_status": "REDISTRIBUTABLE",
        },
        "evidence_refs": [
            "https://example.invalid/evidence/record",
            "https://creativecommons.org/publicdomain/zero/1.0/",
        ],
        "review_status": "DESIGN_ELIGIBLE",
        "safety_status": "NO_FLAG",
        "design_eligibility": True,
        "metadata": {
            "role_accession": "SO:0000167",
            "registry_status": "published",
            "chassis_basis": "human_review_software_annotation",
        },
    }


class MaterialsPromotionAuditTests(unittest.TestCase):
    def test_three_round_audit_passes_a_complete_candidate(self) -> None:
        report = audit_promotion_candidates([candidate()], generated_at="2026-09-01T00:00:00Z")
        self.assertEqual(report["candidate_count"], 1)
        self.assertEqual(report["pass_count"], 1)
        self.assertEqual(report["fail_count"], 0)
        decision = report["candidates"][0]
        self.assertEqual(decision["decision"], "PASS")
        self.assertEqual([item["round_id"] for item in decision["rounds"]], list(PROMOTION_ROUND_IDS))
        self.assertTrue(all(item["status"] == "PASS" for item in decision["rounds"]))
        self.assertIn("CATALOG_ELIGIBILITY_ROUNDTRIP_VERIFIED", decision["rounds"][2]["reason_codes"])
        self.assertIn("MATERIALIZATION_ROUNDTRIP_VERIFIED", decision["rounds"][2]["reason_codes"])
        self.assertNotIn("MODEL_VISIBILITY_GATE_VERIFIED", decision["rounds"][2]["reason_codes"])

    def test_rights_failure_is_machine_readable(self) -> None:
        record = candidate()
        record["license"]["rights_notes"] = ""
        report = audit_promotion_candidates([record], generated_at="2026-09-01T00:00:00Z")
        decision = report["candidates"][0]
        self.assertEqual(decision["decision"], "FAIL")
        self.assertIn("LICENSE_RIGHTS_NOTES_MISSING", decision["rounds"][0]["reason_codes"])

    def test_non_fixture_candidate_requires_locked_source_evidence(self) -> None:
        record = candidate()
        record["source"].update(
            {
                "provider": "iGEM Registry",
                "record_id": "83c27e59-1d6f-4fe4-9f61-7b44034025b9",
                "url": "https://api.registry.igem.org/v1/parts/83c27e59-1d6f-4fe4-9f61-7b44034025b9",
            }
        )
        record["license"].update(
            {
                "id": "CC-BY-4.0",
                "url": "https://creativecommons.org/licenses/by/4.0/legalcode",
            }
        )
        report = audit_promotion_candidates([record], generated_at="2026-09-01T00:00:00Z")
        self.assertIn("SOURCE_EVIDENCE_MISSING", report["candidates"][0]["rounds"][0]["reason_codes"])

    def test_explicit_no_flag_cannot_mask_derived_hard_flag(self) -> None:
        record = candidate()
        record["description_en"] = "A toxin fixture that must remain isolated."
        report = audit_promotion_candidates([record], generated_at="2026-09-01T00:00:00Z")
        decision = report["candidates"][0]
        self.assertEqual(decision["rounds"][1]["status"], "FAIL")
        self.assertIn("DERIVED_SAFETY_HARD_FLAG", decision["rounds"][1]["reason_codes"])

    def test_duplicate_sequences_fail_round_three_for_every_candidate(self) -> None:
        records = [candidate("fixture:promoter/a"), candidate("fixture:promoter/b")]
        report = audit_promotion_candidates(records, generated_at="2026-09-01T00:00:00Z")
        self.assertEqual(report["pass_count"], 0)
        self.assertEqual(report["fail_count"], 2)
        for decision in report["candidates"]:
            self.assertIn("DUPLICATE_SEQUENCE", decision["rounds"][2]["reason_codes"])

    def test_report_is_deterministic_for_locked_inputs(self) -> None:
        first = audit_promotion_candidates([candidate()], generated_at="2026-09-01T00:00:00Z")
        second = audit_promotion_candidates([candidate()], generated_at="2026-09-01T00:00:00Z")
        self.assertEqual(first, second)

    def test_materialization_failure_fails_round_three(self) -> None:
        with patch(
            "proto_agent.materials_promotion.MaterialsStore.materialize_parts",
            side_effect=MaterialsError("TEST_FAILURE", "forced materialization failure"),
        ):
            report = audit_promotion_candidates([candidate()], generated_at="2026-09-01T00:00:00Z")
        decision = report["candidates"][0]
        self.assertEqual(decision["decision"], "FAIL")
        self.assertIn("MATERIALIZATION_ROUNDTRIP_FAILED", decision["rounds"][2]["reason_codes"])

    def test_roundtrip_never_activates_the_ephemeral_snapshot(self) -> None:
        with patch(
            "proto_agent.materials_promotion.MaterialsStore.activate",
            side_effect=AssertionError("promotion audit must not activate a snapshot"),
        ) as activate:
            report = audit_promotion_candidates([candidate()], generated_at="2026-09-01T00:00:00Z")
        self.assertEqual(report["pass_count"], 1)
        activate.assert_not_called()

    def test_audit_candidate_count_is_bounded(self) -> None:
        with self.assertRaisesRegex(ValueError, "limited to 1000"):
            audit_promotion_candidates(
                [candidate() for _ in range(1001)],
                generated_at="2026-09-01T00:00:00Z",
            )


if __name__ == "__main__":
    unittest.main()
