"""Generate browser-readable unit metadata from the existing Python authority."""
from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'src'))
from proto_agent.scientific_contracts import UNITS, COORDINATE_FRAMES

target = ROOT / 'apps/proto-workbench/src/shared/scientific-units.generated.json'
payload = json.dumps({
    'source': 'src/proto_agent/scientific_contracts.py',
    'units': {unit: {'dimension': definition[0], 'quantityKind': definition[1]} for unit, definition in UNITS.items()},
    'coordinateFrames': {frame: {'unit': definition[0], 'origin': definition[1]} for frame, definition in COORDINATE_FRAMES.items()},
}, indent=2, sort_keys=True) + '\n'
if '--check' in sys.argv:
    if not target.exists() or target.read_text(encoding='utf-8') != payload:
        raise SystemExit('Scientific unit metadata differs from the Python authority; run this generator.')
else:
    target.write_text(payload, encoding='utf-8')
