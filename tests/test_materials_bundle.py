from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from proto_agent.materials import MaterialsError, MaterialsStore, PROMOTION_POLICY_VERSION, PROMOTION_ROUND_IDS, promotion_record_digest
from proto_agent.materials_bundle import default_bundle_path, install_public_bundle, verify_materials_bundle


def _fixture_record() -> dict:
    sequence = "ATGCGTATGCGT"
    sequence_sha256 = hashlib.sha256(sequence.encode("ascii")).hexdigest()
    return {
        "resource_id": "fixture:public/promoter",
        "kind": "genetic_part",
        "name": "Public software fixture",
        "description_en": "A deterministic public software fixture.",
        "chassis": ["ecoli_k12"],
        "part_type": "promoter",
        "sequence": sequence,
        "sequence_sha256": sequence_sha256,
        "sequence_kind": "DNA",
        "source": {
            "provider": "fixture",
            "record_id": "fixture:public/promoter",
            "revision": "1",
            "release": "fixture-1",
            "url": "https://example.invalid/public-fixture",
            "retrieved_at": "2026-09-01T00:00:00Z",
            "content_sha256": "1" * 64,
            "sequence_sha256": sequence_sha256,
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
        "evidence_refs": ["https://example.invalid/public-fixture", "https://creativecommons.org/publicdomain/zero/1.0/"],
    }


def _fixture_attestation(record: dict) -> dict[str, dict]:
    return {
        record["resource_id"]: {
            "policy_version": PROMOTION_POLICY_VERSION,
            "resource_id": record["resource_id"],
            "record_sha256": promotion_record_digest(record),
            "decision": "PASS",
            "rounds": [
                {"round_id": round_id, "status": "PASS", "reason_codes": ["TEST_FIXTURE_REVIEWED"]}
                for round_id in PROMOTION_ROUND_IDS
            ],
        }
    }


def _tree_hashes(directory: Path) -> dict[str, str]:
    return {
        path.relative_to(directory).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.rglob("*"))
        if path.is_file()
    }


def _rewrite_bundle_checksums(directory: Path) -> None:
    bundle_path = directory / "bundle.json"
    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    bundle["files"] = {
        path.relative_to(directory).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.rglob("*"))
        if path.is_file() and path.name not in {"bundle.json", "SHA256SUMS"}
    }
    bundle_path.write_text(
        json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    sums = [
        f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(directory).as_posix()}"
        for path in sorted(directory.rglob("*"))
        if path.is_file() and path.name != "SHA256SUMS"
    ]
    (directory / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="ascii")


class MaterialsBundleTests(unittest.TestCase):
    def test_checked_in_public_and_quarantine_bundles_verify(self) -> None:
        public = verify_materials_bundle(default_bundle_path("PUBLIC_CATALOG"), expected_profile="PUBLIC_CATALOG")
        self.assertEqual(public["record_count"], 18)
        self.assertEqual(public["status_counts"], {"DESIGN_ELIGIBLE": 18})
        self.assertEqual(public["license_counts"], {"CC-BY-4.0": 17, "CC0-1.0": 1})

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

            with self.assertRaises(MaterialsError) as ctx:
                install_public_bundle(store, activate=True)
            self.assertEqual(ctx.exception.code, "ACTIVATION_EVIDENCE_REQUIRED")
            self.assertIsNone(store.status()["active_snapshot"])

            activated = install_public_bundle(
                store,
                activate=True,
                operator="test-operator-label",
                approval_reference="review-ticket:PUBLIC-18",
            )
            self.assertFalse(activated["installed"])
            self.assertTrue(activated["activated"])
            pointer = json.loads(store.active_pointer.read_text(encoding="utf-8"))
            self.assertEqual(pointer["action"], "activate")
            self.assertEqual(pointer["operator"], "test-operator-label")
            self.assertEqual(pointer["approval_reference"], "review-ticket:PUBLIC-18")
            self.assertEqual(pointer["operator_identity_assurance"], "SELF_DECLARED_UNVERIFIED")
            self.assertRegex(pointer["manifest_sha256"], r"^[a-f0-9]{64}$")
            self.assertTrue(pointer["activated_at"].endswith("Z"))
            self.assertEqual(store.search(limit=20)["returned_count"], 18)
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
            installed = install_public_bundle(
                store,
                checkout,
                activate=True,
                operator="test-operator-label",
                approval_reference="review-ticket:FILE-CHECKOUT",
            )
            self.assertTrue(installed["installed"])
            self.assertTrue(installed["activated"])
            self.assertEqual(store.search(limit=20)["returned_count"], 18)

    def test_public_snapshot_rollback_requires_and_records_fresh_evidence(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proto-bundle-rollback-") as temp_name:
            temp = Path(temp_name)
            workspace = temp / "workspace"
            workspace.mkdir()
            store = MaterialsStore(workspace=workspace, root=temp / "external")
            installed = install_public_bundle(store)
            store.initialize_seed()
            with self.assertRaises(MaterialsError) as ctx:
                store.rollback(installed["snapshot_id"])
            self.assertEqual(ctx.exception.code, "ACTIVATION_EVIDENCE_REQUIRED")
            self.assertNotEqual(store.status()["active_snapshot"], installed["snapshot_id"])

            result = store.rollback(
                installed["snapshot_id"],
                operator="rollback-operator-label",
                approval_reference="change-record:ROLLBACK-1",
            )
            self.assertEqual(result["action"], "rollback")
            pointer = json.loads(store.active_pointer.read_text(encoding="utf-8"))
            self.assertEqual(pointer["action"], "rollback")
            self.assertEqual(pointer["operator"], "rollback-operator-label")
            self.assertEqual(pointer["approval_reference"], "change-record:ROLLBACK-1")
            self.assertEqual(store.status()["active_snapshot"], installed["snapshot_id"])

    def test_public_activation_evidence_is_bounded_and_pointer_is_revalidated(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proto-bundle-evidence-") as temp_name:
            temp = Path(temp_name)
            workspace = temp / "workspace"
            workspace.mkdir()
            store = MaterialsStore(workspace=workspace, root=temp / "external")
            installed = install_public_bundle(store)
            with self.assertRaises(MaterialsError) as ctx:
                store.activate(
                    installed["snapshot_id"],
                    operator="x" * 129,
                    approval_reference="review-ticket:TOO-LONG",
                )
            self.assertEqual(ctx.exception.code, "ACTIVATION_EVIDENCE_INVALID")
            with self.assertRaises(MaterialsError) as ctx:
                store.activate(
                    installed["snapshot_id"],
                    operator="test\x00operator",
                    approval_reference="review-ticket:CONTROL",
                )
            self.assertEqual(ctx.exception.code, "ACTIVATION_EVIDENCE_INVALID")
            with self.assertRaises(MaterialsError) as ctx:
                store.activate(
                    installed["snapshot_id"],
                    operator="test\u2028operator",
                    approval_reference="review-ticket:UNICODE-LINE",
                )
            self.assertEqual(ctx.exception.code, "ACTIVATION_EVIDENCE_INVALID")
            store.activate(
                installed["snapshot_id"],
                operator="test-operator-label",
                approval_reference="review-ticket:VALID",
            )
            pointer = json.loads(store.active_pointer.read_text(encoding="utf-8"))
            pointer["approval_reference"] = ""
            store.active_pointer.write_text(json.dumps(pointer), encoding="utf-8")
            with self.assertRaises(MaterialsError) as ctx:
                store.status()
            self.assertEqual(ctx.exception.code, "ACTIVE_POINTER_INVALID")

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
            manifest_path = snapshot / "manifest.json"
            store.active_pointer.write_text(
                json.dumps({
                    "schema_version": "proto-agent.materials.v1",
                    "active_snapshot": "quarantine-only",
                    "action": "activate",
                    "operator": "test-operator-label",
                    "operator_identity_assurance": "SELF_DECLARED_UNVERIFIED",
                    "approval_reference": "review-ticket:DENIED",
                    "activated_at": "2026-09-02T00:00:00Z",
                    "manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
                }),
                encoding="utf-8",
            )
            with self.assertRaises(MaterialsError) as ctx:
                store.status()
            self.assertEqual(ctx.exception.code, "ACTIVE_POINTER_INVALID")

    def test_bundle_tampering_is_detected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proto-bundle-tamper-") as temp_name:
            target = Path(temp_name) / "bundle"
            shutil.copytree(default_bundle_path("PUBLIC_CATALOG"), target)
            with (target / "records.jsonl").open("a", encoding="utf-8") as handle:
                handle.write("{}\n")
            with self.assertRaises(MaterialsError) as ctx:
                verify_materials_bundle(target)
            self.assertEqual(ctx.exception.code, "BUNDLE_INTEGRITY_FAILED")

    def test_public_bundle_policy_cannot_disagree_with_runtime_manifest(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proto-bundle-policy-") as temp_name:
            target = Path(temp_name) / "bundle"
            shutil.copytree(default_bundle_path("PUBLIC_CATALOG"), target)
            manifest_path = target / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["public_export"]["activation_policy"] = "COMPATIBILITY"
            manifest_path.write_text(
                json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            _rewrite_bundle_checksums(target)

            with self.assertRaises(MaterialsError) as ctx:
                verify_materials_bundle(target, expected_profile="PUBLIC_CATALOG")
            self.assertEqual(ctx.exception.code, "BUNDLE_POLICY_FAILED")

    def test_unknown_snapshot_activation_policy_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proto-snapshot-policy-") as temp_name:
            temp = Path(temp_name)
            workspace = temp / "workspace"
            workspace.mkdir()
            store = MaterialsStore(workspace=workspace, root=temp / "external")
            record = _fixture_record()
            manifest = store._create_snapshot(
                [record],
                "invalid-policy",
                sources=[{"provider": "fixture", "release": "fixture-1"}],
                label="invalid policy",
                manifest_annotations={"activation_policy": "COMPATIBILITY"},
                promotion_attestations=_fixture_attestation(record),
            )
            with self.assertRaises(MaterialsError) as ctx:
                store.activate(manifest["snapshot_id"])
            self.assertEqual(ctx.exception.code, "ACTIVATION_POLICY_INVALID")
            self.assertIsNone(store.status()["active_snapshot"])

    def test_snapshot_builder_is_path_and_clock_deterministic(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proto-bundle-determinism-") as temp_name:
            temp = Path(temp_name)
            workspace = temp / "workspace"
            workspace.mkdir()
            first = MaterialsStore(workspace=workspace, root=temp / "first")
            second = MaterialsStore(workspace=workspace, root=temp / "second")
            created_at = "2026-09-01T00:00:00Z"
            first_record = _fixture_record()
            second_record = _fixture_record()
            first_manifest = first._create_snapshot([first_record], "deterministic", sources=[{"provider": "fixture", "release": "fixture-1"}], label="fixture", created_at=created_at, vacuum_catalogs=True, promotion_attestations=_fixture_attestation(first_record))
            second_manifest = second._create_snapshot([second_record], "deterministic", sources=[{"provider": "fixture", "release": "fixture-1"}], label="fixture", created_at=created_at, vacuum_catalogs=True, promotion_attestations=_fixture_attestation(second_record))
            self.assertEqual(_tree_hashes(Path(first_manifest["snapshot_path"])), _tree_hashes(Path(second_manifest["snapshot_path"])))


if __name__ == "__main__":
    unittest.main()
