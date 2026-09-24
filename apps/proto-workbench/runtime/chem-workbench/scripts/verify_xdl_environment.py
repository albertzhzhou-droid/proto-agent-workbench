"""Verify the standalone XDL parser without compiling or executing a procedure."""

import hashlib
import importlib.metadata as metadata
import json
from pathlib import Path

from xdl import XDL
from xdl.platforms import PlaceholderPlatform

output = Path(__file__).resolve().parents[1] / "build" / "xdl-environment"
output.mkdir(parents=True, exist_ok=True)
source = output / "input.xdl"
source.write_text(
    '<Synthesis><Hardware/><Reagents/><Procedure><Wait time="1 s"/></Procedure></Synthesis>',
    encoding="utf-8",
)
document = XDL(str(source), platform=PlaceholderPlatform)
assert len(document.steps) == 1 and document.steps[0].name == "Wait"
assert document.steps[0].time == 1.0 and not document.compiled
for extension, file_format in (("xdl", "xml"), ("json", "json")):
    exported = output / f"roundtrip.{extension}"
    document.save(str(exported), file_format=file_format)
    reopened = XDL(str(exported), platform=PlaceholderPlatform)
    assert len(reopened.steps) == 1 and reopened.steps[0].time == 1.0
    assert not reopened.compiled

dist = metadata.distribution("xdl")
report = {
    "version": dist.version,
    "source": json.loads(dist.read_text("direct_url.json")),
    "checks": {"import": True, "xml_roundtrip": True, "json_roundtrip": True},
    "platform": "PlaceholderPlatform",
    "compiled": False,
    "executed": False,
    "files": {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (source, output / "roundtrip.xdl", output / "roundtrip.json")
    },
    "distributions": sorted(
        [{"name": d.metadata["Name"], "version": d.version} for d in metadata.distributions()],
        key=lambda d: d["name"].lower(),
    ),
}
(output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps({k: v for k, v in report.items() if k != "distributions"}, indent=2))
