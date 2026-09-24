"""Verify installed engines on deterministic software fixtures and save a complete receipt."""
import json, pathlib, shutil, subprocess, sys
scripts = pathlib.Path(__file__).resolve().parent
destination = pathlib.Path(sys.argv[1]).resolve()
for name in ['verify-bioinformatics-wsl.py', 'verify-bioinformatics-extra-wsl.py']:
    subprocess.run([sys.executable, str(scripts / name), str(destination)], check=True)
root = pathlib.Path.home() / '.local/share/proto-bio'
shutil.copytree(root / 'locks', destination / 'environment-locks', dirs_exist_ok=True)
checks = json.loads((destination / 'verification.json').read_text()) + json.loads((destination / 'extra/verification-extra.json').read_text())
versions = {}
for environment in ['variants','lumpy','cnvkit','prokka','deseq2','mummer']:
    versions[environment] = []
    for package in (root / 'envs' / environment / 'conda-meta').glob('*.json'):
        metadata = json.loads(package.read_text())
        if metadata['name'] in ['gatk4','samtools','bcftools','snpeff','lumpy-sv','cnvkit','prokka','bioconductor-deseq2','r-base','mummer4']:
            versions[environment].append({k:metadata[k] for k in ['name','version','build']})
receipt = {'scope':'Synthetic software smoke checks, not biological validation','passed':all(item['passed'] for item in checks),'checks':len(checks),'installationRoot':str(root),'packages':versions,'results':checks}
(destination / 'summary.json').write_text(json.dumps(receipt, indent=2))
print(json.dumps({'passed':receipt['passed'],'checks':len(checks),'output':str(destination)}))
sys.exit(0 if receipt['passed'] else 1)
