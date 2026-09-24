"""Deterministic software-only smoke checks for the isolated WSL bio tools."""
import json, os, pathlib, random, shutil, subprocess, sys, time

root = pathlib.Path(os.environ.get('PROTO_BIO_ROOT', str(pathlib.Path.home() / '.local/share/proto-bio')))
destination = pathlib.Path(sys.argv[1]).resolve()
out = root / 'qa' / ('base-' + str(time.time_ns()))
out.mkdir(parents=True, exist_ok=True)
mm = str(root / 'bin/micromamba')
results = []

def run(name, env, args, allowed=(0,), timeout=180):
    start = time.time()
    try:
        result = subprocess.run([mm, 'run', '-p', str(root / 'envs' / env), *args], cwd=out, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, text=True, errors='replace')
        text = result.stdout
        code = result.returncode
    except Exception as exc:
        text, code = str(exc), -1
    (out / f'{name}.log').write_text(text)
    results.append(dict(name=name, environment=env, argv=args, exit_code=code, passed=code in allowed, seconds=round(time.time()-start,2)))
    (out / 'verification.json').write_text(json.dumps(results, indent=2))
    print(name, 'PASS' if code in allowed else 'FAIL', code, flush=True)
    return text

run('gatk-version','variants',['gatk','--version'])
run('mutect2-help','variants',['gatk','Mutect2','--help'])
run('samtools-version','variants',['samtools','--version'])
run('bcftools-version','variants',['bcftools','--version'])
run('snpeff-version','variants',['snpEff','-version'])
run('lumpy-help','lumpy',['lumpy','-h'],allowed=(1,))
run('cnvkit-version','cnvkit',['cnvkit.py','version'])
run('prokka-version','prokka',['prokka','--version'])
run('prokka-databases','prokka',['prokka','--listdb'])
run('nucmer-version','mummer',['nucmer','--version'])
random.seed(418)
sequence = ''.join(random.choices('ACGT', k=3000))
(out/'toy.fa').write_text('>toy\n'+sequence+'\n')
(out/'toy-query.fa').write_text('>query\n'+sequence[200:2200]+'\n')
sam = ['@HD\tVN:1.6\tSO:coordinate','@SQ\tSN:toy\tLN:3000','@RG\tID:toy\tSM:toy\tPL:ILLUMINA']
for index in range(30):
    sam.append(f'read{index}\t0\ttoy\t{100+index*10}\t60\t100M\t*\t0\t0\t{sequence[99+index*10:199+index*10]}\t'+('I'*100)+'\tRG:Z:toy')
(out/'toy.sam').write_text('\n'.join(sam)+'\n')
run('samtools-sort','variants',['samtools','sort','-o','toy.bam','toy.sam'])
run('samtools-index','variants',['samtools','index','toy.bam'])
run('samtools-faidx','variants',['samtools','faidx','toy.fa'])
run('gatk-dictionary','variants',['gatk','CreateSequenceDictionary','-R','toy.fa','-O','toy.dict'])
run('mutect2-toy','variants',['gatk','Mutect2','-R','toy.fa','-I','toy.bam','-O','toy-mutect.vcf.gz','--max-reads-per-alignment-start','0'])
(out/'toy.vcf').write_text('##fileformat=VCFv4.2\n##contig=<ID=toy,length=3000>\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\ntoy\t101\t.\t'+sequence[100]+'\t'+next(b for b in 'ACGT' if b!=sequence[100])+'\t60\tPASS\t.\n')
run('bcftools-query','variants',['bcftools','query','-f','%CHROM\t%POS\t%REF\t%ALT\n','toy.vcf'])
run('nucmer-alignment','mummer',['nucmer','--prefix','toy-alignment','toy.fa','toy-query.fa'])
run('nucmer-coordinates','mummer',['show-coords','-rcl','toy-alignment.delta'])
(out/'deseq2-smoke.R').write_text('library(DESeq2)\nset.seed(418)\ncounts <- matrix(rnbinom(600, mu=50, size=10), ncol=6)\ncolnames(counts) <- paste0("s",1:6)\ncoldata <- data.frame(condition=factor(rep(c("A","B"), each=3)), row.names=colnames(counts))\ndds <- DESeqDataSetFromMatrix(counts, coldata, ~condition)\ndds <- DESeq(dds, quiet=TRUE)\nres <- results(dds)\nstopifnot(nrow(res)==100, all(is.finite(sizeFactors(dds))))\nwrite.csv(as.data.frame(res), "deseq2-results.csv")\ncat("DESeq2",as.character(packageVersion("DESeq2")), "100 genes; finite size factors\\n")\nsessionInfo()\n')
run('deseq2-calculation','deseq2',['Rscript','deseq2-smoke.R'])
print(json.dumps(results,indent=2))
shutil.copytree(out, destination, dirs_exist_ok=True)
sys.exit(0 if all(item['passed'] for item in results) else 1)
