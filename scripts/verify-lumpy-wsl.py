import json, pathlib, shutil, subprocess, sys, time
root=pathlib.Path.home()/'.local/share/proto-bio'
out=root/'qa'/('lumpy-'+str(time.time_ns()));out.mkdir(parents=True)
(out/'genome.txt').write_text('toy\t3000\n')
(out/'toy.bedpe').write_text('\n'.join(f'toy\t{100+i}\t{120+i}\ttoy\t{800+i}\t{820+i}\tread{i}\t60\t+\t-\tTYPE:DELETION' for i in range(6))+'\n')
args=[str(root/'bin/micromamba'),'run','-p',str(root/'envs/lumpy'),'lumpy','-g','genome.txt','-mw','1','-msw','1','-bedpe','bedpe_file:toy.bedpe,id:toy,weight:1']
run=subprocess.run(args,cwd=out,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=60)
(out/'lumpy-result.vcf').write_text(run.stdout)
(out/'lumpy.log').write_text(run.stderr)
passed=run.returncode==0 and '#CHROM' in run.stdout and any(line and not line.startswith('#') for line in run.stdout.splitlines())
(out/'verification.json').write_text(json.dumps({'passed':passed,'exit_code':run.returncode,'argv':args},indent=2))
shutil.copytree(out,pathlib.Path(sys.argv[1])/'lumpy',dirs_exist_ok=True)
print(run.returncode,run.stdout[:1200],run.stderr[:1000], 'PASS' if passed else 'FAIL')
