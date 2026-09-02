from __future__ import annotations

import unittest
from pathlib import Path

from proto_agent.source_search import (
    search_crossref,
    search_europe_pmc,
    search_rhea,
    search_uniprot,
)


FIXTURES = Path(__file__).parent / "fixtures"


class SourceSearchTests(unittest.TestCase):
    def test_europe_pmc_normalizes_publication_identifiers(self) -> None:
        result = search_europe_pmc("L-DOPA", fixture_path=FIXTURES / "europe_pmc_search.json")

        self.assertTrue(result["ok"])
        self.assertEqual(result["mode"], "fixture")
        self.assertEqual(result["matches"][0]["source_id"], "PMID:34181032")
        self.assertIn("DOI:10.1000/example-epmc", result["source_ids"])

    def test_crossref_normalizes_doi_metadata(self) -> None:
        result = search_crossref("L-DOPA", fixture_path=FIXTURES / "crossref_search.json")

        self.assertEqual(result["matches"][0]["source_id"], "DOI:10.1000/example-crossref")
        self.assertEqual(result["matches"][0]["publication_date"], "2024-5-2")

    def test_uniprot_returns_annotations_without_sequences(self) -> None:
        result = search_uniprot(
            "hydroxylase",
            organism_id=83333,
            fixture_path=FIXTURES / "uniprot_search.json",
        )

        match = result["matches"][0]
        self.assertEqual(match["source_id"], "UniProt:P00001")
        self.assertIn("RHEA:12345", match["identifiers"])
        self.assertNotIn("sequence", match)
        self.assertIn("organism_id:83333", result["effective_query"])

    def test_rhea_normalizes_reaction_and_publication_identifiers(self) -> None:
        result = search_rhea("levodopa", fixture_path=FIXTURES / "rhea_search.tsv")

        match = result["matches"][0]
        self.assertEqual(match["source_id"], "RHEA:12345")
        self.assertIn("PMID:34181032", match["identifiers"])
        self.assertEqual(match["ec_numbers"], ["EC:1.2.3.4"])


if __name__ == "__main__":
    unittest.main()
