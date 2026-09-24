"""Connector-gated remote capabilities adapted from Biomni's external wrappers.

Portions adapted from Biomni (Stanford SNAP), Apache License 2.0, commit
400c1f366b96a35ca253e13c9b06c5076af41d65. See
apps/proto-workbench/THIRD_PARTY_NOTICES.md and the packaged Apache license.

Every tool here is DISABLED until its connector is enabled in
connectors/remote_apis.json. Three connector kinds exist:

- http_api: fixed-host requests over stdlib urllib with timeouts and response
  size caps; no redirects to arbitrary hosts are followed silently.
- local_executable: whitelisted external programs invoked WITHOUT a shell
  (upstream used shell pipes; those steps are split or rejected), with
  timeouts and bounded captured output.
- data_lake: file-backed databases (DDInter) loaded from a configured root.

None of these tools run through the offline compute registry; they publish
their own artifacts under build/remote/ and are never auto-approved.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import urllib.parse
import urllib.request

CONNECTORS_FILE = "connectors/remote_apis.json"
HTTP_TIMEOUT_S = 30
HTTP_MAX_BYTES = 8 * 1024 * 1024
EXEC_TIMEOUT_S = 900
EXEC_MAX_OUTPUT = 8 * 1024 * 1024


class RemoteError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def load_connectors(workspace_root=".") -> dict:
    import pathlib

    path = pathlib.Path(workspace_root) / CONNECTORS_FILE
    if not path.is_file():
        return {}
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeError, ValueError):
        raise RemoteError("REMOTE_CONNECTOR_INVALID", f"{CONNECTORS_FILE} is not valid JSON.") from None
    return {entry.get("id"): entry for entry in document.get("connectors", []) if isinstance(entry, dict) and entry.get("id")}


def _connector(identifier, kind, connectors):
    entry = connectors.get(identifier)
    if entry is None:
        raise RemoteError("REMOTE_CONNECTOR_UNKNOWN", f"Connector {identifier!r} is not defined in {CONNECTORS_FILE}.")
    if entry.get("kind") != kind:
        raise RemoteError("REMOTE_CONNECTOR_KIND", f"Connector {identifier!r} is not a {kind} connector.")
    if not entry.get("enabled", False):
        raise RemoteError("REMOTE_CONNECTOR_DISABLED", f"Connector {identifier!r} is disabled; enable it explicitly in {CONNECTORS_FILE} after reviewing host/program access.")
    return entry


def _http_get(url, connectors, connector_id):
    entry = _connector(connector_id, "http_api", connectors)
    allowed_host = urllib.parse.urlparse(entry.get("endpoint", "")).hostname
    host = urllib.parse.urlparse(url).hostname
    if allowed_host and host != allowed_host and not (host or "").endswith("." + (allowed_host or "")):
        raise RemoteError("REMOTE_HOST_REJECTED", f"Request host {host!r} is outside connector {connector_id!r} ({allowed_host!r}).")
    request = urllib.request.Request(url, headers={"User-Agent": "proto-agent-remote/1.0", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_S) as response:
            body = response.read(HTTP_MAX_BYTES + 1)
    except urllib.error.HTTPError as error:
        raise RemoteError("REMOTE_HTTP_ERROR", f"HTTP {error.code} from {host}: {error.reason}.") from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise RemoteError("REMOTE_NETWORK_ERROR", f"Request to {host} failed: {error}.") from None
    if len(body) > HTTP_MAX_BYTES:
        raise RemoteError("REMOTE_RESPONSE_TOO_LARGE", "Response exceeds the connector byte cap.")
    return body


def _http_post_form(url, form, connectors, connector_id):
    entry = _connector(connector_id, "http_api", connectors)
    allowed_host = urllib.parse.urlparse(entry.get("endpoint", "")).hostname
    host = urllib.parse.urlparse(url).hostname
    if allowed_host and host != allowed_host:
        raise RemoteError("REMOTE_HOST_REJECTED", f"Request host {host!r} is outside connector {connector_id!r}.")
    data = urllib.parse.urlencode(form).encode()
    request = urllib.request.Request(url, data=data, headers={"User-Agent": "proto-agent-remote/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_S) as response:
            body = response.read(HTTP_MAX_BYTES + 1)
    except urllib.error.HTTPError as error:
        raise RemoteError("REMOTE_HTTP_ERROR", f"HTTP {error.code} from {host}: {error.reason}.") from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise RemoteError("REMOTE_NETWORK_ERROR", f"Request to {host} failed: {error}.") from None
    if len(body) > HTTP_MAX_BYTES:
        raise RemoteError("REMOTE_RESPONSE_TOO_LARGE", "Response exceeds the connector byte cap.")
    return body


def _run_program(program, arguments, connectors, connector_id, workspace_root="."):
    entry = _connector(connector_id, "local_executable", connectors)
    whitelisted = entry.get("programs", [])
    if program not in whitelisted:
        raise RemoteError("REMOTE_PROGRAM_REJECTED", f"Program {program!r} is not whitelisted on connector {connector_id!r}: {whitelisted}.")
    resolved = shutil.which(program)
    if resolved is None:
        raise RemoteError("REMOTE_PROGRAM_MISSING", f"{program!r} was not found on PATH; install it or extend PATH on the host.")
    try:
        completed = subprocess.run([resolved, *arguments], capture_output=True, text=True,
                                   timeout=entry.get("timeout_s", EXEC_TIMEOUT_S), cwd=str(workspace_root))
    except subprocess.TimeoutExpired:
        raise RemoteError("REMOTE_PROGRAM_TIMEOUT", f"{program} exceeded its time budget.") from None
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    if len(stdout.encode()) > EXEC_MAX_OUTPUT or len(stderr.encode()) > EXEC_MAX_OUTPUT:
        raise RemoteError("REMOTE_OUTPUT_TOO_LARGE", "Program output exceeds the connector byte cap.")
    return {"returncode": completed.returncode, "stdout": stdout, "stderr": stderr}


def _drug(name):
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100 or name.strip() != name:
        raise RemoteError("REMOTE_INVALID_ARGUMENT", "Drug names must be trimmed strings of at most 100 characters.")
    return name


def fda_drug_label(arguments, connectors):
    drug = _drug(arguments["drug_name"])
    body = _http_get(f"https://api.fda.gov/drug/label.json?limit=3&search=openfda.brand_name:{urllib.parse.quote(drug)}", connectors, "openfda")
    document = json.loads(body.decode("utf-8", "replace"))
    results = document.get("results", [])
    if not results:
        return {"ok": True, "drug": drug, "results": [], "message": "No label records matched the brand-name query."}
    summarized = []
    for record in results[:3]:
        summarized.append({"brand_names": record.get("openfda", {}).get("brand_name", [])[:5],
                           "manufacturer": (record.get("openfda", {}).get("manufacturer_name") or [None])[0],
                           "purpose": (record.get("purpose") or [None])[0],
                           "indications": ((record.get("indications_and_usage") or [""])[0])[:600],
                           "warnings": ((record.get("warnings") or [""])[0])[:600],
                           "effective_time": record.get("effective_time")})
    return {"ok": True, "drug": drug, "results": summarized,
            "limitations": ["openFDA label search matches brand names; generics need the generic_name field.",
                            "Truncated text fields favor review; consult the full label before clinical decisions."]}


def fda_drug_recalls(arguments, connectors):
    drug = _drug(arguments["drug_name"])
    classification = arguments.get("classification")
    query = f'search=brand_name:"{drug}"+product_type:"human"&limit=10'
    if classification in ("Class I", "Class II", "Class III"):
        query += f'+classification:"{classification}"'
    body = _http_get(f"https://api.fda.gov/drug/enforcement.json?{query}", connectors, "openfda")
    document = json.loads(body.decode("utf-8", "replace"))
    results = document.get("results", [])
    return {"ok": True, "drug": drug, "recall_count": len(results),
            "recalls": [{"classification": r.get("classification"), "reason": (r.get("reason_for_recall") or "")[:300],
                         "status": r.get("status"), "recall_initiation_date": r.get("recall_initiation_date"),
                         "city": r.get("city"), "state": r.get("state")} for r in results],
            "limitations": ["Recall records lag real-world enforcement; absence of records is not evidence of safety."]}


def fda_safety_signals(arguments, connectors):
    drugs = arguments.get("drug_list")
    if not isinstance(drugs, list) or not 2 <= len(drugs) <= 10:
        raise RemoteError("REMOTE_INVALID_ARGUMENT", "drug_list must contain 2 to 10 drug names.")
    drugs = [_drug(drug) for drug in drugs]
    per_drug = []
    for drug in drugs:
        body = _http_get(f"https://api.fda.gov/drug/event.json?limit=100&search=patient.drug.medicinalproduct:{urllib.parse.quote(drug)}", connectors, "openfda")
        document = json.loads(body.decode("utf-8", "replace"))
        reactions = {}
        for result in document.get("results", []):
            for reaction in result.get("patient", {}).get("reaction", []):
                term = reaction.get("reactionmeddrapt")
                if term:
                    reactions[term] = reactions.get(term, 0) + 1
        top = sorted(reactions.items(), key=lambda pair: -pair[1])[:10]
        per_drug.append({"drug": drug, "reports": document.get("meta", {}).get("results", 0),
                         "top_reactions": [{"term": term, "count": count} for term, count in top]})
    return {"ok": True, "drugs": per_drug,
            "limitations": ["FAERS reports are unverified spontaneous submissions; counts are raw reporting frequencies, not incidence rates.",
                            "Reporting bias, duplicate reports, and channeling make cross-drug comparisons descriptive only."]}


def jaspar_tfbs_scan(arguments, connectors):
    import re

    tf_name = _drug(arguments["tf_name"])
    sequence = arguments["sequence"].upper()
    if not isinstance(sequence, str) or not set(sequence) <= set("ACGTN") or not 20 <= len(sequence) <= 200000:
        raise RemoteError("REMOTE_INVALID_ARGUMENT", "sequence must be 20 to 200000 bases of A/C/G/T/N.")
    threshold = float(arguments.get("relative_threshold", 0.85))
    if not 0.5 <= threshold <= 1.0:
        raise RemoteError("REMOTE_INVALID_ARGUMENT", "relative_threshold must be between 0.5 and 1.0.")
    search = _http_get(f"https://jaspar.genereg.net/api/v1/matrix/?name={urllib.parse.quote(tf_name)}&tax_group=vertebrates", connectors, "jaspar")
    matches = json.loads(search.decode("utf-8", "replace")).get("results", [])
    if not matches:
        return {"ok": True, "tf_name": tf_name, "matrix_id": None, "sites": [], "message": "No JASPAR PWM matched the transcription-factor name."}
    matrix_id = matches[0]["matrix_id"]
    pfm_text = _http_get(f"https://jaspar.genereg.net/api/v1/matrix/{matrix_id}.pfm", connectors, "jaspar").decode()
    frequencies = [[float(value) for value in line.split()] for line in pfm_text.splitlines() if line.strip() and not line.startswith(">")]
    width = len(frequencies)
    scores = []
    for column in frequencies:
        total = sum(column) + 4 * 0.25  # 0.25 pseudocount per base, Bio.motifs convention.
        scores.append({base: math_log2((value + 0.25) / total * 4) for base, value in zip("ACGT", column)})
    def window_score(window):
        return sum(scores[offset][base] for offset, base in enumerate(window))
    max_score = sum(max(column.values()) for column in scores)
    min_score = sum(min(column.values()) for column in scores)
    sites = []
    for offset in range(len(sequence) - width + 1):
        window = sequence[offset:offset + width]
        if "N" in window:
            continue
        relative = (window_score(window) - min_score) / (max_score - min_score) if max_score > min_score else 0.0
        if relative >= threshold:
            sites.append({"position": offset + 1, "strand": "+", "sequence": window, "relative_score": round(relative, 6)})
    return {"ok": True, "tf_name": tf_name, "matrix_id": matrix_id, "motif_width": width,
            "relative_threshold": threshold, "sites": sites[:200],
            "limitations": ["One PWM per name (first vertebrates match); sibling matrices are not scanned.",
                            "Scores use a uniform-background log-odds with a 0.25 pseudocount; genomic background skews relative scores.",
                            "Predicted sites are sequence matches only; chromatin and cofactor context decide real occupancy."]}


def math_log2(value):
    import math

    return math.log2(value) if value > 0 else -12.0


def iupred_disorder(arguments, connectors):
    import re

    sequence = arguments["sequence"].upper()
    if not isinstance(sequence, str) or not set(sequence) <= set("ACDEFGHIKLMNPQRSTVWY") or not 20 <= len(sequence) <= 4000:
        raise RemoteError("REMOTE_INVALID_ARGUMENT", "sequence must be 20 to 4000 canonical amino-acid letters.")
    threshold = float(arguments.get("threshold", 0.5))
    if not 0 <= threshold <= 1:
        raise RemoteError("REMOTE_INVALID_ARGUMENT", "threshold must be between 0 and 1.")
    body = _http_post_form("https://iupred2a.elte.hu/iupred2a", {"seq": sequence, "iupred2": "long", "anchor2": "no"}, connectors, "iupred")
    scores = []
    for line in body.decode("utf-8", "replace").splitlines():
        if line.startswith("#") or not line.strip():
            continue
        parts = line.split()
        if len(parts) >= 3:
            try:
                scores.append((int(parts[0]), parts[1], float(parts[2])))
            except ValueError:
                continue
    if not scores:
        raise RemoteError("REMOTE_PROTOCOL_ERROR", "The IUPred2A response contained no score rows.")
    disordered = [score for score in scores if score[2] >= threshold]
    regions = []
    current = []
    for position, _residue, score in disordered:
        if current and position == current[-1] + 1:
            current.append(position)
        else:
            if len(current) > 1:
                regions.append([current[0], current[-1]])
            current = [position]
    if len(current) > 1:
        regions.append([current[0], current[-1]])
    return {"ok": True, "length": len(scores), "threshold": threshold,
            "disordered_residues": len(disordered), "disordered_percent": round(100 * len(disordered) / len(scores), 4),
            "disordered_regions": regions,
            "score_preview": [{"position": p, "residue": r, "score": s} for p, r, s in scores[:100]],
            "limitations": ["IUPred2 long-disorder mode via the public web service; service availability and throttling apply.",
                            "Region calls require at least two consecutive residues above threshold exactly as upstream."]}


def hmmer_fas_domains(arguments, connectors):
    sequence = arguments["sequence"].upper()
    if not isinstance(sequence, str) or not set(sequence) <= set("ACDEFGHIKLMNPQRSTVWY") or not 20 <= len(sequence) <= 4000:
        raise RemoteError("REMOTE_INVALID_ARGUMENT", "sequence must be 20 to 4000 canonical amino-acid letters.")
    body = _http_post_form("https://www.ebi.ac.uk/Tools/hmmer/search/hmmscan", {"hmmdb": "pfam", "seq": sequence}, connectors, "hmmer_web")
    try:
        document = json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        raise RemoteError("REMOTE_PROTOCOL_ERROR", "The HMMER service returned a non-JSON response.") from None
    hits = []
    for hit in document.get("results", {}).get("hits", []):
        for domain in hit.get("domains", [])[:3]:
            hits.append({"name": hit.get("name"), "description": hit.get("desc"), "score": domain.get("score"),
                         "start": domain.get("ali_from"), "end": domain.get("ali_to")})
    return {"ok": True, "hits": hits[:50],
            "limitations": ["hmmscan against Pfam via the EBI web service; submissions are queued and rate-limited.",
                            "Domain boundaries come from the alignment envelope; verify with the full HMMER report."]}


def ncbi_gene_cds(arguments, connectors):
    gene = _drug(arguments["gene_name"])
    organism = _drug(arguments["organism"])
    search = _http_get(f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=gene&retmode=json&retmax=5&term={urllib.parse.quote(organism)}[Organism]+AND+{urllib.parse.quote(gene)}[Gene]", connectors, "ncbi_entrez")
    identifiers = json.loads(search.decode("utf-8", "replace")).get("esearchresult", {}).get("idlist", [])
    if not identifiers:
        return {"ok": True, "gene_name": gene, "organism": organism, "sequences": [], "message": "No gene records matched."}
    summary = _http_get(f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=gene&retmode=json&id={identifiers[0]}", connectors, "ncbi_entrez")
    document = json.loads(summary.decode("utf-8", "replace"))
    record = document.get("result", {}).get(str(identifiers[0]), {})
    return {"ok": True, "gene_name": gene, "organism": organism, "gene_id": identifiers[0],
            "description": record.get("description"), "chromosome": record.get("chromosome"),
            "map_location": record.get("maplocation"),
            "other_names": record.get("otheraliases", "").split(",")[:5],
            "limitations": ["The summary flow returns gene metadata; nucleotide CDS downloads need a separate efetch on the linked RefSeq accession.",
                            "NCBI terms of service apply; set an API key for sustained use."]}


def ensembl_orthologs(arguments, connectors):
    genes = arguments.get("gene_list")
    if not isinstance(genes, list) or not 1 <= len(genes) <= 50 or any(not isinstance(g, str) or not g for g in genes):
        raise RemoteError("REMOTE_INVALID_ARGUMENT", "gene_list must contain 1 to 50 gene identifiers.")
    source = arguments.get("source_species", "human")
    target = arguments.get("target_species", "mouse")
    datasets = {"human": "hsapiens_gene_ensembl", "mouse": "mmusculus_gene_ensembl", "rat": "rnorvegicus_gene_ensembl",
                "zebrafish": "drerio_gene_ensembl", "chicken": "ggallus_gene_ensembl", "dog": "cfamiliaris_gene_ensembl"}
    if source not in datasets or target not in datasets:
        raise RemoteError("REMOTE_INVALID_ARGUMENT", f"Supported species: {', '.join(sorted(datasets))}.")
    attribute = datasets[target].split("_")[0] + "_homolog_ensembl_gene"
    query = ("<?xml version='1.0' encoding='UTF-8'?><!DOCTYPE Query><Query virtualSchemaName='default' formatter='TSV'>"
             f"<Dataset name='{datasets[source]}'/>"
             f"<Attribute name='ensembl_gene_id'/><Attribute name='{attribute}'/>"
             + "".join(f"<Filter name='ensembl_gene_id' value='{gene}'/>" for gene in genes[:20]) + "</Query>")
    body = _http_post_form("https://www.ensembl.org/biomart/martservice", {"query": query}, connectors, "ensembl_biomart")
    mapping = {}
    for line in body.decode("utf-8", "replace").splitlines():
        fields = line.split("\t")
        if len(fields) == 2 and fields[0] and fields[1]:
            mapping.setdefault(fields[0], []).append(fields[1])
    return {"ok": True, "source_species": source, "target_species": target,
            "requested": genes, "mapped": mapping,
            "unmapped": [gene for gene in genes if gene not in mapping],
            "limitations": ["One-to-many orthology collapses into lists; BioMart reports paralogues under some attributes.",
                            "The BioMart endpoint changes between Ensembl releases; refresh the connector if queries fail."]}


def muscle_alignment(arguments, connectors):
    fasta = arguments.get("fasta_path")
    if not isinstance(fasta, str) or not fasta.endswith((".fa", ".faa", ".fasta", ".txt")):
        raise RemoteError("REMOTE_INVALID_ARGUMENT", "fasta_path must reference a FASTA file in the workspace.")
    output = _run_program("muscle", ["-in", fasta, "-out", arguments.get("output_path", "aligned.fasta")], connectors, "muscle_exec")
    return {"ok": output["returncode"] == 0, "returncode": output["returncode"], "stdout_tail": output["stdout"][-2000:],
            "stderr_tail": output["stderr"][-2000:],
            "limitations": ["MUSCLE runs with default parameters; upstream used the same -in/-out interface.",
                            "Output lands in the working directory you name; no alignment statistics are parsed."]}


def macs2_peak_calling(arguments, connectors):
    treatment = arguments.get("treatment_path")
    control = arguments.get("control_path")
    for name, value in (("treatment_path", treatment), ("control_path", control)):
        if not isinstance(value, str) or not value.endswith((".bam", ".sam", ".bed", ".bed.gz")):
            raise RemoteError("REMOTE_INVALID_ARGUMENT", f"{name} must reference an alignment file in the workspace.")
    genome = arguments.get("genome_size", "hs")
    q_value = float(arguments.get("q_value", 0.05))
    name = arguments.get("run_name", "proto_run")
    output = _run_program("macs2", ["callpeak", "-t", treatment, "-c", control, "-n", name, "-g", genome, "-q", str(q_value)], connectors, "macs2_exec")
    return {"ok": output["returncode"] == 0, "returncode": output["returncode"], "stdout_tail": output["stdout"][-2000:],
            "stderr_tail": output["stderr"][-2000:],
            "limitations": ["Peak files are written next to the caller's working directory; count them with the region-overlap tool afterwards.",
                            "Upstream's fixed 300 s timeout is replaced by the connector's time budget."]}


def plasmid_annotation(arguments, connectors):
    fasta = arguments.get("fasta_path")
    if not isinstance(fasta, str) or not fasta.endswith((".fa", ".fasta", ".txt")):
        raise RemoteError("REMOTE_INVALID_ARGUMENT", "fasta_path must reference a plasmid FASTA file in the workspace.")
    linear = arguments.get("linear", False)
    argv = ["batch", "-i", fasta, "-f", "tsv", "--csv"]
    if not linear:
        argv.append("-l")
    output = _run_program("plannotate", argv, connectors, "plannotate_exec")
    return {"ok": output["returncode"] == 0, "returncode": output["returncode"], "stdout_tail": output["stdout"][-4000:],
            "stderr_tail": output["stderr"][-2000:],
            "limitations": ["pLannotate writes report files into its working directory; this wrapper reports program status only.",
                            "Feature confidence comes from pLannotate's databases, not from any Proto review."]}


def ddinter_check_combination(arguments, connectors):
    entry = _connector("ddinter_datalake", "data_lake", connectors)
    root = entry.get("datalake_root", "")
    import os

    def load(name):
        path = os.path.join(root, name)
        if not os.path.isfile(path):
            raise RemoteError("REMOTE_DATA_LAKE_MISSING", f"DDInter file {name} not found under the configured datalake root.")
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    drugs = arguments.get("drug_list")
    if not isinstance(drugs, list) or not 2 <= len(drugs) <= 20:
        raise RemoteError("REMOTE_INVALID_ARGUMENT", "drug_list must contain 2 to 20 drug names.")
    matrix = load("interaction_matrix.json")
    names = load("name_mapping.json")
    standardized = [names.get(drug.lower(), drug) for drug in drugs]
    interactions = []
    for index, first in enumerate(standardized):
        for second in standardized[index + 1:]:
            records = matrix.get(first, {}).get(second) or matrix.get(second, {}).get(first)
            if records:
                interactions.append({"drug_a": first, "drug_b": second, "interactions": records[:10]})
    major = sum(1 for pair in interactions for record in pair["interactions"] if record.get("level") == "Major")
    level = ("High Risk" if major else "Moderate Risk" if len(interactions) > 2 else "Low Risk" if interactions else "No known interactions")
    return {"ok": True, "checked": standardized,
            "unmapped": [drug for drug in drugs if names.get(drug.lower(), drug) == drug],
            "interactions": interactions, "major_count": major, "risk_level": level,
            "limitations": ["DDInter coverage is partial; unknown pairs are not evidence of safety.",
                            "Risk level mirrors upstream's counting heuristic, not a clinical assessment."]}


_SCHEMA = lambda properties, required: {"type": "object", "properties": properties, "required": required, "additionalProperties": False}
_STRING = {"type": "string", "minLength": 1, "maxLength": 200}

REMOTE_TOOLS = {
    "fda_drug_label": {"title": "openFDA drug label", "description": "Fetch summarized FDA drug-label sections for a brand name through the enabled openFDA connector.",
                       "input_schema": _SCHEMA({"drug_name": _STRING}, ["drug_name"]), "connector": "openfda", "handler": fda_drug_label,
                       "upstream": ["biomni/tool/pharmacology.py", "get_fda_drug_label_info"]},
    "fda_drug_recalls": {"title": "openFDA drug recalls", "description": "Query FDA drug enforcement and recall records through the enabled openFDA connector.",
                         "input_schema": _SCHEMA({"drug_name": _STRING,
                                                  "classification": {"type": "string", "enum": ["Class I", "Class II", "Class III"]}}, ["drug_name"]),
                         "connector": "openfda", "handler": fda_drug_recalls,
                         "upstream": ["biomni/tool/pharmacology.py", "check_fda_drug_recalls"]},
    "fda_safety_signals": {"title": "openFDA adverse-event signals", "description": "Compare raw FAERS adverse-event reporting frequencies across drugs through the openFDA connector.",
                           "input_schema": _SCHEMA({"drug_list": {"type": "array", "items": _STRING, "minItems": 2, "maxItems": 10}}, ["drug_list"]),
                           "connector": "openfda", "handler": fda_safety_signals,
                           "upstream": ["biomni/tool/pharmacology.py", "analyze_fda_safety_signals"]},
    "jaspar_tfbs_scan": {"title": "JASPAR TFBS scan", "description": "Fetch a JASPAR PWM by transcription-factor name and scan a supplied DNA sequence for binding sites.",
                         "input_schema": _SCHEMA({"tf_name": _STRING, "sequence": {"type": "string", "minLength": 20, "maxLength": 200000},
                                                  "relative_threshold": {"type": "number", "minimum": 0.5, "maximum": 1.0, "default": 0.85}}, ["tf_name", "sequence"]),
                         "connector": "jaspar", "handler": jaspar_tfbs_scan,
                         "upstream": ["biomni/tool/genetics.py", "identify_transcription_factor_binding_sites"]},
    "iupred_disorder": {"title": "IUPred2A disorder", "description": "Predict intrinsically disordered regions through the public IUPred2A web service.",
                        "input_schema": _SCHEMA({"sequence": {"type": "string", "minLength": 20, "maxLength": 4000},
                                                 "threshold": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.5}}, ["sequence"]),
                        "connector": "iupred", "handler": iupred_disorder,
                        "upstream": ["biomni/tool/biophysics.py", "predict_protein_disorder_regions"]},
    "hmmer_fas_domains": {"title": "HMMER Pfam domain scan", "description": "Submit a protein sequence to the EBI hmmscan web service and summarize Pfam domain hits.",
                          "input_schema": _SCHEMA({"sequence": {"type": "string", "minLength": 20, "maxLength": 4000}}, ["sequence"]),
                          "connector": "hmmer_web", "handler": hmmer_fas_domains,
                          "upstream": ["biomni/tool/synthetic_biology.py", "identify_fas_functional_domains"]},
    "ncbi_gene_cds": {"title": "NCBI gene lookup", "description": "Look up gene summaries through the NCBI Entrez connector (coding-sequence download stays a separate efetch step).",
                      "input_schema": _SCHEMA({"gene_name": _STRING, "organism": _STRING}, ["gene_name", "organism"]),
                      "connector": "ncbi_entrez", "handler": ncbi_gene_cds,
                      "upstream": ["biomni/tool/molecular_biology.py", "get_gene_coding_sequence"]},
    "ensembl_orthologs": {"title": "Ensembl ortholog conversion", "description": "Convert Ensembl gene identifiers to orthologues through the BioMart REST service.",
                          "input_schema": _SCHEMA({"gene_list": {"type": "array", "items": _STRING, "minItems": 1, "maxItems": 50},
                                                   "source_species": {"type": "string", "maxLength": 20, "default": "human"},
                                                   "target_species": {"type": "string", "maxLength": 20, "default": "mouse"}}, ["gene_list"]),
                          "connector": "ensembl_biomart", "handler": ensembl_orthologs,
                          "upstream": ["biomni/tool/genomics.py", "interspecies_gene_conversion"]},
    "muscle_alignment": {"title": "MUSCLE alignment", "description": "Run the whitelisted MUSCLE executable on a workspace FASTA file (no shell, connector-gated).",
                         "input_schema": _SCHEMA({"fasta_path": _STRING, "output_path": {"type": "string", "maxLength": 200, "default": "aligned.fasta"}}, ["fasta_path"]),
                         "connector": "muscle_exec", "handler": muscle_alignment,
                         "upstream": ["biomni/tool/genetics.py", "analyze_protein_phylogeny"]},
    "macs2_peak_calling": {"title": "MACS2 peak calling", "description": "Run the whitelisted MACS2 caller on treatment and control alignment files (connector-gated).",
                           "input_schema": _SCHEMA({"treatment_path": _STRING, "control_path": _STRING,
                                                    "genome_size": {"type": "string", "maxLength": 10, "default": "hs"},
                                                    "q_value": {"type": "number", "minimum": 1e-9, "maximum": 1, "default": 0.05},
                                                    "run_name": {"type": "string", "maxLength": 50, "default": "proto_run"}},
                                                   ["treatment_path", "control_path"]),
                           "connector": "macs2_exec", "handler": macs2_peak_calling,
                           "upstream": ["biomni/tool/genomics.py", "perform_chipseq_peak_calling_with_macs2"]},
    "plasmid_annotation": {"title": "pLannotate plasmid annotation", "description": "Run the whitelisted pLannotate CLI on a plasmid FASTA file (connector-gated).",
                           "input_schema": _SCHEMA({"fasta_path": _STRING, "linear": {"type": "boolean", "default": False}}, ["fasta_path"]),
                           "connector": "plannotate_exec", "handler": plasmid_annotation,
                           "upstream": ["biomni/tool/molecular_biology.py", "annotate_plasmid"]},
    "ddinter_check_combination": {"title": "DDInter combination safety", "description": "Check a drug combination against the DDInter data lake configured for this workspace.",
                                  "input_schema": _SCHEMA({"drug_list": {"type": "array", "items": _STRING, "minItems": 2, "maxItems": 20}}, ["drug_list"]),
                                  "connector": "ddinter_datalake", "handler": ddinter_check_combination,
                                  "upstream": ["biomni/tool/pharmacology.py", "check_drug_combination_safety"]},
}


def remote_catalog(tool: str | None = None) -> dict:
    connectors = load_connectors()
    entries = []
    for identifier, metadata in REMOTE_TOOLS.items():
        if tool is not None and tool != identifier:
            continue
        connector = connectors.get(metadata["connector"], {})
        entries.append({"id": identifier, "title": metadata["title"], "description": metadata["description"],
                        "input_schema": metadata["input_schema"], "connector": metadata["connector"],
                        "connector_status": ("enabled" if connector.get("enabled") else "disabled") if connector else "undefined",
                        "kind": connector.get("kind", "undefined"),
                        "upstream_functions": [{"path": metadata["upstream"][0], "name": metadata["upstream"][1]}]})
        if tool is None:
            entries[-1].pop("input_schema", None)
    return {"ok": True, "tools": entries, "count": len(entries),
            "scope": "Connector-gated network, executable, and data-lake capabilities; every connector starts disabled in connectors/remote_apis.json.",
            "usage": "Enable a connector in connectors/remote_apis.json, then run proto-agent remote run with a {tool, arguments} JSON file."}


def remote_run(request: dict, workspace_root=".") -> dict:
    if not isinstance(request, dict) or set(request) != {"tool", "arguments"}:
        raise RemoteError("REMOTE_INVALID_REQUEST", "A remote request must contain exactly tool and arguments.")
    identifier = request["tool"]
    if identifier not in REMOTE_TOOLS:
        raise RemoteError("REMOTE_UNKNOWN_TOOL", "Unknown remote capability; use remote catalog.")
    metadata = REMOTE_TOOLS[identifier]
    connectors = load_connectors(workspace_root)
    result = metadata["handler"](request["arguments"], connectors)
    return {**result, "tool": identifier, "connector": metadata["connector"],
            "upstream_functions": [{"path": metadata["upstream"][0], "name": metadata["upstream"][1]}],
            "review_status": "human_review_required"}
