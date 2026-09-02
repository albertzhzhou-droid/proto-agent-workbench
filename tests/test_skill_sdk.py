from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from proto_agent.security import SecurityBoundaryError
from proto_agent.skill_sdk import audit_skill_adapters, list_skill_adapters, resolve_skill_adapter


ROOT = Path(__file__).resolve().parents[1]


class SkillSdkTests(unittest.TestCase):
    def _workspace(
        self,
        *,
        command: str = "proto-agent demo",
        http_route: str = "GET /v1/demo",
        connector_status: str = "available",
    ) -> tempfile.TemporaryDirectory[str]:
        temporary = tempfile.TemporaryDirectory(prefix="proto-skill-sdk-")
        workspace = Path(temporary.name)
        skill_dir = workspace / ".codex" / "skills" / "demo-skill"
        skill_dir.mkdir(parents=True)
        (workspace / "connectors").mkdir()
        (skill_dir / "SKILL.md").write_text(
            "---\nname: demo-skill\ndescription: Test adapter.\n---\n\n# Demo\n",
            encoding="utf-8",
        )
        (skill_dir / "proto-skill.json").write_text(
            json.dumps(
                {
                    "schema_version": "proto-agent.skill-adapter.v1",
                    "id": "demo-skill",
                    "name": "Demo Skill",
                    "version": "1.0.0",
                    "description": "A bounded test adapter.",
                    "source": {
                        "catalog": "test",
                        "adaptation": "test-only",
                        "upstream": [
                            {
                                "id": "demo",
                                "url": "https://example.test/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/demo",
                                "license": "MIT",
                                "revision": "a" * 40,
                                "content_sha256": "b" * 64,
                            }
                        ],
                    },
                    "policy": {
                        "risk": "low",
                        "execution": "declarative",
                        "network": "loopback-only",
                        "human_review": False,
                    },
                    "operations": [
                        {
                            "id": "run-demo",
                            "purpose": "Resolve a declared CLI capability.",
                            "interfaces": [{"kind": "cli", "command": command}],
                        },
                        {
                            "id": "call-demo",
                            "purpose": "Resolve an exact HTTP method and route.",
                            "interfaces": [
                                {
                                    "kind": "http",
                                    "connector": "demo-endpoint",
                                    "method": "GET",
                                    "path": "/v1/demo",
                                }
                            ],
                        },
                    ],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        (workspace / "connectors" / "proto_workbench.json").write_text(
            json.dumps(
                {
                    "schema_version": "proto-agent.connectors.v1",
                    "connectors": [
                        {
                            "id": "demo-endpoint",
                            "kind": "local_model_service",
                            "status": connector_status,
                            "purpose": "Resolve bounded test capabilities.",
                            "commands": ["proto-agent demo"],
                            "http_routes": [http_route],
                            "governed_operations": ["unload-owned-model"],
                            "safety_notes": ["Test-only declarative registry entry."],
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        return temporary

    @staticmethod
    def _skill_dir(temporary: tempfile.TemporaryDirectory[str]) -> Path:
        return Path(temporary.name) / ".codex" / "skills" / "demo-skill"

    def _read_manifest(self, temporary: tempfile.TemporaryDirectory[str]) -> dict[str, object]:
        return json.loads((self._skill_dir(temporary) / "proto-skill.json").read_text(encoding="utf-8"))

    def _write_manifest(self, temporary: tempfile.TemporaryDirectory[str], payload: dict[str, object]) -> None:
        (self._skill_dir(temporary) / "proto-skill.json").write_text(
            json.dumps(payload, indent=2) + "\n",
            encoding="utf-8",
        )

    def test_project_catalog_is_vendor_neutral_and_fully_resolved(self) -> None:
        catalog = list_skill_adapters(workspace_root=ROOT)
        self.assertEqual(catalog["execution_model"], "declarative_resolution_only")
        self.assertEqual(catalog["adapter_count"], 7)
        self.assertEqual(
            {adapter["id"] for adapter in catalog["adapters"]},
            {
                "evidence-first-literature-review",
                "governed-materials-review",
                "lm-studio-model-endpoint",
                "proto-science-workflow",
                "research-provenance",
                "scientific-sequence-visualization",
                "sequence-resource-analysis",
            },
        )
        self.assertEqual(catalog["status_counts"], {"available": 7, "partial": 0, "unavailable": 0})
        self.assertRegex(catalog["connector_registry_sha256"], r"^[a-f0-9]{64}$")
        audit = audit_skill_adapters(workspace_root=ROOT)
        self.assertTrue(audit["ok"], audit["findings"])
        self.assertEqual(audit["pass_count"], 3)
        self.assertEqual(audit["connector_registry_sha256"], catalog["connector_registry_sha256"])

    def test_resolver_matches_only_declared_interfaces(self) -> None:
        temporary = self._workspace()
        self.addCleanup(temporary.cleanup)
        result = resolve_skill_adapter("demo-skill", workspace_root=temporary.name)
        self.assertTrue(result["ok"])
        self.assertEqual(result["adapter"]["status"], "available")
        self.assertTrue(all(operation["available"] for operation in result["adapter"]["operations"]))
        self.assertRegex(result["connector_registry_sha256"], r"^[a-f0-9]{64}$")

    def test_missing_exact_http_route_is_partial(self) -> None:
        temporary = self._workspace(http_route="GET /v1/other")
        self.addCleanup(temporary.cleanup)
        catalog = list_skill_adapters(workspace_root=temporary.name)
        adapter = catalog["adapters"][0]
        self.assertEqual(adapter["status"], "partial")
        self.assertEqual(adapter["missing_required_operations"], ["call-demo"])
        resolution = resolve_skill_adapter("demo-skill", workspace_root=temporary.name)
        self.assertFalse(resolution["ok"])
        audit = audit_skill_adapters(workspace_root=temporary.name)
        self.assertFalse(audit["ok"])
        self.assertIn("REQUIRED_CAPABILITY_UNAVAILABLE", {item["code"] for item in audit["findings"]})

    def test_unavailable_connector_fails_resolution_and_audit(self) -> None:
        temporary = self._workspace(connector_status="planned")
        self.addCleanup(temporary.cleanup)
        resolution = resolve_skill_adapter("demo-skill", workspace_root=temporary.name)
        self.assertFalse(resolution["ok"])
        self.assertEqual(resolution["adapter"]["status"], "unavailable")
        self.assertTrue(
            all(
                interface["reason"] == "connector_not_available"
                for operation in resolution["adapter"]["operations"]
                for interface in operation["interfaces"]
            )
        )
        self.assertFalse(audit_skill_adapters(workspace_root=temporary.name)["ok"])

    def test_connector_registry_issue_or_duplicate_id_fails_closed(self) -> None:
        for mutation in (
            lambda registry: registry["connectors"][0].update({"path": "runtime/missing"}),
            lambda registry: registry["connectors"].append(dict(registry["connectors"][0])),
        ):
            with self.subTest(mutation=mutation):
                temporary = self._workspace()
                self.addCleanup(temporary.cleanup)
                registry_path = Path(temporary.name) / "connectors" / "proto_workbench.json"
                registry = json.loads(registry_path.read_text(encoding="utf-8"))
                mutation(registry)
                registry_path.write_text(json.dumps(registry), encoding="utf-8")
                with self.assertRaises(SecurityBoundaryError) as context:
                    list_skill_adapters(workspace_root=temporary.name)
                self.assertEqual(context.exception.code, "CONNECTOR_REGISTRY_INVALID")

    def test_connector_registry_schema_status_and_capability_arrays_are_strict(self) -> None:
        mutations = (
            lambda registry: registry.update({"schema_version": "proto-agent.connectors.v0"}),
            lambda registry: registry.update({"unexpected": True}),
            lambda registry: registry["connectors"][0].update({"unexpected": True}),
            lambda registry: registry["connectors"][0].update({"status": "unknown"}),
            lambda registry: registry["connectors"][0].update({"commands": "proto-agent demo"}),
            lambda registry: registry["connectors"][0].update({"commands": []}),
            lambda registry: registry["connectors"][0].update(
                {"commands": [f"proto-agent demo-{index}" for index in range(65)]}
            ),
            lambda registry: registry["connectors"][0].update({"tools": ["invalid-tool-name"]}),
            lambda registry: registry["connectors"][0].update({"http_routes": ["DELETE /v1/demo"]}),
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                temporary = self._workspace()
                self.addCleanup(temporary.cleanup)
                registry_path = Path(temporary.name) / "connectors" / "proto_workbench.json"
                registry = json.loads(registry_path.read_text(encoding="utf-8"))
                mutation(registry)
                registry_path.write_text(json.dumps(registry), encoding="utf-8")
                with self.assertRaises(SecurityBoundaryError) as context:
                    list_skill_adapters(workspace_root=temporary.name)
                self.assertEqual(context.exception.code, "CONNECTOR_REGISTRY_INVALID")

    def test_manifest_shell_control_syntax_is_rejected_without_execution(self) -> None:
        temporary = self._workspace(command="proto-agent demo; remove-everything")
        self.addCleanup(temporary.cleanup)
        with self.assertRaisesRegex(ValueError, "shell control syntax"):
            list_skill_adapters(workspace_root=temporary.name)

    def test_unexpected_root_file_is_rejected(self) -> None:
        temporary = self._workspace()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name) / ".codex" / "skills"
        (root / "unexpected.txt").write_text("not a skill", encoding="utf-8")
        with self.assertRaises(SecurityBoundaryError) as context:
            list_skill_adapters(workspace_root=temporary.name)
        self.assertEqual(context.exception.code, "SKILL_ENTRY_NOT_DIRECTORY")

    def test_reference_vendor_runtime_token_is_detected(self) -> None:
        temporary = self._workspace()
        self.addCleanup(temporary.cleanup)
        references = self._skill_dir(temporary) / "references"
        references.mkdir()
        (references / "runtime.md").write_text("from anthropic import Anthropic\n", encoding="utf-8")
        audit = audit_skill_adapters(workspace_root=temporary.name)
        self.assertFalse(audit["ok"])
        self.assertTrue(
            any(
                item["code"] == "VENDOR_RUNTIME_COUPLING" and "references/runtime.md" in item["message"]
                for item in audit["findings"]
            )
        )

    def test_claude_cli_and_vendor_host_runtime_tokens_are_detected(self) -> None:
        for content in (
            "Run claude mcp add vendor-tool\n",
            "Call host.agents.create() before continuing.\n",
            "const client = require('@anthropic-ai/claude-code');\n",
        ):
            with self.subTest(content=content):
                temporary = self._workspace()
                self.addCleanup(temporary.cleanup)
                references = self._skill_dir(temporary) / "references"
                references.mkdir()
                (references / "runtime.md").write_text(content, encoding="utf-8")
                audit = audit_skill_adapters(workspace_root=temporary.name)
                self.assertFalse(audit["ok"])
                self.assertTrue(any(item["code"] == "VENDOR_RUNTIME_COUPLING" for item in audit["findings"]))

    def test_unknown_manifest_fields_are_rejected_instead_of_silently_dropped(self) -> None:
        temporary = self._workspace()
        self.addCleanup(temporary.cleanup)
        manifest = self._read_manifest(temporary)
        manifest["post_install"] = {"command": "claude mcp add vendor-tool"}
        self._write_manifest(temporary, manifest)
        with self.assertRaisesRegex(ValueError, "unsupported fields: post_install"):
            list_skill_adapters(workspace_root=temporary.name)

    def test_executable_skill_content_is_rejected(self) -> None:
        temporary = self._workspace()
        self.addCleanup(temporary.cleanup)
        (self._skill_dir(temporary) / "helper.py").write_text("print('not executable through adapters')\n", encoding="utf-8")
        with self.assertRaises(SecurityBoundaryError) as context:
            list_skill_adapters(workspace_root=temporary.name)
        self.assertIn(context.exception.code, {"SKILL_CONTENT_LAYOUT_INVALID", "SKILL_CONTENT_TYPE_NOT_ALLOWED"})

    def test_policy_and_operation_booleans_are_strict(self) -> None:
        for field in ("human_review", "required"):
            with self.subTest(field=field):
                temporary = self._workspace()
                self.addCleanup(temporary.cleanup)
                manifest = self._read_manifest(temporary)
                if field == "human_review":
                    manifest["policy"]["human_review"] = "false"  # type: ignore[index]
                else:
                    manifest["operations"][0]["required"] = 1  # type: ignore[index]
                self._write_manifest(temporary, manifest)
                with self.assertRaisesRegex(ValueError, "must be a boolean"):
                    list_skill_adapters(workspace_root=temporary.name)

    def test_body_name_cannot_satisfy_frontmatter_name(self) -> None:
        temporary = self._workspace()
        self.addCleanup(temporary.cleanup)
        (self._skill_dir(temporary) / "SKILL.md").write_text(
            "---\ndescription: Test adapter.\n---\n\nname: demo-skill\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "frontmatter must include"):
            list_skill_adapters(workspace_root=temporary.name)

    def test_frontmatter_requires_description_and_rejects_nested_or_unknown_yaml(self) -> None:
        frontmatters = (
            "---\nname: demo-skill\n---\n\n# Demo\n",
            "---\nname: demo-skill\ndescription:\n  nested: invalid\n---\n\n# Demo\n",
            "---\nname: demo-skill\ndescription: Test adapter.\npost_install: run\n---\n\n# Demo\n",
            "---\nname: demo-skill\nname: demo-skill\ndescription: Test adapter.\n---\n\n# Demo\n",
        )
        for frontmatter in frontmatters:
            with self.subTest(frontmatter=frontmatter):
                temporary = self._workspace()
                self.addCleanup(temporary.cleanup)
                (self._skill_dir(temporary) / "SKILL.md").write_text(frontmatter, encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "frontmatter"):
                    list_skill_adapters(workspace_root=temporary.name)

    def test_missing_or_escaping_local_link_is_rejected(self) -> None:
        for target in ("references/missing.md", "../outside.md", "/absolute.md"):
            with self.subTest(target=target):
                temporary = self._workspace()
                self.addCleanup(temporary.cleanup)
                document = (self._skill_dir(temporary) / "SKILL.md").read_text(encoding="utf-8")
                (self._skill_dir(temporary) / "SKILL.md").write_text(
                    document + f"\n[unsafe]({target})\n",
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(ValueError, "(?:missing local content|unsafe local link)"):
                    list_skill_adapters(workspace_root=temporary.name)

    def test_document_links_allow_http_sources_but_reject_unsafe_uri_schemes(self) -> None:
        for target in (
            "javascript:alert(1)",
            "data:text/html,unsafe",
            "file:///C:/Windows/System32/drivers/etc/hosts",
            "mailto:operator@example.test",
        ):
            with self.subTest(target=target):
                temporary = self._workspace()
                self.addCleanup(temporary.cleanup)
                skill_path = self._skill_dir(temporary) / "SKILL.md"
                skill_path.write_text(
                    skill_path.read_text(encoding="utf-8") + f"\n[unsafe]({target})\n",
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(ValueError, "unsafe URI scheme"):
                    list_skill_adapters(workspace_root=temporary.name)

        temporary = self._workspace()
        self.addCleanup(temporary.cleanup)
        skill_path = self._skill_dir(temporary) / "SKILL.md"
        skill_path.write_text(
            skill_path.read_text(encoding="utf-8")
            + "\n[public HTTPS](https://example.test/source?version=1#evidence)\n"
            + "[public HTTP](http://example.test/source)\n",
            encoding="utf-8",
        )
        self.assertEqual(list_skill_adapters(workspace_root=temporary.name)["adapter_count"], 1)

    def test_connector_registry_digest_is_bound_into_catalog(self) -> None:
        temporary = self._workspace()
        self.addCleanup(temporary.cleanup)
        first = list_skill_adapters(workspace_root=temporary.name)
        registry_path = Path(temporary.name) / "connectors" / "proto_workbench.json"
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        registry["description"] = "same capabilities, different registry bytes"
        registry_path.write_text(json.dumps(registry), encoding="utf-8")
        second = list_skill_adapters(workspace_root=temporary.name)
        self.assertNotEqual(first["connector_registry_sha256"], second["connector_registry_sha256"])
        self.assertNotEqual(first["catalog_sha256"], second["catalog_sha256"])

    def test_project_owned_unload_is_governed_not_raw_http(self) -> None:
        resolution = resolve_skill_adapter("lm-studio-model-endpoint", workspace_root=ROOT)
        unload = next(
            operation for operation in resolution["adapter"]["operations"] if operation["id"] == "unload-owned-model"
        )
        self.assertTrue(unload["available"])
        self.assertEqual(
            unload["interfaces"],
            [
                {
                    "kind": "governed",
                    "connector": "lm-studio",
                    "operation": "unload-owned-model",
                    "available": True,
                    "reason": "declared_available_by_connector_registry",
                }
            ],
        )
        registry = json.loads((ROOT / "connectors" / "proto_workbench.json").read_text(encoding="utf-8"))
        connector = next(item for item in registry["connectors"] if item["id"] == "lm-studio")
        self.assertEqual(connector["governed_operations"], ["unload-owned-model"])
        self.assertNotIn("POST /api/v1/models/unload", connector["http_routes"])

    def test_project_visualization_uses_packaged_governed_capability(self) -> None:
        resolution = resolve_skill_adapter("scientific-sequence-visualization", workspace_root=ROOT)
        operation = next(
            item for item in resolution["adapter"]["operations"] if item["id"] == "render-and-verify"
        )
        self.assertTrue(operation["available"])
        self.assertEqual(
            operation["interfaces"],
            [
                {
                    "kind": "governed",
                    "connector": "workbench-visualization",
                    "operation": "render-and-verify",
                    "available": True,
                    "reason": "declared_available_by_connector_registry",
                }
            ],
        )
        registry = json.loads((ROOT / "connectors" / "proto_workbench.json").read_text(encoding="utf-8"))
        connector = next(item for item in registry["connectors"] if item["id"] == "workbench-visualization")
        self.assertEqual(connector["governed_operations"], ["render-and-verify"])
        self.assertNotIn("path", connector)
        self.assertNotIn("commands", connector)

        packaged_workspace = ROOT / "apps" / "proto-workbench" / "runtime" / "workspace-template"
        packaged_resolution = resolve_skill_adapter(
            "scientific-sequence-visualization",
            workspace_root=packaged_workspace,
        )
        packaged_operation = next(
            item
            for item in packaged_resolution["adapter"]["operations"]
            if item["id"] == "render-and-verify"
        )
        self.assertTrue(packaged_operation["available"])
        self.assertEqual(packaged_operation["interfaces"][0]["kind"], "governed")

    def test_upstream_revision_and_content_digest_are_required(self) -> None:
        temporary = self._workspace()
        self.addCleanup(temporary.cleanup)
        manifest = self._read_manifest(temporary)
        del manifest["source"]["upstream"][0]["revision"]  # type: ignore[index]
        self._write_manifest(temporary, manifest)
        with self.assertRaisesRegex(ValueError, "source.upstream.revision"):
            list_skill_adapters(workspace_root=temporary.name)

    def test_upstream_digest_scope_is_explicitly_recorded_only(self) -> None:
        temporary = self._workspace()
        self.addCleanup(temporary.cleanup)
        audit = audit_skill_adapters(workspace_root=temporary.name)
        self.assertEqual(
            audit["upstream_content_verification"],
            {
                "status": "recorded_only",
                "live_fetch_performed": False,
                "message": audit["upstream_content_verification"]["message"],
            },
        )
        self.assertIn("local_schema_and_integrity", audit["passes"])
        self.assertNotIn("schema_and_integrity", audit["passes"])


if __name__ == "__main__":
    unittest.main()
