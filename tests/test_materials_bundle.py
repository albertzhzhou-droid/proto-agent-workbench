from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from proto_agent.materials import MaterialsError, MaterialsStore
from proto_agent.materials_bundle import default_bundle_path, install_public_bundle, verify_materials_bundle


def _fixture_record() -> dict:
    return {
        "resource_id": "fixture:public/promoter",
        "kind": "genetic_part",
        "name": "Public software fixture",
        "description_en": "A deterministic public software fixture.",
        "chassis": ["ecoli_k12"],
        "part_type": "promoter",
        "sequence": "ATGCGTATGCGT",
        "sequence_kind": "DNA",
        "source": {
            "provider": "fixture",
            "record_id": "fixture:public/promoter",
            "revision": "1",
            "release": "fixture-1",
            "url": "https://example.invalid/public-fixture",
            "retrieved_at": "2026-09-01T00:00:00Z",
            "content_sha256": "1" * 64,
        },
        "license": {
            "id": "CC0-1.0",
            "url": "https://creativecommons.org/publicdomain/zero/1.0/",
            "attribution": "Public fixture",
            "rights_notes": "Software test fixture.",
            "redistribution_status": "REDISTRIBUTABLE",
        },
        "review_status": "DESIGN_ELIGIBLE",
        "safety_status": "NO_FLAG",
        "design_eligibility": True,
    }


def _tree_hashes(directory: Path) -> dict[str, str]:
    return {
        path.relative_to(directory).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.rglob("*"))
        if path.is_file()
    }


class MaterialsBundleTests(unittest.TestCase):
    def test_checked_in_public_and_quarantine_bundles_verify(self) -> None:
        public = verify_materials_bundle(default_bundle_path("PUBLIC_CATALOG"), expected_profile="PUBLIC_CATALOG")
        self.assertEqual(public["record_count"], 13)
        self.assertEqual(public["status_counts"], {"DESIGN_ELIGIBLE": 13})
        self.assertEqual(public["license_counts"], {"CC-BY-4.0": 12, "CC0-1.0": 1})

        quarantine = verify_materials_bundle(default_bundle_path("PUBLIC_QUARANTINE"), expected_profile="PUBLIC_QUARANTINE")
        self.assertEqual(quarantine["record_count"], 1795)
        self.assertEqual(quarantine["status_counts"], {"QUARANTINED": 1795})
        self.assertEqual(quarantine["activation_policy"], "DENY")
        self.assertFalse(quarantine["default_model_visibility"])

    def test_public_bundle_installs_and_requires_explicit_activation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proto-bundle-install-") as temp_name:
            temp = Path(temp_name)
            workspace = temp / "workspace"
            workspace.mkdir()
            store = MaterialsStore(workspace=workspace, root=temp / "external")
            installed = install_public_bundle(store)
            self.assertTrue(installed["installed"])
            self.assertFalse(installed["activated"])
            self.assertIsNone(store.status()["active_snapshot"])

            activated = install_public_bundle(store, activate=True)
            self.assertFalse(activated["installed"])
            self.assertTrue(activated["activated"])
            self.assertEqual(store.search(limit=20)["returned_count"], 13)
            part = store.materialize_parts(["igem:3c51179f-e370-4738-84b7-91773f750175"], "ecoli_k12")
            self.assertEqual(part["part_count"], 1)
            proteins = store.materialize_proteins(["uniprot:P42212"], design_id="public-protein")
            self.assertEqual(proteins["protein_count"], 1)

    def test_public_bundle_installs_from_file_only_git_checkout(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proto-bundle-git-tree-") as temp_name:
            temp = Path(temp_name)
            source = default_bundle_path("PUBLIC_CATALOG")
            checkout = temp / "checkout"
            for path in source.rglob("*"):
                if path.is_file():
                    destination = checkout / path.relative_to(source)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(path, destination)
            self.assertFalse((checkout / "quarantine" / "blobs").exists())
            workspace = temp / "workspace"
            workspace.mkdir()
            store = MaterialsStore(workspace=workspace, root=temp / "external")
            installed = install_public_bundle(store, checkout, activate=True)
            self.assertTrue(installed["installed"])
            self.assertTrue(installed["activated"])
            self.assertEqual(store.search(limit=20)["returned_count"], 13)

    def test_quarantine_bundle_cannot_use_public_installer(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proto-bundle-deny-") as temp_name:
            temp = Path(temp_name)
            workspace = temp / "workspace"
            workspace.mkdir()
            store = MaterialsStore(workspace=workspace, root=temp / "external")
            with self.assertRaises(MaterialsError) as ctx:
                install_public_bundle(store, default_bundle_path("PUBLIC_QUARANTINE"))
            self.assertEqual(ctx.exception.code, "BUNDLE_PROFILE_MISMATCH")

    def test_activation_policy_denies_quarantine_only_manifest(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proto-bundle-activation-") as temp_name:
            temp = Path(temp_name)
            workspace = temp / "workspace"
            workspace.mkdir()
            store = MaterialsStore(workspace=workspace, root=temp / "external")
            snapshot = store.snapshots / "quarantine-only"
            snapshot.mkdir()
            (snapshot / "manifest.json").write_text(
                json.dumps({"schema_version": "proto-agent.materials.v1", "snapshot_id": "quarantine-only", "activation_policy": "DENY"}),
                encoding="utf-8",
            )
            with self.assertRaises(MaterialsError) as ctx:
                store.activate("quarantine-only")
            self.assertEqual(ctx.exception.code, "SNAPSHOT_NOT_ACTIVATABLE")

    def test_bundle_tampering_is_detected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proto-bundle-tamper-") as temp_name:
            target = Path(temp_name) / "bundle"
            shutil.copytree(default_bundle_path("PUBLIC_CATALOG"), target)
            with (target / "records.jsonl").open("a", encoding="utf-8") as handle:
                handle.write("{}\n")
            with self.assertRaises(MaterialsError) as ctx:
                verify_materials_bundle(target)
            self.assertEqual(ctx.exception.code, "BUNDLE_INTEGRITY_FAILED")

    def test_snapshot_builder_is_path_and_clock_deterministic(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proto-bundle-determinism-") as temp_name:
            temp = Path(temp_name)
            workspace = temp / "workspace"
            workspace.mkdir()
            first = MaterialsStore(workspace=workspace, root=temp / "first")
            second = MaterialsStore(workspace=workspace, root=temp / "second")
            created_at = "2026-09-01T00:00:00Z"
            first_manifest = first._create_snapshot([_fixture_record()], "deterministic", sources=[{"provider": "fixture", "release": "fixture-1"}], label="fixture", created_at=created_at, vacuum_catalogs=True)
            second_manifest = second._create_snapshot([_fixture_record()], "deterministic", sources=[{"provider": "fixture", "release": "fixture-1"}], label="fixture", created_at=created_at, vacuum_catalogs=True)
            self.assertEqual(_tree_hashes(Path(first_manifest["snapshot_path"])), _tree_hashes(Path(second_manifest["snapshot_path"])))


if __name__ == "__main__":
    unittest.main()
