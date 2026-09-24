"""Linux process-group and scratch cleanup tests, also run explicitly in WSL."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from proto_agent.bioinformatics_worker import run


@unittest.skipUnless(os.name == "posix", "Linux worker process isolation is verified in WSL")
class WorkerIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="proto-bio-worker-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.job = self.root / "job"
        (self.job / "inputs").mkdir(parents=True)
        (self.job / "outputs").mkdir()
        (self.root / "bin").mkdir()
        manager = self.root / "bin/micromamba"
        manager.write_text("#!/usr/bin/python3\nimport os,sys\nos.execvp(sys.argv[4],sys.argv[4:])\n")
        manager.chmod(0o700)
        source = self.job / "inputs/variants.vcf"
        source.write_text("##fileformat=VCFv4.2\n")
        self.request = {"operation": "bcftools_stats", "arguments": {"variants": "unused.vcf"},
                        "files": {"variants": {"file": "inputs/variants.vcf", "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}}, "timeout_seconds": 10}

    def save_request(self):
        data = json.dumps(self.request).encode()
        (self.job / "worker-request.json").write_bytes(data)
        return hashlib.sha256(data).hexdigest()

    def test_changed_request_rejected_before_runtime(self):
        expected = self.save_request()
        (self.job / "worker-request.json").write_text("{}")
        with patch("proto_agent.bioinformatics_worker.probe") as probe:
            with self.assertRaisesRegex(ValueError, "changed after host validation"):
                run(self.root, self.job, expected)
            probe.assert_not_called()

    def test_changed_snapshot_rejected_and_owned_scratch_removed(self):
        expected = self.save_request()
        (self.job / "inputs/variants.vcf").write_text("changed")
        with patch("proto_agent.bioinformatics_worker.probe", return_value={"available": True}), \
             patch("proto_agent.bioinformatics_worker.plan") as plan:
            result = run(self.root, self.job, expected)
            plan.assert_not_called()
        self.assertFalse(result["ok"])
        self.assertIn("hash does not match", result["error"])
        self.assertEqual(list((self.root / "runs").iterdir()), [])

    def test_symlink_snapshot_rejected(self):
        source = self.job / "inputs/variants.vcf"
        source.unlink()
        outside = self.root / "outside.vcf"
        outside.write_text("outside")
        source.symlink_to(outside)
        expected = self.save_request()
        with patch("proto_agent.bioinformatics_worker.probe", return_value={"available": True}), \
             patch("proto_agent.bioinformatics_worker.plan") as plan:
            result = run(self.root, self.job, expected)
            plan.assert_not_called()
        self.assertFalse(result["ok"])
        self.assertIn("regular files", result["error"])
        self.assertEqual(outside.read_text(), "outside")

    def test_cancel_kills_parent_and_child_and_removes_scratch(self):
        expected = self.save_request()
        source = 'import json,os,subprocess,time; from pathlib import Path; child=subprocess.Popen(["/usr/bin/python3","-c","import time;time.sleep(60)"]); Path("children.json").write_text(json.dumps([os.getpid(),child.pid])); time.sleep(60)'
        stopped = threading.Event()
        def cancel_when_running():
            for _ in range(100):
                if list((self.root / "runs").glob("job-*/outputs/children.json")):
                    (self.job / "CANCEL").touch()
                    stopped.set()
                    return
                time.sleep(0.05)
        watcher = threading.Thread(target=cancel_when_running)
        watcher.start()
        try:
            with patch("proto_agent.bioinformatics_worker.probe", return_value={"available": True}), \
                 patch("proto_agent.bioinformatics_worker.plan", return_value=[(["/usr/bin/python3", "-c", source], None)]):
                result = run(self.root, self.job, expected)
        finally:
            watcher.join(timeout=6)
        self.assertTrue(stopped.is_set())
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "cancelled")
        for pid in json.loads((self.job / "outputs/children.json").read_text()):
            state = Path(f"/proc/{pid}/stat")
            self.assertTrue(not state.exists() or state.read_text().split()[2] == "Z", f"Process {pid} still running")
        self.assertEqual(list((self.root / "runs").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
