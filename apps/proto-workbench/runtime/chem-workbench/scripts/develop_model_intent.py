"""Development-only replay of already observed cases; never promotion evidence."""
from __future__ import annotations
import argparse
import json
import uuid
from pathlib import Path
from chem_workbench import orchestrator
from chem_workbench.visualization import compile_snapshot

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--suite', type=Path, required=True)
    parser.add_argument('--ids', default='')
    args = parser.parse_args()
    cases = json.loads(args.suite.read_text(encoding='utf-8'))['cases']
    selected = set(args.ids.split(',')) if args.ids else None
    destination = Path('build') / ('intent-development-' + uuid.uuid4().hex + '.jsonl')
    print(destination, flush=True)
    with destination.open('x', encoding='utf-8') as stream:
        for case in cases:
            if selected and case['id'] not in selected:
                continue
            try:
                record = orchestrator.orchestrate(case['objective'], compile_snapshot(case['source'], case['attachments']))
                action = record['model_action']
                passed = all(action[k] == case['expected'][k] for k in ('action', 'object_id', 'scale_factors'))
                passed = passed and (record['state'] == 'NEEDS_INPUT' if action['action'] == 'needs_input' else record['state'] == 'REPORTED')
                row = {'id':case['id'], 'passed':passed, 'expected':case['expected'], 'record':record}
            except Exception as error:
                row = {'id':case['id'], 'passed':False, 'error':str(error), 'provider_calls':orchestrator.MODEL_METRICS.calls}
            stream.write(json.dumps(row)+'\n')
            stream.flush()
            print(row['id'], row['passed'], row.get('record',{}).get('model_action', row.get('error')), flush=True)
if __name__ == '__main__':
    main()
