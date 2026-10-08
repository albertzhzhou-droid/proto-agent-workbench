from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from proto_agent.workspace_init import (
    GENERATED_FILES,
    MANIFEST_NAME,
    PROVIDERS,
    PYTHON_PROFILES,
    InitError,
    _NoRedirect,
    apply_plan,
    build_plan,
    detect_environment,
    looks_like_secret,
    public_plan,
    recommend_provider,
    verify_provider,
    workspace_status,
)

ROOT = Path(__file__).resolve().parents[1]
FAKE_KEY = "sk-ant-api03-" + "A1b2C3d4" * 6


def _which(found: set[str]):
    return lambda name: f"/usr/bin/{name}" if name in found else None


class _FakeResponse(io.BytesIO):
    def __init__(self, body: bytes, status: int = 200) -> None:
        super().__init__(body)
        self.status = status

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class _FakeOpener:
    def __init__(self, response: _FakeResponse | Exception) -> None:
        self.response = response
        self.requests: list[urllib.request.Request] = []

    def open(self, request: urllib.request.Request, timeout: float | None = None) -> _FakeResponse:
        self.requests.append(request)
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


class DetectionAndPlanTests(unittest.TestCase):
    def test_detect_reports_presence_only(self) -> None:
        report = detect_environment({"ANTHROPIC_API_KEY": FAKE_KEY}, _which({"Rscript"}))
        self.assertTrue(report["providers"]["anthropic-api"]["credential_present"])
        self.assertFalse(report["providers"]["openai-api"]["credential_present"])
        self.assertTrue(report["rscript_found"])
        self.assertNotIn(FAKE_KEY, json.dumps(report))

    def test_recommendation_ranks_api_over_subscription_over_local(self) -> None:
        both = detect_environment({"OPENAI_API_KEY": "x" * 12}, _which({"claude"}))
        self.assertEqual(both["recommended_provider"], "openai-api")
        cli_only = detect_environment({}, _which({"codex"}))
        self.assertEqual(cli_only["recommended_provider"], "codex-subscription")
        nothing = detect_environment({}, _which(set()))
        self.assertEqual(nothing["recommended_provider"], "local-lm-studio")
        self.assertEqual(recommend_provider({}), "local-lm-studio")
        self.assertEqual(PROVIDERS["local-lm-studio"]["security_rank"], max(p["security_rank"] for p in PROVIDERS.values()))

    def test_plan_for_every_provider_is_secret_free_and_writes_nothing(self) -> None:
        for provider in PROVIDERS:
            plan = build_plan(provider=provider, environ={"ANTHROPIC_API_KEY": FAKE_KEY}, which=_which(set()))
            serialized = json.dumps(public_plan(plan)) + "".join(plan["files"].values())
            self.assertNotIn(FAKE_KEY, serialized)
            self.assertFalse(looks_like_secret(serialized), provider)
            self.assertEqual(set(plan["files"]), {*GENERATED_FILES, MANIFEST_NAME})

    def test_local_path_is_flagged_as_fallback(self) -> None:
        plan = build_plan(provider="local-lm-studio", environ={}, which=_which(set()))
        self.assertTrue(plan["manifest"]["provider"]["fallback"])
        self.assertTrue(any("lowest priority" in warning for warning in plan["warnings"]))

    def test_key_env_must_be_a_name_and_never_echoes_a_pasted_key(self) -> None:
        with self.assertRaises(InitError) as caught:
            build_plan(provider="openai-api", key_env=FAKE_KEY, environ={}, which=_which(set()))
        self.assertEqual(caught.exception.code, "INVALID_KEY_ENV")
        self.assertNotIn(FAKE_KEY, str(caught.exception))
        for bad in ("lowercase", "HAS SPACE", "1LEADING_DIGIT"):
            with self.assertRaises(InitError):
                build_plan(provider="openai-api", key_env=bad, environ={}, which=_which(set()))
        plan = build_plan(provider="openai-api", key_env="TEAM_OPENAI_KEY", environ={}, which=_which(set()))
        self.assertEqual(plan["manifest"]["provider"]["credential_environment"], "TEAM_OPENAI_KEY")
        with self.assertRaises(InitError):
            build_plan(provider="claude-subscription", key_env="X_KEY", environ={}, which=_which(set()))

    def test_invalid_names_are_rejected(self) -> None:
        for kwargs in ({"design_name": "bad name"}, {"design_name": "1abc"}, {"chassis": "E coli"}, {"python_profile": "nope"}, {"r_profile": "nope"}):
            with self.assertRaises(InitError):
                build_plan(provider="anthropic-api", environ={}, which=_which(set()), **kwargs)
        with self.assertRaises(InitError):
            build_plan(provider="nope", environ={}, which=_which(set()))

    def test_python_profiles_reference_real_extras(self) -> None:
        try:
            import tomllib
        except ImportError:
            self.skipTest("tomllib requires Python 3.11+")
        extras = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["optional-dependencies"]
        for name, profile in PYTHON_PROFILES.items():
            for extra in profile["extras"]:
                self.assertIn(extra, extras, f"{name} references unknown extra {extra}")


class WorkspaceFileTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="proto-init-")
        self.workspace = Path(self._temporary.name).resolve()
        for name in ("parts", "connectors", "literature", "workflows"):
            shutil.copytree(ROOT / name, self.workspace / name)
        self.environ = {"ANTHROPIC_API_KEY": FAKE_KEY}
        self.plan = build_plan(provider="anthropic-api", r_profile="rnaseq", environ=self.environ, which=_which({"Rscript"}))

    def tearDown(self) -> None:
        self._temporary.cleanup()

    def _apply(self, **kwargs: object) -> dict:
        return apply_plan(self.plan, workspace_root=self.workspace, **kwargs)

    def test_apply_then_status_is_clean_and_never_stores_the_key(self) -> None:
        result = self._apply()
        self.assertTrue(result["ok"])
        target = self.workspace / ".proto" / "workspace"
        for name in (*GENERATED_FILES, MANIFEST_NAME):
            self.assertNotIn(FAKE_KEY, (target / name).read_text(encoding="utf-8"))
        status = workspace_status(workspace_root=self.workspace, environ=self.environ)
        self.assertTrue(status["ok"], status)
        self.assertTrue(status["credential_present"])
        self.assertNotIn(FAKE_KEY, json.dumps(status))
        r_config = json.loads((target / "r.json").read_text(encoding="utf-8"))
        self.assertEqual(r_config["packages"], ["jsonlite", "DESeq2"])
        self.assertFalse(r_config["inherit_environment"])

    def test_reapply_requires_force_and_leaves_files_untouched(self) -> None:
        self._apply()
        before = (self.workspace / ".proto" / "workspace" / MANIFEST_NAME).read_text(encoding="utf-8")
        with self.assertRaises(InitError) as caught:
            self._apply()
        self.assertEqual(caught.exception.code, "WORKSPACE_ALREADY_INITIALIZED")
        self.assertEqual((self.workspace / ".proto" / "workspace" / MANIFEST_NAME).read_text(encoding="utf-8"), before)
        self.assertTrue(self._apply(force=True)["ok"])

    def test_status_detects_tampering_and_planted_secrets(self) -> None:
        self._apply()
        target = self.workspace / ".proto" / "workspace"
        with (target / "python.json").open("a", encoding="utf-8") as handle:
            handle.write(f'\n"leak": "{FAKE_KEY}"\n')
        codes = {issue["code"] for issue in workspace_status(workspace_root=self.workspace)["issues"]}
        self.assertEqual(codes, {"DIGEST_MISMATCH", "SECRET_SHAPED_CONTENT"})

    def test_status_before_init_reports_uninitialized(self) -> None:
        status = workspace_status(workspace_root=self.workspace)
        self.assertFalse(status["ok"])
        self.assertFalse(status["initialized"])

    def test_out_dir_cannot_escape_the_workspace(self) -> None:
        for bad in ("../outside", "/abs/path", "", ".."):
            with self.assertRaises(InitError):
                self._apply(out_dir=bad)

    def test_generated_proto_design_passes_check(self) -> None:
        self._apply()
        environment = {**os.environ, "PYTHONPATH": str(ROOT / "src")}
        completed = subprocess.run(
            [sys.executable, "-m", "proto_agent.cli", "check", ".proto/workspace/workspace.proto", "--json"],
            cwd=self.workspace,
            env=environment,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertTrue(json.loads(completed.stdout)["ok"])


class VerifyTests(unittest.TestCase):
    def test_requires_approval_and_credential(self) -> None:
        opener = _FakeOpener(_FakeResponse(b"{}"))
        self.assertEqual(verify_provider("anthropic-api", approve_network=False, environ={"ANTHROPIC_API_KEY": FAKE_KEY}, opener=opener)["code"], "NETWORK_NOT_APPROVED")
        self.assertEqual(verify_provider("anthropic-api", approve_network=True, environ={}, opener=opener)["code"], "CREDENTIAL_MISSING")
        self.assertEqual(opener.requests, [])

    def test_subscription_and_local_paths_have_no_handshake(self) -> None:
        for provider in ("claude-subscription", "codex-subscription", "local-lm-studio"):
            self.assertEqual(verify_provider(provider, approve_network=True, environ={})["code"], "VERIFY_NOT_APPLICABLE")

    def test_malformed_credentials_are_rejected_before_any_request(self) -> None:
        opener = _FakeOpener(_FakeResponse(b"{}"))
        for bad in ("abc\r\nX-Injected: 1", "has space", "z" * 600):
            result = verify_provider("openai-api", approve_network=True, environ={"OPENAI_API_KEY": bad}, opener=opener)
            self.assertEqual(result["code"], "CREDENTIAL_MALFORMED")
        self.assertEqual(opener.requests, [])

    def test_success_sends_fixed_host_and_reports_counts_only(self) -> None:
        body = json.dumps({"data": [{"id": "a"}, {"id": "b"}], "echo": FAKE_KEY}).encode()
        opener = _FakeOpener(_FakeResponse(body))
        result = verify_provider("anthropic-api", approve_network=True, environ={"ANTHROPIC_API_KEY": FAKE_KEY}, opener=opener)
        self.assertTrue(result["ok"])
        self.assertEqual(result["model_count"], 2)
        self.assertNotIn(FAKE_KEY, json.dumps(result))
        request = opener.requests[0]
        self.assertEqual(request.full_url, "https://api.anthropic.com/v1/models")
        self.assertEqual(request.get_header("X-api-key"), FAKE_KEY)
        self.assertEqual(request.get_method(), "GET")

    def test_openai_uses_bearer_header(self) -> None:
        opener = _FakeOpener(_FakeResponse(b'{"data": []}'))
        verify_provider("openai-api", approve_network=True, environ={"OPENAI_API_KEY": "tok_abcdefghijkl"}, opener=opener)
        self.assertEqual(opener.requests[0].get_header("Authorization"), "Bearer tok_abcdefghijkl")
        self.assertEqual(opener.requests[0].full_url, "https://api.openai.com/v1/models")

    def test_http_errors_and_oversized_bodies_fail_closed(self) -> None:
        error = urllib.error.HTTPError("https://api.anthropic.com/v1/models", 401, "Unauthorized", {}, io.BytesIO(b""))
        result = verify_provider("anthropic-api", approve_network=True, environ={"ANTHROPIC_API_KEY": FAKE_KEY}, opener=_FakeOpener(error))
        self.assertEqual((result["ok"], result["code"], result["http_status"]), (False, "HTTP_ERROR", 401))
        oversized = _FakeOpener(_FakeResponse(b"x" * (256 * 1024 + 5)))
        self.assertEqual(verify_provider("anthropic-api", approve_network=True, environ={"ANTHROPIC_API_KEY": FAKE_KEY}, opener=oversized)["code"], "RESPONSE_TOO_LARGE")

    def test_redirects_are_refused(self) -> None:
        request = urllib.request.Request("https://api.anthropic.com/v1/models", headers={"x-api-key": FAKE_KEY})
        with self.assertRaises(urllib.error.HTTPError):
            _NoRedirect().redirect_request(request, io.BytesIO(b""), 302, "Found", {}, "https://evil.example/steal")


if __name__ == "__main__":
    unittest.main()
