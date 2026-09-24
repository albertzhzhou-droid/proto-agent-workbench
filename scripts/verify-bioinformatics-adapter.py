"""Exercise every typed Chat adapter against the installed engines and fixtures."""
from __future__ import annotations

import csv
import json
import random
import sys
import threading
from pathlib import Path

repository = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(repository / "src"))
from proto_agent.bioinformatics import bioinformatics_catalog, run_bioinformatics

destination = repository / "build/bioinformatics-adapter-qa"
destination.mkdir(parents=True, exist_ok=True)
base = "build/bioinformatics-qa/final"
relative = lambda file: file.relative_to(repository).as_posix()
random.seed(418)
with (destination / "counts.csv").open("w", newline="") as stream:
    writer = csv.writer(stream)
    writer.writerow(["gene", *[f"sample{i}" for i in range(6)]])
    for gene in range(100):
        mean = random.randint(20, 100)
        writer.writerow([f"gene{gene}", *[max(0, round(random.gauss(mean * (2 if gene < 15 and i >= 3 else 1), 10))) for i in range(6)]])
with (destination / "samples.csv").open("w", newline="") as stream:
    writer = csv.writer(stream)
    writer.writerow(["sample", "condition"])
    writer.writerows([(f"sample{i}", "control" if i < 3 else "treated") for i in range(6)])

jobs = {
    "samtools_sort_index": {"alignment": f"{base}/toy.sam"},
    "bcftools_stats": {"variants": f"{base}/toy.vcf"},
    "gatk_mutect2": {"reference": f"{base}/toy.fa", "tumor_bam": f"{base}/toy.bam"},
    "snpeff_annotate": {"variants": f"{base}/toy.vcf", "reference": f"{base}/toy.fa", "genes": f"{base}/extra/snpeff-data/toy/genes.gff"},
    "lumpy_bedpe": {"bedpe": f"{base}/extra/toy.bedpe", "chromosomes": f"{base}/extra/genome.txt"},
    "cnvkit_call": {"segments": f"{base}/extra/segments.cns"},
    "prokka_annotate": {"contigs": f"{base}/toy.fa"},
    "deseq2_fit": {"counts": relative(destination / "counts.csv"), "samples": relative(destination / "samples.csv"), "reference_level": "control", "comparison_level": "treated"},
    "nucmer_align": {"reference": f"{base}/toy.fa", "query": f"{base}/toy-query.fa"},
}

runtime = bioinformatics_catalog(probe=True)
(destination / "runtime.json").write_text(json.dumps(runtime, indent=2))
results = []
for operation, arguments in jobs.items():
    request = destination / (operation + ".json")
    request.write_text(json.dumps({"operation": operation, "arguments": arguments}, indent=2))
    result = run_bioinformatics(relative(request), workspace_root=repository)
    (destination / (operation + "-receipt.json")).write_text(json.dumps(result, indent=2))
    outputs = {Path(item["path"]).name: repository / item["path"] for item in result["artifacts"]}
    verified = bool(result["ok"])
    if verified and operation == "samtools_sort_index":
        verified = all(name in outputs for name in ("sorted.bam", "sorted.bam.bai", "flagstat.txt")) and "30 + 0 in total" in outputs["flagstat.txt"].read_text()
    elif verified and operation == "bcftools_stats":
        verified = "number of records:\t1" in outputs["variant-statistics.txt"].read_text()
    elif verified and operation == "gatk_mutect2":
        verified = all(name in outputs for name in ("unfiltered-variants.vcf.gz", "unfiltered-variants.vcf.gz.tbi"))
    elif verified and operation == "snpeff_annotate":
        verified = "ANN=" in outputs["annotated-variants.vcf"].read_text()
    elif verified and operation == "lumpy_bedpe":
        verified = "SVTYPE=DEL" in outputs["structural-variants.vcf"].read_text()
    elif verified and operation == "cnvkit_call":
        rows = list(csv.DictReader(outputs["called.cns"].read_text().splitlines(), delimiter="\t"))
        verified = [int(row["cn"]) for row in rows] == [2, 1, 4]
    elif verified and operation == "prokka_annotate":
        verified = all(name in outputs for name in ("annotation.gff", "annotation.gbk", "annotation.txt"))
    elif verified and operation == "deseq2_fit":
        rows = list(csv.DictReader(outputs["differential-expression.csv"].read_text().splitlines()))
        verified = len(rows) == 100 and "treated versus control" in outputs["comparison.txt"].read_text()
    elif verified and operation == "nucmer_align":
        verified = "100.00" in outputs["alignment-coordinates.txt"].read_text() and "2000" in outputs["alignment-coordinates.txt"].read_text()
    results.append({"operation": operation, "passed": verified, "status": result["status"], "manifest_path": result["manifest_path"], "error": result.get("error")})
    print(operation, "PASS" if verified else "FAIL", result["manifest_path"], flush=True)

event = threading.Event()
timer = threading.Timer(1.2, event.set)
timer.start()
try:
    result = run_bioinformatics(relative(destination / "deseq2_fit.json"), workspace_root=repository, cancel_event=event)
finally:
    timer.cancel()
(destination / "cancelled-receipt.json").write_text(json.dumps(result, indent=2))
results.append({"operation": "cancel_deseq2", "passed": not result["ok"] and result["status"] == "cancelled", "manifest_path": result["manifest_path"]})
summary = {"passed": all(item["passed"] for item in results), "checks": len(results), "scope": "Actual fixed adapter calls on synthetic software fixtures, not biological validation", "results": results}
(destination / "summary.json").write_text(json.dumps(summary, indent=2))
print(json.dumps(summary), flush=True)
raise SystemExit(0 if summary["passed"] else 1)
