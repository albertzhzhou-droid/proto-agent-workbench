"""Launch the unchanged Chem snapshot in its owned Proto working directory."""
from __future__ import annotations

import argparse
import hashlib
import json
import runpy
import sys
from datetime import datetime, timezone
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--root", required=True)
args = parser.parse_args()
root = Path(args.root).resolve()
sys.path.insert(0, str(root / "src"))

# The working-tree snapshot can contain newer implementation files than its
# generated registration. Rebuild only that derived file with Chem's own
# generator; scientific source, profiles, and approval rules remain unchanged.
registry = root / "src/chem_workbench/adapters/builtin-registry.json"
generator = root / "scripts/build_registry.py"
original_hash = hashlib.sha256(registry.read_bytes()).hexdigest()
namespace = runpy.run_path(str(generator), run_name="chem_integration_registry")
if namespace["main"]() != 0:
    raise SystemExit("CHEM_REGISTRATION_GENERATION_FAILED")
receipt = {
    "version": "chem-runtime-registration/v1",
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "sourceManifestHash": json.loads((root / "snapshot-manifest.json").read_text())["sourceManifestHash"],
    "originalRegistryHash": original_hash,
    "derivedRegistryHash": hashlib.sha256(registry.read_bytes()).hexdigest(),
    "generatorHash": hashlib.sha256(generator.read_bytes()).hexdigest(),
    "scope": "Regenerate the existing source-defined registration in the runtime copy only.",
    "approvalGranted": False,
}
(root / "runtime-registration-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
from chem_workbench import orchestrator  # noqa: E402
from model_binding import BASELINE_KEY, BASELINE_QUANTIZATION, install_model_binding  # noqa: E402

install_model_binding(orchestrator)
(root / "runtime-model-binding-receipt.json").write_text(json.dumps({
    "version": "chem-model-binding/v1",
    "configuredBaseline": BASELINE_KEY,
    "quantization": BASELINE_QUANTIZATION,
    "adapterSha256": hashlib.sha256((Path(__file__).parent / "model_binding.py").read_bytes()).hexdigest(),
    "availabilitySource": "Live LM Studio native /api/v1/models only",
    "approvalGranted": False,
}, indent=2) + "\n", encoding="utf-8")
from chem_workbench import web  # noqa: E402

if web.ROOT.resolve() != root:
    raise SystemExit("CHEM_RESOURCE_ROOT_MISMATCH")
sys.argv = ["chem_workbench.web", "--port", "0"]
web.main()
