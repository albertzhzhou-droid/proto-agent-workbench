from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import proto_agent.security as security_module
from proto_agent.security import SecurityBoundaryError
from tools import crawl_igem_parts as crawler


PART_UUID = "11111111-1111-4111-8111-111111111111"
ROLE = "SO:0000167"


def _detail_body() -> bytes:
    return json.dumps(
        {
            "uuid": PART_UUID,
            "name": "BBa_TestPart1",
            "status": "published",
            "role": {"accession": ROLE, "label": "Promoter"},
            "topology": {"accession": "SO:0000987"},
            "licenseUUID": next(iter(crawler.LICENSE_UUIDS)),
            "sequence": "ACGTACGTACGT",
            "audit": {"created": "2025-08-31T12:30:00Z"},
            "chassis": {"designedFor": []},
        },
        separators=(",", ":"),
    ).encode("utf-8")


def _state_entry(body: bytes) -> dict:
    return {
        "uuid": PART_UUID,
        "role": ROLE,
        "decision": "accepted",
        "retrieved_at": "2025-08-31T12:30:00Z",
        "url": f"{crawler.API_BASE}/parts/{PART_UUID}",
        "content_sha256": hashlib.sha256(body).hexdigest(),
        "byte_count": len(body),
        "content_type": "application/json",
        "name": "BBa_TestPart1",
        "sequence_length": 12,
        "sequence_sha256": hashlib.sha256(b"ACGTACGTACGT").hexdigest(),
        "license_uuid": next(iter(crawler.LICENSE_UUIDS)),
        "chassis_names": [],
    }


class _Client:
    def __init__(self, body: bytes) -> None:
        self.body = body

    def get(self, _url: str) -> tuple[bytes, str, str]:
        return self.body, "application/json", "2025-08-31T12:30:00Z"


class CrawlIgemPartsTests(unittest.TestCase):
    def test_repository_relative_paths_reject_windows_and_posix_escapes(self) -> None:
        for value in ("../outside.json", "C:/outside.json", "materials/file:stream", "/outside.json", "a\\b.json"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    crawler._safe_relative(value)

    def test_season_filter_requires_a_timezone_aware_rfc3339_timestamp(self) -> None:
        self.assertTrue(crawler._season_allowed("2025-12-31T23:59:59Z", "BBa_TestPart1"))
        for invalid in (None, "", "2025-12-31", "2025-12-31T23:59:59", "0000"):
            with self.subTest(invalid=invalid):
                self.assertFalse(crawler._season_allowed(invalid, "BBa_TestPart1"))
        self.assertFalse(crawler._season_allowed("2026-01-01T00:00:00Z", "BBa_TestPart1"))
        self.assertFalse(crawler._season_allowed("2025-01-01T00:00:00Z", "BBa_26ABC"))

    def test_state_checkpoint_is_not_written_when_evidence_publication_fails(self) -> None:
        body = _detail_body()
        state: dict[str, dict] = {}
        sequence_digests: set[str] = set()
        with tempfile.TemporaryDirectory(prefix="proto-igem-crawl-order-") as temp:
            repo = Path(temp)
            with (
                patch.object(crawler, "_write_evidence", side_effect=OSError("simulated evidence failure")),
                patch.object(crawler, "_append_state") as append_state,
            ):
                with self.assertRaisesRegex(OSError, "simulated evidence failure"):
                    crawler._crawl_role(
                        repo,
                        _Client(body),
                        ROLE,
                        [{"uuid": PART_UUID}],
                        state,
                        sequence_digests,
                    )
            append_state.assert_not_called()
        self.assertEqual(state, {})
        self.assertEqual(sequence_digests, set())

    def test_resume_only_trusts_hash_matching_durable_evidence(self) -> None:
        body = _detail_body()
        entry = _state_entry(body)
        with tempfile.TemporaryDirectory(prefix="proto-igem-crawl-state-") as temp:
            repo = Path(temp)
            crawler._write_evidence(repo, crawler.PARTS_DIRECTORY, PART_UUID, body)
            crawler._append_state(repo, entry)
            self.assertEqual(crawler._load_state(repo)[PART_UUID], entry)

            evidence = repo / crawler.PARTS_DIRECTORY / f"{PART_UUID}.json"
            evidence.write_bytes(body + b" ")
            self.assertNotIn(PART_UUID, crawler._load_state(repo))

    def test_evidence_write_rejects_a_simulated_repository_junction(self) -> None:
        body = _detail_body()
        with tempfile.TemporaryDirectory(prefix="proto-igem-crawl-reparse-") as temp:
            repo = Path(temp)
            unsafe_parent = repo / "materials"
            unsafe_parent.mkdir()
            real_check = security_module._is_reparse_or_symlink

            def simulated_check(path: Path) -> bool:
                return path == unsafe_parent or real_check(path)

            with patch("proto_agent.security._is_reparse_or_symlink", side_effect=simulated_check):
                with self.assertRaises(SecurityBoundaryError):
                    crawler._write_evidence(repo, crawler.PARTS_DIRECTORY, PART_UUID, body)
            self.assertEqual(list(unsafe_parent.rglob("*.json")), [])


if __name__ == "__main__":
    unittest.main()
