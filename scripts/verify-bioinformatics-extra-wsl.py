"""Remaining engine calculations in a WSL path without spaces (MUMmer requirement)."""
import json, os, pathlib, shutil, subprocess, sys, time
root=pathlib.Path.home()/'.local/share/proto-bio'
source=pathlib.Path(sys.argv[1]).resolve()
out=root/'qa'/str(time.time_ns()); out.mkdir(parents=True)
for name in ['toy.fa','toy-query.fa','toy.vcf']:
    shutil.copy2(source/name,out/name)
mm=str(root/'bin/micromamba');results=[]
def run(name,env,args,allowed=(0,)):
    try:
        value=subprocess.run([mm,'run','-p',str(root/'envs'/env),*args],cwd=out,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,errors='replace',timeout=240)
        log,code=value.stdout,value.returncode
    except Exception as exc:log,code=str(exc),-1
    (out/(name+'.log')).write_text(log)
    results.append(dict(name=name,environment=env,argv=args,exit_code=code,passed=code in allowed))
    print(name,'PASS' if code in allowed else 'FAIL',code,flush=True)
    return log
run('lumpy-help','lumpy',['lumpy','-h'],allowed=(1,))
(out/'genome.txt').write_text('toy\t3000\n')
(out/'toy.bedpe').write_text('\n'.join(f'toy\t{100+i}\t{120+i}\ttoy\t{800+i}\t{820+i}\tread{i}\t60\t+\t-\tTYPE:DELETION' for i in range(6))+'\n')
variant=run('lumpy-bedpe','lumpy',['lumpy','-g','genome.txt','-mw','1','-msw','1','-bedpe','bedpe_file:toy.bedpe,id:toy,weight:1'])
assert '#CHROM' in variant and 'SVTYPE=DEL' in variant
run('nucmer-alignment','mummer',['nucmer','--prefix','alignment','toy.fa','toy-query.fa'])
coords=run('nucmer-coordinates','mummer',['show-coords','-rcl','alignment.delta'])
assert '100.00' in coords and '2000' in coords
run('prokka-annotation','prokka',['prokka','--outdir','prokka-toy','--prefix','toy','--cpus','1','--mincontiglen','200','toy.fa'])
(out/'segments.cns').write_text('chromosome\tstart\tend\tgene\tlog2\tprobes\n'+'toy\t0\t1000\tfixtureA\t0.0\t10\n'+'toy\t1000\t2000\tfixtureB\t-1.0\t10\n'+'toy\t2000\t3000\tfixtureC\t1.0\t10\n')
run('cnvkit-copy-number','cnvkit',['cnvkit.py','call','segments.cns','-o','called.cns'])
db=out/'snpeff-data/toy';db.mkdir(parents=True)
shutil.copy2(out/'toy.fa',db/'sequences.fa')
(db/'genes.gff').write_text('##gff-version 3\ntoy\tfixture\tgene\t1\t300\t.\t+\t.\tID=gene1;Name=toy_gene\ntoy\tfixture\tmRNA\t1\t300\t.\t+\t.\tID=tx1;Parent=gene1\ntoy\tfixture\texon\t1\t300\t.\t+\t.\tID=exon1;Parent=tx1\ntoy\tfixture\tCDS\t1\t300\t.\t+\t0\tID=cds1;Parent=tx1\n')
(out/'snpeff.config').write_text('toy.genome : Toy software fixture\n')
run('snpeff-build-toy','variants',['snpEff','build','-gff3','-noCheckCds','-noCheckProtein','-c','snpeff.config','-dataDir',str(out/'snpeff-data'),'toy'])
run('snpeff-annotation','variants',['snpEff','-noStats','-c','snpeff.config','-dataDir',str(out/'snpeff-data'),'toy','toy.vcf'])
(out/'verification-extra.json').write_text(json.dumps(results,indent=2))
shutil.copytree(out,source/'extra',dirs_exist_ok=True)
print(json.dumps(results,indent=2))
sys.exit(0 if all(item['passed'] for item in results) else 1)
