"""Two live LM Studio proposals resolved identically to direct calls, then explicitly approved."""
from __future__ import annotations

import json
import argparse
import time
import uuid
from pathlib import Path

from chem_workbench.orchestrator import orchestrate
from chem_workbench.tool_gateway import invoke_tool
from chem_workbench.visualization import compile_snapshot
from chem_workbench.workflows import WorkflowService

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    destination = args.output or ROOT / ('build/model-execution-' + uuid.uuid4().hex + '.json')
    if destination.exists():
        raise ValueError('Refusing to overwrite prior model execution evidence')
    service = WorkflowService(destination.with_suffix(''))
    results = []
    for profile, relative, object_id, tool, objective in [
        ('water', 'molecules/water.chem', 'water', 'plan_water_single_point',
         'Prepare the bundled water installation geometry for HF/STO-3G review. Do not execute.'),
        ('copper', 'crystals/fcc-copper.chem', 'fcc_copper', 'plan_cu_lattice_scan',
         'Prepare fcc_copper at scales 0.98, 1.00, 1.02 for human review. Do not execute.'),
    ]:
        source = (ROOT / 'examples' / relative).read_text()
        attachments = {} if profile == 'water' else {
            'structures/fcc-copper.cif': (ROOT / 'examples/crystals/structures/fcc-copper.cif').read_text()
        }
        snapshot = compile_snapshot(source, attachments)
        record = orchestrate(objective, snapshot)
        directory = service.store.root / 'orchestrations'
        directory.mkdir(exist_ok=True)
        service.store._write(directory / (record['record_hash'][7:] + '.json'), record)
        outputs = [t for t in record['trace'] if t['action']['action'] == tool and t['output']['status'] == 'succeeded']
        assert outputs, record
        proposed = outputs[-1]['output']['data']
        arguments = {'object_id': object_id}
        if profile == 'copper':
            arguments['scale_factors'] = [0.98, 1.0, 1.02]
        direct = invoke_tool(tool, arguments, snapshot)['data']
        assert proposed == direct, 'model proposal differs from equivalent direct request'
        request = {'source': source, 'attachments': attachments, 'profile': profile, 'object_id': object_id}
        if profile == 'water':
            request['geometry'] = proposed['geometry']
        else:
            request.update(scales=[0.98, 1.0, 1.02], proposal=proposed)
        model_plan = service.prepare({**request, 'orchestration_ref': record['record_hash']})
        direct_request = dict(request)
        direct_request.pop('proposal', None)
        direct_plan = service.prepare(direct_request)
        assert model_plan['plan'] == direct_plan['plan']
        assert model_plan['orchestration_ref'] == record['record_hash']
        assert model_plan['reference'] != direct_plan['reference']
        reference = model_plan['reference']
        # This acceptance harness is the authorizing host actor; the model never receives the token.
        service.approve(reference, source, attachments)
        service.submit(reference)
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            finished = service.read(reference)
            if finished['state'] in {'succeeded', 'failed', 'cancelled'}:
                break
            time.sleep(0.2)
        assert finished['state'] == 'succeeded', finished
        results.append({'profile': profile, 'logical_parity': True, 'resolved_parity': True,
                        'exact_proposal_provenance': True, 'direct_approval_isolated': True,
                        'orchestration': record, 'workflow': finished})
        print(profile + ': live model/direct parity and real computation passed', flush=True)
    destination.write_text(json.dumps({'passed': True, 'cases': results}, indent=2))
    print(destination, flush=True)


if __name__ == '__main__':
    main()
