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
    classify_http_status,
    detect_environment,
    load_manifest_provider,
    looks_like_secret,
    parse_gateway_url,
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
        extra = {"custom-gateway": {"base_url": "https://gw.example.com/v1", "model": "m-1", "protocol": "chat-completions"}}
        for provider in PROVIDERS:
            plan = build_plan(provider=provider, environ={"ANTHROPIC_API_KEY": FAKE_KEY}, which=_which(set()), **extra.get(provider, {}))
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

    def test_identical_reapply_is_a_noop_and_different_config_needs_force(self) -> None:
        first = self._apply()
        self.assertTrue(first["changed"])
        manifest_file = self.workspace / ".proto" / "workspace" / MANIFEST_NAME
        before = manifest_file.read_text(encoding="utf-8")
        again = self._apply()
        self.assertFalse(again["changed"])
        self.assertEqual((again["written"], again["metrics"]["files_written"]), ([], 0))
        self.assertEqual(manifest_file.read_text(encoding="utf-8"), before)
        different = build_plan(provider="openai-api", environ=self.environ, which=_which(set()))
        with self.assertRaises(InitError) as caught:
            apply_plan(different, workspace_root=self.workspace)
        self.assertEqual(caught.exception.code, "WORKSPACE_ALREADY_INITIALIZED")
        self.assertIn("provider", str(caught.exception))
        self.assertEqual(manifest_file.read_text(encoding="utf-8"), before)
        self.assertTrue(apply_plan(different, workspace_root=self.workspace, force=True)["changed"])

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


class GatewayAndModelTests(unittest.TestCase):
    def test_gateway_url_rules(self) -> None:
        ok = parse_gateway_url("https://Gateway.Example.com/v1/")
        self.assertEqual((ok["base_url"], ok["host"], ok["loopback"]), ("https://gateway.example.com/v1", "gateway.example.com", False))
        local = parse_gateway_url("http://127.0.0.1:11434/v1")
        self.assertTrue(local["loopback"])
        self.assertTrue(parse_gateway_url("http://localhost:8000")["loopback"])
        self.assertTrue(parse_gateway_url("http://[::1]:8000")["loopback"])
        bad = {
            "http://gateway.example.com": "GATEWAY_REQUIRES_HTTPS",
            "https://203.0.113.9/v1": "GATEWAY_IP_LITERAL",
            "https://169.254.169.254/latest": "GATEWAY_IP_LITERAL",
            "https://user:pw@gateway.example.com": "INVALID_BASE_URL",
            "https://gateway.example.com/v1?x=1": "INVALID_BASE_URL",
            "https://gateway.example.com/v1#frag": "INVALID_BASE_URL",
            "https://gateway.example.com/../etc": "INVALID_BASE_URL",
            "https://gateway.example.com:99999": "INVALID_BASE_URL",
            "ftp://gateway.example.com": "INVALID_BASE_URL",
            "https://": "INVALID_BASE_URL",
            "https://bad_host.example.com": "INVALID_BASE_URL",
        }
        for value, code in bad.items():
            with self.assertRaises(InitError, msg=value) as caught:
                parse_gateway_url(value)
            self.assertEqual(caught.exception.code, code, value)

    def test_gateway_plan_requires_url_model_and_protocol(self) -> None:
        base = {"provider": "custom-gateway", "environ": {}, "which": _which(set())}
        for kwargs, code in (
            ({}, "GATEWAY_BASE_URL_REQUIRED"),
            ({"base_url": "https://gw.example.com"}, "GATEWAY_MODEL_REQUIRED"),
            ({"base_url": "https://gw.example.com", "model": "m"}, "INVALID_PROTOCOL"),
        ):
            with self.assertRaises(InitError) as caught:
                build_plan(**base, **kwargs)
            self.assertEqual(caught.exception.code, code)
        with self.assertRaises(InitError) as caught:
            build_plan(provider="openai-api", environ={}, which=_which(set()), base_url="https://gw.example.com")
        self.assertEqual(caught.exception.code, "GATEWAY_OPTION_NOT_APPLICABLE")

    def test_remote_gateway_requires_a_key_variable_and_loopback_does_not(self) -> None:
        remote = build_plan(provider="custom-gateway", base_url="https://gw.example.com/v1", model="m", protocol="messages", environ={}, which=_which(set()))
        self.assertEqual(remote["manifest"]["provider"]["credential_environment"], "PROTO_GATEWAY_API_KEY")
        self.assertEqual(remote["security_rank"], 2)
        local = build_plan(provider="custom-gateway", base_url="http://127.0.0.1:11434/v1", model="m", protocol="chat-completions", environ={}, which=_which(set()))
        self.assertNotIn("credential_environment", local["manifest"]["provider"])
        self.assertEqual((local["security_rank"], local["manifest"]["provider"]["fallback"]), (3, True))

    def test_gateway_is_never_auto_recommended(self) -> None:
        report = detect_environment({"PROTO_GATEWAY_API_KEY": "x" * 12}, _which(set()))
        self.assertEqual(report["recommended_provider"], "local-lm-studio")

    def test_model_id_validation(self) -> None:
        for bad in ("has space", "../x", "a" * 200, "-lead", "x;y"):
            with self.assertRaises(InitError, msg=bad):
                build_plan(provider="anthropic-api", model=bad, environ={}, which=_which(set()))
        plan = build_plan(provider="anthropic-api", model="claude-sonnet-5-5", environ={}, which=_which(set()))
        self.assertEqual(plan["manifest"]["provider"]["model"], "claude-sonnet-5-5")

    def test_status_categories(self) -> None:
        cases = [
            (200, True, False, "ok"), (401, True, False, "auth"), (403, False, False, "auth"),
            (404, True, False, "model-not-found"), (404, False, False, "bad-url"),
            (404, True, True, "incompatible"), (405, False, True, "incompatible"),
            (408, False, False, "timeout"), (429, False, False, "server-error"), (503, True, False, "server-error"),
            (418, False, False, "unknown"),
        ]
        for status, probe, gateway, expected in cases:
            self.assertEqual(classify_http_status(status, model_probe=probe, gateway=gateway), expected, (status, probe, gateway))


class IsolatedCredentialTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="proto-init-iso-")
        self.workspace = Path(self._temporary.name).resolve()

    def tearDown(self) -> None:
        self._temporary.cleanup()

    def test_isolated_home_is_created_owner_only_and_git_proof(self) -> None:
        plan = build_plan(provider="claude-subscription", environ={}, which=_which({"claude"}))
        provider = plan["manifest"]["provider"]
        self.assertEqual(provider["credential_storage"], "delegated_isolated_home")
        self.assertEqual(provider["credential_home_environment"], "CLAUDE_CONFIG_DIR")
        result = apply_plan(plan, workspace_root=self.workspace)
        home = self.workspace / ".proto" / "workspace" / "credentials" / "claude-subscription"
        self.assertTrue(home.is_dir())
        self.assertEqual((home / ".gitignore").read_text(encoding="utf-8"), "*\n")
        if os.name != "nt":
            self.assertEqual(home.stat().st_mode & 0o777, 0o700)
        self.assertTrue(any(path.endswith("credentials/claude-subscription/.gitignore") for path in result["written"]))
        self.assertTrue(any("CLAUDE_CONFIG_DIR" in step for step in plan["next_steps"]))

    def test_codex_uses_codex_home_and_shared_mode_warns(self) -> None:
        plan = build_plan(provider="codex-subscription", environ={}, which=_which({"codex"}))
        self.assertEqual(plan["manifest"]["provider"]["credential_home_environment"], "CODEX_HOME")
        shared = build_plan(provider="codex-subscription", credential_mode="shared", environ={}, which=_which({"codex"}))
        self.assertEqual(shared["credential_homes"], [])
        self.assertTrue(any("Shared mode" in warning for warning in shared["warnings"]))
        with self.assertRaises(InitError):
            build_plan(provider="codex-subscription", credential_mode="weird", environ={}, which=_which(set()))

    def test_status_flags_a_missing_isolated_home(self) -> None:
        apply_plan(build_plan(provider="claude-subscription", environ={}, which=_which({"claude"})), workspace_root=self.workspace)
        shutil.rmtree(self.workspace / ".proto" / "workspace" / "credentials")
        status = workspace_status(workspace_root=self.workspace, environ={}, which=_which({"claude"}))
        self.assertFalse(status["ready"])
        self.assertEqual(status["checks"]["credential_home"]["reason"], "isolated_home_missing")
        self.assertIn("repair_configuration", [action["code"] for action in status["next"]])

    def test_credential_home_must_live_under_the_chosen_out_dir(self) -> None:
        plan = build_plan(provider="claude-subscription", environ={}, which=_which(set()))
        with self.assertRaises(InitError) as caught:
            apply_plan(plan, workspace_root=self.workspace, out_dir="elsewhere/dir")
        self.assertEqual(caught.exception.code, "PLAN_OUT_DIR_MISMATCH")


class ReadinessTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="proto-init-ready-")
        self.workspace = Path(self._temporary.name).resolve()

    def tearDown(self) -> None:
        self._temporary.cleanup()

    def test_status_reports_next_actions_and_metrics(self) -> None:
        plan = build_plan(provider="anthropic-api", r_profile="core", model="claude-sonnet-5-5", environ={}, which=_which(set()))
        apply_plan(plan, workspace_root=self.workspace)
        missing = workspace_status(workspace_root=self.workspace, environ={}, which=_which(set()))
        self.assertTrue(missing["ok"])
        self.assertFalse(missing["ready"])
        self.assertEqual(missing["checks"]["provider"]["reason"], "credential_missing")
        self.assertEqual(missing["checks"]["r"]["reason"], "rscript_missing")
        codes = [action["code"] for action in missing["next"]]
        self.assertEqual(codes, ["set_environment", "configure_r_runtime"])
        self.assertEqual(missing["next"][0]["variable"], "ANTHROPIC_API_KEY")
        self.assertEqual(missing["metrics"]["network_requests"], 0)
        present = workspace_status(workspace_root=self.workspace, environ={"ANTHROPIC_API_KEY": FAKE_KEY}, which=_which({"Rscript"}))
        self.assertTrue(present["ready"], present)
        self.assertEqual(present["next"], [{"code": "verify_provider", "argv": ["init", "verify", "--approve-network"]}])
        self.assertNotIn(FAKE_KEY, json.dumps(present))

    def test_detect_reports_workspace_writability(self) -> None:
        report = detect_environment({}, _which(set()), workspace_root=self.workspace)
        self.assertTrue(report["workspace_writable"])
        self.assertEqual(list((self.workspace / "build").glob(".init-check-*")), [])

    def test_future_manifest_version_is_unsupported(self) -> None:
        apply_plan(build_plan(provider="openai-api", environ={}, which=_which(set())), workspace_root=self.workspace)
        manifest = self.workspace / ".proto" / "workspace" / MANIFEST_NAME
        data = json.loads(manifest.read_text(encoding="utf-8"))
        data["schema_version"] = "proto-agent.workspace.v2"
        manifest.write_text(json.dumps(data), encoding="utf-8")
        status = workspace_status(workspace_root=self.workspace, environ={})
        self.assertFalse(status["ok"])
        self.assertIn("UNSUPPORTED_VERSION", status["issues"][0]["message"])
        self.assertIsNone(load_manifest_provider(workspace_root=self.workspace))


class ModelProbeVerifyTests(unittest.TestCase):
    GATEWAY = {
        "id": "custom-gateway", "kind": "api_gateway", "base_url": "https://gw.example.com/v1", "host": "gw.example.com",
        "protocol": "chat-completions", "loopback": False, "credential_environment": "PROTO_GATEWAY_API_KEY", "model": "team/model-1",
    }

    def test_model_probe_uses_the_exact_model_route(self) -> None:
        opener = _FakeOpener(_FakeResponse(b'{"id": "claude-sonnet-5-5"}'))
        result = verify_provider("anthropic-api", approve_network=True, environ={"ANTHROPIC_API_KEY": FAKE_KEY}, model="claude-sonnet-5-5", opener=opener)
        self.assertEqual((result["ok"], result["category"], result["model_probe"]), (True, "ok", True))
        self.assertEqual(opener.requests[0].full_url, "https://api.anthropic.com/v1/models/claude-sonnet-5-5")
        self.assertEqual(result["metrics"]["network_requests"], 1)

    def test_missing_model_and_bad_credentials_are_typed(self) -> None:
        env = {"OPENAI_API_KEY": "tok_abcdefghijkl"}
        for code, expected in ((404, "model-not-found"), (401, "auth"), (500, "server-error")):
            error = urllib.error.HTTPError("https://api.openai.com/v1/models/x", code, "err", {}, io.BytesIO(b""))
            result = verify_provider("openai-api", approve_network=True, environ=env, model="gpt-x", opener=_FakeOpener(error))
            self.assertEqual((result["ok"], result["category"]), (False, expected), code)

    def test_transport_failures_are_timeout_or_network(self) -> None:
        env = {"OPENAI_API_KEY": "tok_abcdefghijkl"}
        timeout = verify_provider("openai-api", approve_network=True, environ=env, opener=_FakeOpener(urllib.error.URLError(TimeoutError("slow"))))
        self.assertEqual(timeout["category"], "timeout")
        refused = verify_provider("openai-api", approve_network=True, environ=env, opener=_FakeOpener(urllib.error.URLError(ConnectionRefusedError("no"))))
        self.assertEqual(refused["category"], "network")

    def test_manifest_cannot_redirect_an_official_provider(self) -> None:
        opener = _FakeOpener(_FakeResponse(b"{}"))
        tampered = {"id": "anthropic-api", "host": "evil.example.com", "base_url": "https://evil.example.com"}
        verify_provider("anthropic-api", approve_network=True, environ={"ANTHROPIC_API_KEY": FAKE_KEY}, config=tampered, opener=opener)
        self.assertEqual(opener.requests[0].full_url, "https://api.anthropic.com/v1/models")

    def test_remote_gateway_needs_the_exact_host_approval(self) -> None:
        env = {"PROTO_GATEWAY_API_KEY": "tok_abcdefghijkl"}
        opener = _FakeOpener(_FakeResponse(b"{}"))
        for approve in (None, "other.example.com"):
            result = verify_provider("custom-gateway", approve_network=True, environ=env, config=self.GATEWAY, approve_host=approve, opener=opener)
            self.assertEqual(result["code"], "HOST_NOT_APPROVED")
        self.assertEqual(opener.requests, [])
        ok = verify_provider("custom-gateway", approve_network=True, environ=env, config=self.GATEWAY, approve_host="gw.example.com", opener=opener)
        self.assertTrue(ok["ok"])
        request = opener.requests[0]
        self.assertEqual(request.full_url, "https://gw.example.com/v1/models/team%2Fmodel-1")
        self.assertEqual(request.get_header("Authorization"), "Bearer tok_abcdefghijkl")

    def test_gateway_without_the_models_route_is_incompatible_not_missing(self) -> None:
        error = urllib.error.HTTPError("https://gw.example.com/v1/models/m", 404, "nf", {}, io.BytesIO(b""))
        result = verify_provider("custom-gateway", approve_network=True, environ={"PROTO_GATEWAY_API_KEY": "tok_abcdefghijkl"},
                                 config=self.GATEWAY, approve_host="gw.example.com", opener=_FakeOpener(error))
        self.assertEqual(result["category"], "incompatible")

    def test_messages_protocol_uses_x_api_key(self) -> None:
        opener = _FakeOpener(_FakeResponse(b"{}"))
        config = {**self.GATEWAY, "protocol": "messages"}
        verify_provider("custom-gateway", approve_network=True, environ={"PROTO_GATEWAY_API_KEY": "tok_abcdefghijkl"}, config=config, approve_host="gw.example.com", opener=opener)
        self.assertEqual(opener.requests[0].get_header("X-api-key"), "tok_abcdefghijkl")
        self.assertIsNone(opener.requests[0].get_header("Authorization"))

    def test_keyless_loopback_gateway_sends_no_credential(self) -> None:
        config = {"id": "custom-gateway", "kind": "api_gateway", "base_url": "http://127.0.0.1:11434/v1", "host": "127.0.0.1",
                  "protocol": "chat-completions", "loopback": True, "model": "llama3"}
        opener = _FakeOpener(_FakeResponse(b"{}"))
        result = verify_provider("custom-gateway", approve_network=True, environ={}, config=config, opener=opener)
        self.assertTrue(result["ok"])
        self.assertEqual(opener.requests[0].full_url, "http://127.0.0.1:11434/v1/models/llama3")
        self.assertIsNone(opener.requests[0].get_header("Authorization"))

    def test_gateway_needs_stored_configuration(self) -> None:
        result = verify_provider("custom-gateway", approve_network=True, environ={}, config=None, opener=_FakeOpener(_FakeResponse(b"{}")))
        self.assertEqual(result["code"], "CONFIG_REQUIRED")


if __name__ == "__main__":
    unittest.main()
