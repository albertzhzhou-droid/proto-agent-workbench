from __future__ import annotations

import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from proto_agent.provenance import (
    ProvenanceError,
    compare_provenance,
    create_provenance,
    verify_provenance,
)


def _fixture_workspace(tmp_path: Path) -> tuple[Path, Path]:
    workspace = tmp_path / "workspace"
    run_dir = workspace / "build" / "runs" / "run-1"
    (workspace / "designs").mkdir(parents=True)
    (workspace / "parts").mkdir()
    run_dir.mkdir(parents=True)
    design = workspace / "designs" / "example.proto"
    library = workspace / "parts" / "library.json"
    artifact = run_dir / "example.ir.json"
    design.write_text("design example chassis fixture\n", encoding="utf-8")
    library.write_text('{"parts": []}\n', encoding="utf-8")
    artifact.write_text('{"schema_version": "fixture"}\n', encoding="utf-8")
    manifest = run_dir / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "run_id": "run-1",
                "inputs": {
                    "design": "designs/example.proto",
                    "parts": "parts/library.json",
                },
                "artifacts": ["build/runs/run-1/example.ir.json"],
            }
        ),
        encoding="utf-8",
    )
    return workspace, manifest


class ProvenanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_create_and_verify_provenance(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)

        statement = create_provenance(manifest, workspace_root=workspace, build_root="build")
        result = verify_provenance(
            statement["provenance_path"],
            workspace_root=workspace,
            build_root="build",
        )

        self.assertEqual(statement["schema_version"], "proto-agent.provenance.v1")
        self.assertEqual(len(statement["materials"]), 2)
        self.assertEqual(len(statement["artifacts"]), 1)
        self.assertTrue(result["ok"])
        self.assertEqual(result["checked"], 4)

    def test_tampered_artifact_fails_verification(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)
        statement = create_provenance(manifest, workspace_root=workspace, build_root="build")
        (workspace / "build" / "runs" / "run-1" / "example.ir.json").write_text(
            "tampered\n", encoding="utf-8"
        )

        result = verify_provenance(
            statement["provenance_path"],
            workspace_root=workspace,
            build_root="build",
        )

        self.assertFalse(result["ok"])
        self.assertTrue(
            {"DIGEST_MISMATCH", "SIZE_MISMATCH"}.issubset(
                {item["code"] for item in result["mismatches"]}
            )
        )

    def test_verification_rejects_elided_manifest_claim_records(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)
        statement = create_provenance(manifest, workspace_root=workspace, build_root="build")
        provenance_path = Path(statement["provenance_path"])
        payload = json.loads(provenance_path.read_text(encoding="utf-8"))
        payload["materials"] = []
        payload["artifacts"] = []
        provenance_path.write_text(json.dumps(payload), encoding="utf-8")

        result = verify_provenance(
            provenance_path,
            workspace_root=workspace,
            build_root="build",
        )

        self.assertFalse(result["ok"])
        self.assertIn(
            "MISSING_CLAIM_RECORD",
            {item["code"] for item in result["mismatches"]},
        )

    def test_artifact_outside_build_is_rejected(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)
        outside = workspace / "outside.json"
        outside.write_text("{}\n", encoding="utf-8")
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        payload["artifacts"] = ["outside.json"]
        manifest.write_text(json.dumps(payload), encoding="utf-8")

        with self.assertRaisesRegex(ProvenanceError, "escapes configured root"):
            create_provenance(manifest, workspace_root=workspace, build_root="build")

    def test_total_digest_budget_is_enforced(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)

        with self.assertRaisesRegex(ProvenanceError, "digest byte budget exceeded"):
            create_provenance(
                manifest,
                workspace_root=workspace,
                build_root="build",
                max_total_bytes=1,
            )

    def test_exact_digest_budget_succeeds(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)
        files = [
            manifest,
            workspace / "designs" / "example.proto",
            workspace / "parts" / "library.json",
            workspace / "build" / "runs" / "run-1" / "example.ir.json",
        ]
        exact_budget = sum(path.stat().st_size for path in files)

        statement = create_provenance(
            manifest,
            workspace_root=workspace,
            build_root="build",
            max_total_bytes=exact_budget,
        )

        self.assertEqual(statement["policy"]["max_total_bytes"], exact_budget)

    def test_verification_digest_budget_is_enforced_before_read(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)
        statement = create_provenance(manifest, workspace_root=workspace, build_root="build")

        result = verify_provenance(
            statement["provenance_path"],
            workspace_root=workspace,
            build_root="build",
            max_total_bytes=1,
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["checked"], 0)
        budget_mismatches = [
            item
            for item in result["mismatches"]
            if item["code"] == "UNREADABLE_OR_OUTSIDE_ROOT"
        ]
        self.assertTrue(budget_mismatches)
        self.assertTrue(
            all(
                "digest byte budget exceeded" in item.get("detail", "")
                for item in budget_mismatches
            )
        )

    def test_duplicate_json_key_is_rejected(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)
        manifest.write_text(
            '{"run_id":"first","run_id":"second","inputs":{},"artifacts":[]}',
            encoding="utf-8",
        )

        with self.assertRaisesRegex(ProvenanceError, "duplicate JSON object key"):
            create_provenance(manifest, workspace_root=workspace, build_root="build")

    def test_excessive_json_depth_is_rejected(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)
        nested = "[" * 65 + "0" + "]" * 65
        manifest.write_text(
            '{"run_id":"deep","inputs":{},"artifacts":' + nested + "}",
            encoding="utf-8",
        )

        with self.assertRaisesRegex(ProvenanceError, "JSON nesting exceeds"):
            create_provenance(manifest, workspace_root=workspace, build_root="build")

    def test_unbounded_json_numbers_are_rejected(self) -> None:
        cases = [
            ("NaN", "non-standard JSON numeric constant"),
            ("1e309", "floating-point literal is out of range"),
            ("9223372036854775808", "signed 64-bit limit"),
        ]
        for numeric_literal, expected in cases:
            with self.subTest(value=numeric_literal):
                workspace, manifest = _fixture_workspace(self.tmp_path / numeric_literal.replace("+", "p"))
                manifest.write_text(
                    '{"run_id":"numeric","inputs":{},"artifacts":[],"value":'
                    + numeric_literal
                    + "}",
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(ProvenanceError, expected):
                    create_provenance(manifest, workspace_root=workspace, build_root="build")

    def test_manifest_self_reference_is_rejected(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        payload["inputs"]["manifest"] = "build/runs/run-1/manifest.json"
        manifest.write_text(json.dumps(payload), encoding="utf-8")

        with self.assertRaisesRegex(ProvenanceError, "manifest must not reference itself"):
            create_provenance(manifest, workspace_root=workspace, build_root="build")

    def test_output_must_not_replace_manifest(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)

        with self.assertRaisesRegex(ProvenanceError, "must not replace its manifest"):
            create_provenance(
                manifest,
                workspace_root=workspace,
                build_root="build",
                output_path=manifest,
            )

    def test_duplicate_physical_file_claim_is_rejected(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        payload["inputs"]["design-copy"] = "designs/example.proto"
        manifest.write_text(json.dumps(payload), encoding="utf-8")

        with self.assertRaisesRegex(ProvenanceError, "duplicate physical file claim"):
            create_provenance(manifest, workspace_root=workspace, build_root="build")

    def test_hardlinked_input_is_rejected_when_supported(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)
        external = self.tmp_path / "external-hardlink.json"
        external.write_text("{}\n", encoding="utf-8")
        link = workspace / "parts" / "hardlink.json"
        try:
            os.link(external, link)
        except (NotImplementedError, OSError):
            self.skipTest("hardlink creation is unavailable")
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        payload["inputs"] = {"hardlink": "parts/hardlink.json"}
        manifest.write_text(json.dumps(payload), encoding="utf-8")

        with self.assertRaisesRegex(ProvenanceError, "hard-linked file"):
            create_provenance(manifest, workspace_root=workspace, build_root="build")

    def test_hardlinked_output_is_rejected_when_supported(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)
        external = self.tmp_path / "external-output.json"
        external.write_text("preserve\n", encoding="utf-8")
        destination = workspace / "build" / "hardlinked-provenance.json"
        try:
            os.link(external, destination)
        except (NotImplementedError, OSError):
            self.skipTest("hardlink creation is unavailable")

        with self.assertRaisesRegex(ProvenanceError, "hard-linked file"):
            create_provenance(
                manifest,
                workspace_root=workspace,
                build_root="build",
                output_path=destination,
            )
        self.assertEqual(external.read_text(encoding="utf-8"), "preserve\n")

    def test_file_swap_between_validation_and_open_is_rejected(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)
        design = workspace / "designs" / "example.proto"
        displaced = workspace / "designs" / "original.proto"
        real_open = os.open
        swapped = False

        def swapping_open(path: object, flags: int, *args: object, **kwargs: object) -> int:
            nonlocal swapped
            if not swapped and Path(path) == design:
                design.replace(displaced)
                design.write_text("replacement content\n", encoding="utf-8")
                swapped = True
            return real_open(path, flags, *args, **kwargs)

        with (
            mock.patch("proto_agent.provenance.os.open", side_effect=swapping_open),
            self.assertRaisesRegex(ProvenanceError, "changed between validation and open"),
        ):
            create_provenance(manifest, workspace_root=workspace, build_root="build")

    def test_atomic_write_detects_parent_directory_replacement(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)
        output_parent = workspace / "build" / "attested"
        output_parent.mkdir()
        displaced_parent = workspace / "build" / "attested-original"
        destination = output_parent / "provenance.json"
        real_named_temporary_file = tempfile.NamedTemporaryFile
        swapped = False

        def swapping_named_temporary_file(*args: object, **kwargs: object):
            nonlocal swapped
            if not swapped:
                output_parent.replace(displaced_parent)
                output_parent.mkdir()
                swapped = True
            return real_named_temporary_file(*args, **kwargs)

        with (
            mock.patch(
                "proto_agent.provenance.tempfile.NamedTemporaryFile",
                side_effect=swapping_named_temporary_file,
            ),
            self.assertRaisesRegex(ProvenanceError, "output parent changed before write"),
        ):
            create_provenance(
                manifest,
                workspace_root=workspace,
                build_root="build",
                output_path=destination,
            )

        self.assertFalse(destination.exists())
        self.assertEqual(list(output_parent.glob("*.tmp")), [])

    def test_atomic_write_does_not_replace_a_new_target(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)
        destination = workspace / "build" / "new-target.json"

        from proto_agent import provenance as provenance_module

        real_signature = provenance_module._optional_regular_signature
        signature_calls = 0

        def inserting_signature(
            path: Path,
            label: str,
            *,
            max_file_bytes: int,
        ):
            nonlocal signature_calls
            signature_calls += 1
            if signature_calls == 2:
                destination.write_text("do not overwrite\n", encoding="utf-8")
            return real_signature(path, label, max_file_bytes=max_file_bytes)

        with (
            mock.patch.object(
                provenance_module,
                "_optional_regular_signature",
                side_effect=inserting_signature,
            ),
            self.assertRaisesRegex(ProvenanceError, "output target changed before replace"),
        ):
            create_provenance(
                manifest,
                workspace_root=workspace,
                build_root="build",
                output_path=destination,
            )

        self.assertEqual(destination.read_text(encoding="utf-8"), "do not overwrite\n")

    def test_symlinked_output_parent_is_rejected_when_supported(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)
        external = self.tmp_path / "external-output-directory"
        external.mkdir()
        linked_parent = workspace / "build" / "linked-output"
        try:
            os.symlink(external, linked_parent, target_is_directory=True)
        except (NotImplementedError, OSError):
            self.skipTest("directory symlink creation is unavailable")

        with self.assertRaisesRegex(ProvenanceError, "reparse points are not allowed"):
            create_provenance(
                manifest,
                workspace_root=workspace,
                build_root="build",
                output_path=linked_parent / "provenance.json",
            )

    def test_windows_reparse_attribute_is_detected(self) -> None:
        reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
        if not reparse_flag:
            self.skipTest("platform does not expose the Windows reparse attribute")
        from proto_agent import provenance as provenance_module

        metadata = mock.Mock()
        metadata.st_mode = stat.S_IFDIR
        metadata.st_file_attributes = reparse_flag
        with mock.patch.object(Path, "lstat", return_value=metadata):
            self.assertTrue(provenance_module._is_reparse_point(Path("junction")))

    def test_verify_rejects_provenance_self_reference(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)
        statement = create_provenance(manifest, workspace_root=workspace, build_root="build")
        provenance_path = Path(statement["provenance_path"])
        payload = json.loads(provenance_path.read_text(encoding="utf-8"))
        payload["subject"]["path"] = provenance_path.relative_to(workspace / "build").as_posix()
        provenance_path.write_text(json.dumps(payload), encoding="utf-8")

        result = verify_provenance(
            provenance_path,
            workspace_root=workspace,
            build_root="build",
        )

        self.assertFalse(result["ok"])
        self.assertIn("SELF_REFERENCE", {item["code"] for item in result["mismatches"]})

    def test_invalid_artifact_claim_is_not_silently_omitted(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        payload["artifacts"] = [17]
        manifest.write_text(json.dumps(payload), encoding="utf-8")

        with self.assertRaisesRegex(ProvenanceError, "artifact claim 0"):
            create_provenance(manifest, workspace_root=workspace, build_root="build")

    def test_symlinked_artifact_is_rejected_when_supported(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)
        external = self.tmp_path / "external.json"
        external.write_text("{}\n", encoding="utf-8")
        link = workspace / "build" / "runs" / "run-1" / "link.json"
        try:
            os.symlink(external, link)
        except (NotImplementedError, OSError):
            self.skipTest("symlink creation is unavailable")
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        payload["artifacts"] = ["build/runs/run-1/link.json"]
        manifest.write_text(json.dumps(payload), encoding="utf-8")

        with self.assertRaisesRegex(ProvenanceError, "reparse points are not allowed"):
            create_provenance(manifest, workspace_root=workspace, build_root="build")

    def test_compare_reports_modified_artifact(self) -> None:
        workspace, manifest = _fixture_workspace(self.tmp_path)
        first = create_provenance(
            manifest,
            workspace_root=workspace,
            build_root="build",
            output_path="build/provenance-before.json",
        )
        (workspace / "build" / "runs" / "run-1" / "example.ir.json").write_text(
            '{"schema_version": "fixture-v2"}\n', encoding="utf-8"
        )
        second = create_provenance(
            manifest,
            workspace_root=workspace,
            build_root="build",
            output_path="build/provenance-after.json",
        )

        comparison = compare_provenance(
            first["provenance_path"],
            second["provenance_path"],
            workspace_root=workspace,
            build_root="build",
        )

        self.assertTrue(comparison["changed"])
        self.assertEqual(comparison["counts"]["modified"], 1)
        modified = [item for item in comparison["changes"] if item["status"] == "modified"]
        self.assertEqual(modified[0]["kind"], "artifact")


if __name__ == "__main__":
    unittest.main()
