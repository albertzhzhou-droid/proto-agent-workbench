"""Verify the completed frozen MCP runtime against deployed scientific backends.

Run only after build:sidecars finishes. This does not build or alter runtimes.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXECUTABLE = ROOT / "apps/proto-workbench/runtime/proto-agent/proto-agent-mcp/proto-agent-mcp.exe"
REPORT = ROOT / "build/chat-qa/packaged-runtime-acceptance.json"
OUTPUT = REPORT.parent / "packaged-runtime-acceptance"


def main() -> int:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    report = {"ok": False, "started_at": datetime.now(timezone.utc).isoformat(), "checks": []}
    environment = dict(os.environ)
    for name in tuple(environment):
        if name.startswith("PROTO_AGENT_SANDBOX_") or name in {"PYTHONPATH", "PYTHONHOME"}:
            environment.pop(name)
    environment["PROTO_WORKBENCH_WORKSPACE_ROOT"] = str(ROOT)

    def request(label: str, method: str, params: dict | None = None, timeout: int = 120) -> dict:
        input_file = OUTPUT / f"{label}-request.json"
        input_file.write_text(json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}), encoding="utf-8")
        result = subprocess.run([str(EXECUTABLE), "--once-file", input_file.relative_to(ROOT).as_posix()],
                                cwd=ROOT, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout, check=False, shell=False,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        (OUTPUT / f"{label}-stderr.txt").write_bytes(result.stderr)
        assert result.returncode == 0, f"{label}: frozen executable exited {result.returncode}: {result.stderr[-3000:]!r}"
        assert len(result.stdout) <= 8 * 1024 * 1024, f"{label}: oversized protocol response"
        payload = json.loads(result.stdout.decode("utf-8-sig"))
        (OUTPUT / f"{label}-response.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
        assert "error" not in payload, f"{label}: {payload.get('error')}"
        return payload["result"]

    def passed(name: str, **evidence):
        report["checks"].append({"name": name, "ok": True, **evidence})
        print(f"{name}: PASS", flush=True)

    try:
        assert EXECUTABLE.is_file(), "Build the frozen MCP runtime first."
        info = EXECUTABLE.stat()
        report["executable"] = {"path": EXECUTABLE.relative_to(ROOT).as_posix(), "sha256": hashlib.sha256(EXECUTABLE.read_bytes()).hexdigest(), "bytes": info.st_size,
                                "modified_at": datetime.fromtimestamp(info.st_mtime, timezone.utc).isoformat()}
        expected = {"proto_run_analysis", "proto_run_r", "proto_run_notebook", "proto_r_status", "proto_bioinformatics_catalog", "proto_bioinformatics_run"}
        tools = request("tools", "tools/list")["tools"]
        names = {tool["name"] for tool in tools}
        assert expected.issubset(names), f"Missing frozen tools: {expected - names}"
        passed("Frozen scientific tool discovery", tools=sorted(expected), total_tools=len(tools))

        capabilities = request("capabilities", "proto/capabilities")
        execution = capabilities["execution"]
        config = json.loads((ROOT / ".proto-agent/sandbox.json").read_text(encoding="utf-8-sig"))
        assert execution["mode"] == "oci" and execution["available"] is True, execution
        assert execution["provider"] == "docker-wsl" and execution["image"] == config["image"], execution
        assert execution["runtime_probe"]["daemon_reachable"] and execution["runtime_probe"]["image_present"], execution
        passed("Frozen live sandbox capability", execution=execution)

        fixture = OUTPUT / "analysis.py"
        fixture.write_text("import json, os\nfrom pathlib import Path\nimport numpy as np\n"
                           "x=np.array([2,4,6,8,10])\nassert os.geteuid()!=0\n"
                           "result={'mean':float(x.mean()),'sample_sd':float(x.std(ddof=1)),'uid':os.geteuid()}\n"
                           "Path(os.environ['PROTO_AGENT_RUN_DIR'],'statistics.json').write_text(json.dumps(result))\nprint(json.dumps(result))\n", encoding="utf-8")
        result = request("analysis", "tools/call", {"name": "proto_run_analysis", "arguments": {"script": fixture.relative_to(ROOT).as_posix(), "timeout": 60}})["structuredContent"]
        assert result["ok"] is True and result["sandboxed"] is True, result
        data = json.loads((ROOT / result["stdout_path"]).read_text(encoding="utf-8"))
        assert data["mean"] == 6 and abs(data["sample_sd"] - 3.1622776601683795) < 1e-12 and data["uid"] > 0, data
        assert any(path.endswith("statistics.json") for path in result["artifacts"]), result
        passed("Frozen MCP executes scientific Python", result=data, manifest_path=result["manifest_path"])

        bio = request("bio-catalog", "tools/call", {"name": "proto_bioinformatics_catalog", "arguments": {"probe": True}}, timeout=180)["structuredContent"]
        assert bio["ok"] is True and bio["operations"], bio
        assert all(operation["available"] is True and operation["runtime"]["checked"] is True for operation in bio["operations"]), bio
        passed("Frozen MCP probes installed WSL bioinformatics", operations=[{"id": operation["id"], "version": operation["runtime"].get("version")} for operation in bio["operations"]])
        report["ok"] = True
        return 0
    except Exception as exc:
        report["error"] = str(exc)
        print(f"FAIL: {exc}", flush=True)
        return 1
    finally:
        report["finished_at"] = datetime.now(timezone.utc).isoformat()
        REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"Report: {REPORT.relative_to(ROOT).as_posix()}", flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
