from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from proto_agent.execution import (
    ExecutionBroker, ExecutionDenied, ExecutionResult, SandboxConfig,
    _cleanup_container, build_oci_argv, public_execution_command,
    sandbox_configuration_from_environment, valid_wsl_configuration,
    windows_path_to_wsl, wsl_provider_prefix, probe_oci_provider,
)
from proto_agent.notebook import _notebook_runner, _validated_kernel, run_notebook
from proto_agent.security import SecurityBoundaryError


class WslExecutionTests(unittest.TestCase):
    def config(self, **changes):
        values = dict(provider="docker-wsl", image="quay.io/jupyter/r-notebook@sha256:" + "a" * 64,
                      wsl_distribution="Ubuntu-24.04", wsl_user="openclaw",
                      wsl_socket="unix:///run/user/1001/docker.sock", wsl_docker_path="/home/openclaw/bin/docker")
        return SandboxConfig(**(values | changes))

    def test_wsl_uses_argv_and_rejects_shell_remote_or_root_configuration(self):
        prefix = wsl_provider_prefix("wsl.exe", self.config())
        self.assertEqual(prefix, ["wsl.exe", "--distribution", "Ubuntu-24.04", "--user", "openclaw",
                                  "--exec", "/home/openclaw/bin/docker", "--host", "unix:///run/user/1001/docker.sock"])
        for changes in ({"wsl_user": "root"}, {"wsl_socket": "tcp://remote:2375"},
                        {"wsl_distribution": "Ubuntu; whoami"}, {"wsl_socket": "unix:///run/../docker.sock"},
                        {"wsl_docker_path": "/bin/sh"}, {"wsl_docker_path": "/home/x/../bin/docker"}):
            self.assertFalse(valid_wsl_configuration(self.config(**changes)))
            with self.assertRaises(ExecutionDenied):
                wsl_provider_prefix("wsl.exe", self.config(**changes))

    def test_windows_mounts_preserve_spaces_without_shell_interpolation(self):
        self.assertEqual(windows_path_to_wsl(r"C:\Users\pc\Documents\Proto CLI"), "/mnt/c/Users/pc/Documents/Proto CLI")
        for path in (r"\\host\share\x", r"C:\foo\..\bar", "relative.py", "C:\\comma,name"):
            with self.assertRaises(ExecutionDenied):
                windows_path_to_wsl(path)

    def test_cancel_cleanup_uses_same_distribution_user_socket(self):
        prefix = tuple(wsl_provider_prefix("wsl.exe", self.config()))
        with patch("proto_agent.execution.subprocess.run") as run:
            _cleanup_container(prefix, "proto-agent-12345678", env={"SystemRoot": r"C:\Windows"})
        self.assertEqual(run.call_args.args[0], [*prefix, "rm", "-f", "proto-agent-12345678"])
        self.assertFalse(run.call_args.kwargs["shell"])

    def test_live_probe_distinguishes_missing_daemon_image_and_controls(self):
        prefix = wsl_provider_prefix("wsl.exe", self.config())
        ready_info = SimpleNamespace(returncode=0, stdout=b"29.8.1|true|true|true", stderr=b"")
        present_image = SimpleNamespace(returncode=0, stdout=b"sha256:" + b"b" * 64, stderr=b"")
        with patch("proto_agent.execution.subprocess.run", side_effect=[ready_info, present_image]):
            self.assertTrue(probe_oci_provider(prefix, self.config().image)["ready"])
        with patch("proto_agent.execution.subprocess.run", return_value=SimpleNamespace(returncode=1, stdout=b"", stderr=b"daemon unavailable")):
            unavailable = probe_oci_provider(prefix, self.config().image)
            self.assertFalse(unavailable["ready"])
            self.assertFalse(unavailable["daemon_reachable"])
        with patch("proto_agent.execution.subprocess.run", side_effect=[ready_info, SimpleNamespace(returncode=1, stdout=b"", stderr=b"missing image")]):
            missing = probe_oci_provider(prefix, self.config().image)
            self.assertTrue(missing["daemon_reachable"])
            self.assertFalse(missing["image_present"])
            self.assertFalse(missing["ready"])
        with patch("proto_agent.execution.subprocess.run", return_value=SimpleNamespace(returncode=0, stdout=b"29.8.1|false|true|true", stderr=b"")) as run:
            limited = probe_oci_provider(prefix, self.config().image)
            self.assertFalse(limited["ready"])
            self.assertEqual(run.call_count, 1)

    def test_workspace_profile_loads_without_environment_and_rejects_unknown_fields(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            root = Path(directory)
            config_dir = root / ".proto-agent"
            config_dir.mkdir()
            payload = {"version": 1, "provider": "docker-wsl", "image": self.config().image,
                       "wslDistribution": "Ubuntu-24.04", "wslUser": "openclaw",
                       "wslSocket": "unix:///run/user/1001/docker.sock", "wslDockerPath": "/home/openclaw/bin/docker"}
            profile = config_dir / "sandbox.json"
            profile.write_text(json.dumps(payload), encoding="utf-8")
            with patch.object(Path, "cwd", return_value=root):
                found = sandbox_configuration_from_environment()
                self.assertEqual(found["wslDockerPath"], "/home/openclaw/bin/docker")
                broker = ExecutionBroker.from_environment(caller="mcp")
                self.assertEqual(broker.config.wsl_user, "openclaw")
                payload["unsafe_host"] = True
                profile.write_text(json.dumps(payload), encoding="utf-8")
                with self.assertRaises(ExecutionDenied):
                    sandbox_configuration_from_environment()

    @unittest.skipUnless(os.name == "nt", "Windows mounts are translated only for the Windows WSL provider")
    def test_wsl_argv_preserves_oci_limits_and_public_redaction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run_dir = root / "build" / "run"
            run_dir.mkdir(parents=True)
            script = root / "hello.py"
            script.write_text("print('hello')")
            command = build_oci_argv(executable="docker", provider="docker-wsl", image=self.config().image,
                runtime="python", script=script, args=["$(touch should-not-run)"], workspace=root,
                run_dir=run_dir, container_name="proto-agent-12345678", container_user="65532:65532")
            for value in ("--read-only", "--network", "none", "--cap-drop", "ALL", "--pids-limit",
                          "--memory", "--cpus", "--pull", "never", "65532:65532", "no-new-privileges=true"):
                self.assertIn(value, command)
            self.assertIn(f"type=bind,src={windows_path_to_wsl(root)},dst=/workspace,readonly", command)
            self.assertEqual(command[-1], "$(touch should-not-run)")
            public = public_execution_command(command, workspace=root, run_dir=run_dir)
            self.assertFalse(any(windows_path_to_wsl(root) in arg for arg in public))
            self.assertIn("type=bind,src=<run>,dst=/run", public)


class NotebookExecutionTests(unittest.TestCase):
    def test_only_installed_kernel_names_are_accepted(self):
        self.assertEqual(_validated_kernel({}), "python3")
        self.assertEqual(_validated_kernel({"metadata": {"kernelspec": {"name": "ir"}}}), "ir")
        with self.assertRaises(SecurityBoundaryError):
            _validated_kernel({"metadata": {"kernelspec": {"name": "shell"}}})
        compile(_notebook_runner("python3", 120), "notebook_runner.py", "exec")
        compile(_notebook_runner("ir", 120), "notebook_runner.py", "exec")

    def test_notebook_is_snapshotted_and_executed_in_broker_with_artifact_receipts(self):
        calls = []
        class Broker:
            def require_available(self):
                pass
            def execute(self, **kwargs):
                calls.append(kwargs)
                run_dir = kwargs["run_dir"]
                runner = kwargs["script"].read_text(encoding="utf-8")
                self_outer.assertIn("NotebookClient", runner)
                self_outer.assertNotIn("unexpected-marker", runner)
                raw = json.loads((run_dir / "input.ipynb").read_text(encoding="utf-8"))
                self_outer.assertIn("unexpected-marker", raw["cells"][0]["source"])
                (run_dir / "executed.ipynb").write_text(json.dumps(raw), encoding="utf-8")
                (run_dir / "executed.html").write_text("<html>result</html>", encoding="utf-8")
                return ExecutionResult("docker-wsl", ("wsl.exe",), 0, "completed", "", False, False, False)
        self_outer = self
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "test.ipynb").write_text(json.dumps({"nbformat": 4, "nbformat_minor": 5, "metadata": {},
                "cells": [{"cell_type": "code", "metadata": {}, "source": "open('unexpected-marker','w').close()",
                           "outputs": [], "execution_count": None}]}), encoding="utf-8")
            manifest, code = run_notebook("test.ipynb", workspace_root=root, broker=Broker())
            self.assertEqual(code, 0)
            self.assertTrue(manifest["sandboxed"])
            self.assertEqual(manifest["kernel"], "python3")
            self.assertIn(manifest["executed_notebook"], manifest["artifacts"])
            self.assertIn(manifest["html_path"], manifest["artifacts"])
            self.assertFalse((root / "unexpected-marker").exists())
            self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
