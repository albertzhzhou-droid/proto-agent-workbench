"""Real parser acceptance for the existing, separately installed Chem XDL runtime."""

import json
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "apps/proto-workbench/runtime/chem-integration/xdl-inspect.py"
PYTHON = Path(os.environ.get("CHEM_XDL_PYTHON", str(ROOT.parent / "Chem CLI/.chem-backends/xdl/Scripts/python.exe")))
FIXTURE = '<Synthesis><Hardware/><Reagents/><Procedure><Wait time="1 s"/></Procedure></Synthesis>'


@unittest.skipUnless(PYTHON.is_file(), "The existing standalone Chem XDL runtime is unavailable.")
class ChemXdlInspectionTests(unittest.TestCase):
    def inspect(self, request):
        completed = subprocess.run(
            [str(PYTHON), "-X", "utf8", str(HELPER)],
            input=json.dumps(request, ensure_ascii=False),
            text=True,
            encoding="utf-8",
            capture_output=True,
            timeout=30,
            check=True,
            cwd=ROOT,
        )
        result = json.loads(completed.stdout)
        self.assertFalse(result["compiled"])
        self.assertFalse(result["executed"])
        self.assertEqual(result["platform"], "PlaceholderPlatform")
        return result

    def test_actual_runtime_status(self):
        result = self.inspect({"action": "status"})
        self.assertTrue(result["available"])
        self.assertEqual(result["version"], "2.1.0")

    def test_xml_and_json_reopen_preserve_parsed_step(self):
        xml = self.inspect({"source": FIXTURE, "format": "xml"})
        self.assertTrue(xml["ok"], xml.get("error"))
        self.assertEqual(xml["counts"]["steps"], 1)
        self.assertEqual(xml["steps"][0]["name"], "Wait")
        self.assertEqual(float(xml["steps"][0]["properties"]["time"]), 1.0)
        self.assertTrue(xml["roundtrip"]["xml"]["equivalent"])
        self.assertTrue(xml["roundtrip"]["json"]["equivalent"])
        reopened = self.inspect({"source": xml["exports"]["json"], "format": "json"})
        self.assertTrue(reopened["ok"], reopened.get("error"))
        self.assertEqual(reopened["steps"][0]["properties"], xml["steps"][0]["properties"])

    def test_unicode_comment_roundtrip(self):
        fixture = FIXTURE.replace('time="1 s"', 'time="1 s" comment="解析样例 · Δ"')
        result = self.inspect({"source": fixture, "format": "xml"})
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["steps"][0]["properties"]["comment"], "解析样例 · Δ")

    def test_unknown_step_returns_upstream_error(self):
        fixture = FIXTURE.replace('<Wait time="1 s"/>', '<UnknownStep/>')
        result = self.inspect({"source": fixture, "format": "xml"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "XDLError")
        self.assertIn("not a valid step type", result["error"]["message"])
        self.assertNotIn("exports", result)

    def test_invalid_syntax_returns_parser_error(self):
        result = self.inspect({"source": "<Synthesis><Procedure>", "format": "xml"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "ParseError")

    def test_execution_request_is_not_an_operation(self):
        result = self.inspect({"source": FIXTURE, "format": "xml", "execute": True})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "ValueError")
        self.assertIn("only source and format", result["error"]["message"])

    def test_entity_declarations_are_rejected(self):
        result = self.inspect({"source": '<!DOCTYPE Synthesis [<!ENTITY a "A">]>' + FIXTURE, "format": "xml"})
        self.assertFalse(result["ok"])
        self.assertIn("entity declarations", result["error"]["message"])


if __name__ == "__main__":
    unittest.main()
