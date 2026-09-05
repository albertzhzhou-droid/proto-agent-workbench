#!/usr/bin/env python3
"""Crawl curated, reviewed UniProtKB/Swiss-Prot proteins into review evidence.

The candidates below are hand-curated design proteins (reporters, luciferases,
recombinases, and transcription regulators) that the protein compiler domain
can actually consume.  Each candidate is resolved through the public UniProt
REST API, must be a reviewed Swiss-Prot entry, and passes the same safety,
alphabet, length, and duplicate-sequence gates the promotion audit applies.

The tool also refreshes the three original seed entries whose local evidence
bytes were lost, so the retrieval receipt can be regenerated end to end.

Usage:
    python tools/crawl_uniprot_proteins.py --run [--repo PATH]
    python tools/crawl_uniprot_proteins.py --status [--repo PATH]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

import certifi


EVIDENCE_DIRECTORY = "materials/reviewed/source_responses/2026-09/uniprot/entries"
STATE_PATH = "materials/reviewed/uniprot_expansion_state_2026-09.jsonl"
MANIFEST_PATH = "materials/reviewed/protein_expansion_2026-09.json"
SEED_PATH = "materials/reviewed/protein_design_eligible_2026-09.json"
USER_AGENT = "Proto-Agent-Materials-Audit/2026.09 (+software-catalog-review)"
MAX_RESPONSE_BYTES = 2_000_000
REQUEST_INTERVAL_SECONDS = 1.5
MAX_ATTEMPTS = 4
PROTEIN_ALPHABET = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ*-")
MIN_LENGTH = 30
MAX_LENGTH = 3000
SAFETY_PATTERN = re.compile(
    r"(?:pathogen|virulence|toxin|toxic|antimicrobial resistance|antibiotic resistance|"
    r"drug resistance|clinical isolate|human pathogen|oncogenic|select agent|病原|毒力|毒素|"
    r"耐药|临床分离|人源病原)",
    re.IGNORECASE,
)
HEADER_KEYS = ("X-UniProt-Release", "X-UniProt-Release-Date", "X-API-Deployment-Date")

# Seed entries whose evidence files were removed from the working tree; they
# are refetched so the receipt can be rebuilt from current locked bytes.
REFRESH_ACCESSIONS = ("P42212", "Q9U6Y4", "Q9U6Y8")

# Curated design-protein candidates.  ``query`` drives the UniProt search;
# ``expect`` names the intended reviewed entry and is cross-checked against
# the fetched record before acceptance.  Descriptions are the human review
# layer and are intentionally authored here, not copied from upstream.
CANDIDATES: tuple[dict[str, Any], ...] = (
    {
        "key": "luci-firefly", "query": 'protein_name:"Luciferin 4-monooxygenase"', "expect": "LUCI_PHOPY",
        "aliases": ["firefly luciferase", "Luc"],
        "role_terms": ["reporter protein", "luminescence", "enzyme"],
        "description_en": "Photinus pyralis firefly luciferase sequence, retained as a reviewed luminescent reporter reference for software-level design composition.",
        "description_zh": "北美萤火虫荧光素酶序列；作为已审查的发光报告蛋白参考，用于软件层设计组合。",
    },
    {
        "key": "luci-renilla", "query": 'protein_name:"Coelenterazine h 2-monooxygenase"', "expect": "LUCI_RENRE",
        "aliases": ["Renilla luciferase", "Rluc"],
        "role_terms": ["reporter protein", "luminescence", "enzyme"],
        "description_en": "Renilla reniformis luciferase sequence, retained as a reviewed luminescent reporter reference for software-level design composition.",
        "description_zh": "海肾荧光素酶序列；作为已审查的发光报告蛋白参考，用于软件层设计组合。",
    },
    {
        "key": "luxa", "query": 'gene:luxA', "expect": "LUXA_VIBHA",
        "aliases": ["bacterial luciferase alpha chain", "LuxA"],
        "role_terms": ["reporter protein", "luminescence", "enzyme"],
        "description_en": "Vibrio harveyi bacterial luciferase alpha chain sequence, retained as a reviewed luminescent reporter reference for software-level design composition.",
        "description_zh": "哈维氏弧菌细菌荧光素酶 α 链序列；作为已审查的发光报告蛋白参考，用于软件层设计组合。",
    },
    {
        "key": "luxb", "query": 'gene:luxB', "expect": "LUXB_VIBHA",
        "aliases": ["bacterial luciferase beta chain", "LuxB"],
        "role_terms": ["reporter protein", "luminescence", "enzyme"],
        "description_en": "Vibrio harveyi bacterial luciferase beta chain sequence, retained as a reviewed luminescent reporter reference for software-level design composition.",
        "description_zh": "哈维氏弧菌细菌荧光素酶 β 链序列；作为已审查的发光报告蛋白参考，用于软件层设计组合。",
    },
    {
        "key": "aequorin", "query": 'protein_name:"Aequorin" AND organism_id:6100', "expect": "AEQ1_AEQVI",
        "aliases": ["aequorin", "calcium reporter photoprotein"],
        "role_terms": ["reporter protein", "calcium sensor", "photoprotein"],
        "description_en": "Aequorea victoria aequorin photoprotein sequence, retained as a reviewed calcium-indicator reporter reference for software-level design composition.",
        "description_zh": "维多利亚水母水母发光蛋白序列；作为已审查的钙指示报告蛋白参考，用于软件层设计组合。",
    },
    {
        "key": "cre", "query": 'protein_name:"Recombinase cre"', "expect": "RECR_BPP1",
        "aliases": ["Cre recombinase", "cyclization recombinase"],
        "role_terms": ["site-specific recombinase", "genome engineering tool", "enzyme"],
        "description_en": "Enterobacteria phage P1 Cre recombinase sequence, retained as a reviewed site-specific recombination tool reference for software-level design composition.",
        "description_zh": "P1 噬菌体 Cre 重组酶序列；作为已审查的位点特异性重组工具蛋白参考，用于软件层设计组合。",
    },
    {
        "key": "flp", "query": 'accession:P03870', "expect": "FLP_YEAST",
        "aliases": ["Flp recombinase", "flipping recombinase"],
        "role_terms": ["site-specific recombinase", "genome engineering tool", "enzyme"],
        "description_en": "Saccharomyces cerevisiae 2-micron plasmid Flp recombinase sequence, retained as a reviewed site-specific recombination tool reference for software-level design composition.",
        "description_zh": "酿酒酵母 2μ 质粒 Flp 重组酶序列；作为已审查的位点特异性重组工具蛋白参考，用于软件层设计组合。",
    },
    {
        "key": "ci-lambda", "query": 'protein_name:"Repressor protein CI"', "expect": "RPC1_LAMBD",
        "aliases": ["lambda cI repressor", "cI"],
        "role_terms": ["transcription regulator", "repressor protein", "gene regulation"],
        "description_en": "Enterobacteria phage lambda cI repressor sequence, retained as a reviewed regulator-protein reference that pairs with lambda cI-regulated promoters for software-level design composition.",
        "description_zh": "λ 噬菌体 cI 阻遏蛋白序列；作为已审查的调控蛋白参考，与受 cI 调控的 λ 启动子配对用于软件层设计组合。",
    },
    {
        "key": "arac", "query": 'protein_name:"Arabinose operon regulatory protein" AND organism_id:83333', "expect": "ARAC_ECOLI",
        "aliases": ["AraC", "arabinose operon regulator"],
        "role_terms": ["transcription regulator", "activator protein", "gene regulation"],
        "description_en": "Escherichia coli K-12 AraC regulatory protein sequence, retained as a reviewed regulator-protein reference that pairs with the PBAD promoter for software-level design composition.",
        "description_zh": "大肠杆菌 K-12 AraC 调控蛋白序列；作为已审查的调控蛋白参考，与 PBAD 启动子配对用于软件层设计组合。",
    },
    {
        "key": "luxr", "query": 'protein_name:"LuxR" AND organism_id:668', "expect": "LUXR_ALIFS",
        "aliases": ["LuxR", "quorum-sensing regulator"],
        "role_terms": ["transcription regulator", "quorum sensing", "gene regulation"],
        "description_en": "Aliivibrio fischeri LuxR transcriptional activator sequence, retained as a reviewed quorum-sensing regulator reference for software-level design composition.",
        "description_zh": "费氏弧菌 LuxR 转录激活因子序列；作为已审查的群体感应调控蛋白参考，用于软件层设计组合。",
    },
    {
        "key": "xyle", "query": 'protein_name:"Catechol 2,3-dioxygenase"', "expect": "NAHH_PSEPU",
        "aliases": ["XylE", "catechol 2,3-dioxygenase"],
        "role_terms": ["reporter protein", "colorimetric enzyme", "enzyme"],
        "description_en": "Pseudomonas putida XylE catechol 2,3-dioxygenase sequence, retained as a reviewed colorimetric reporter reference for software-level design composition.",
        "description_zh": "恶臭假单胞菌 XylE 儿茶酚 2,3-双加氧酶序列；作为已审查的比色报告酶参考，用于软件层设计组合。",
    },
    {
        "key": "lacz", "query": 'protein_name:"Beta-galactosidase" AND organism_id:83333', "expect": "BGAL_ECOLI",
        "aliases": ["LacZ", "beta-galactosidase"],
        "role_terms": ["reporter protein", "colorimetric enzyme", "enzyme"],
        "description_en": "Escherichia coli K-12 LacZ beta-galactosidase sequence, retained as a reviewed colorimetric reporter reference for software-level design composition.",
        "description_zh": "大肠杆菌 K-12 LacZ β-半乳糖苷酶序列；作为已审查的比色报告酶参考，用于软件层设计组合。",
    },
    {
        "key": "phoa", "query": 'protein_name:"Alkaline phosphatase" AND organism_id:83333', "expect": "PPB_ECOLI",
        "aliases": ["PhoA", "alkaline phosphatase"],
        "role_terms": ["reporter protein", "colorimetric enzyme", "enzyme"],
        "description_en": "Escherichia coli K-12 PhoA alkaline phosphatase sequence, retained as a reviewed colorimetric reporter reference for software-level design composition.",
        "description_zh": "大肠杆菌 K-12 PhoA 碱性磷酸酶序列；作为已审查的比色报告酶参考，用于软件层设计组合。",
    },
    {
        "key": "tevp", "query": 'protein_name:"Genome polyprotein" AND organism_id:12219', "expect": None,
        "skip": "TEV protease has no standalone reviewed Swiss-Prot entry; revisit if one is split out.",
        "aliases": [],
        "role_terms": [],
        "description_en": "",
        "description_zh": "",
    },
    {
        "key": "lexa", "query": 'protein_name:"LexA repressor" AND organism_id:83333', "expect": "LEXA_ECOLI",
        "aliases": ["LexA", "LexA repressor"],
        "role_terms": ["transcription regulator", "repressor protein", "gene regulation"],
        "description_en": "Escherichia coli K-12 LexA repressor sequence, retained as a reviewed SOS-response regulator reference for software-level design composition.",
        "description_zh": "大肠杆菌 K-12 LexA 阻遏蛋白序列；作为已审查的 SOS 应答调控蛋白参考，用于软件层设计组合。",
    },
    {
        "key": "crp", "query": 'protein_name:"CAMP receptor protein" AND organism_id:83333', "expect": "CRP_ECOLI",
        "aliases": ["CRP", "cAMP receptor protein", "CAP"],
        "role_terms": ["transcription regulator", "activator protein", "gene regulation"],
        "description_en": "Escherichia coli K-12 cAMP receptor protein (CRP) sequence, retained as a reviewed global regulator reference for software-level design composition.",
        "description_zh": "大肠杆菌 K-12 cAMP 受体蛋白（CRP）序列；作为已审查的全局调控蛋白参考，用于软件层设计组合。",
    },
)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _safe_relative(value: str) -> Path:
    pure = PurePosixPath(value)
    if not value or "\\" in value or pure.is_absolute() or ".." in pure.parts or value != pure.as_posix():
        raise ValueError(f"Unsafe repository-relative path: {value!r}")
    return Path(value)


class UniProtClient:
    def __init__(self) -> None:
        self._context = ssl.create_default_context(cafile=certifi.where())
        self._last = 0.0

    def get(self, url: str) -> tuple[bytes, str, str, dict[str, str]]:
        for attempt in range(MAX_ATTEMPTS):
            elapsed = time.time() - self._last
            if elapsed < REQUEST_INTERVAL_SECONDS:
                time.sleep(REQUEST_INTERVAL_SECONDS - elapsed)
            self._last = time.time()
            request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
            try:
                with urllib.request.urlopen(request, timeout=60, context=self._context) as response:
                    if response.status != 200 or response.geturl() != url:
                        raise ValueError(f"Unexpected response for {url}: {response.status} {response.geturl()}")
                    body = response.read(MAX_RESPONSE_BYTES + 1)
                    if not body or len(body) > MAX_RESPONSE_BYTES:
                        raise ValueError(f"Response size is invalid for {url}")
                    content_type = str(response.headers.get("Content-Type") or "").split(";", 1)[0].lower()
                    headers = {key: str(response.headers.get(key)) for key in HEADER_KEYS if response.headers.get(key)}
                    return body, content_type, _now(), headers
            except urllib.error.HTTPError as exc:
                if exc.code not in {429, 503} or attempt == MAX_ATTEMPTS - 1:
                    raise
                time.sleep(min(60.0, 2.0 ** (attempt + 1)))
            except (urllib.error.URLError, TimeoutError, OSError):
                if attempt == MAX_ATTEMPTS - 1:
                    raise
                time.sleep(5.0 * (attempt + 1))
        raise RuntimeError(f"Exhausted retries for {url}")


def _load_seed_sequence_digests(repo: Path) -> set[str]:
    digests: set[str] = set()
    path = repo / SEED_PATH
    if not path.is_file():
        return digests
    payload = json.loads(path.read_text(encoding="utf-8"))
    for record in payload.get("records", []):
        sequence = "".join(str(record.get("sequence") or "").upper().split())
        if sequence:
            digests.add(hashlib.sha256(sequence.encode("ascii")).hexdigest())
    return digests


def _load_state(repo: Path) -> dict[str, dict[str, Any]]:
    path = repo / STATE_PATH
    entries: dict[str, dict[str, Any]] = {}
    if not path.is_file():
        return entries
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            entry = json.loads(line)
            entries[str(entry.get("accession") or "")] = entry
    return entries


def _append_state(repo: Path, entry: dict[str, Any]) -> None:
    path = repo / STATE_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")


def _evaluate(detail: dict[str, Any], *, digests: set[str]) -> tuple[str, dict[str, Any]]:
    sequence_data = detail.get("sequence") if isinstance(detail.get("sequence"), dict) else {}
    organism = detail.get("organism") if isinstance(detail.get("organism"), dict) else {}
    description = detail.get("proteinDescription") if isinstance(detail.get("proteinDescription"), dict) else {}
    name_obj = description.get("recommendedName") if isinstance(description.get("recommendedName"), dict) else {}
    names = [str(name_obj.get("fullName") or "")]
    for obj in description.get("submissionNames", []) or []:
        if isinstance(obj, dict):
            names.append(str(obj.get("fullName") or ""))
    sequence = re.sub(r"\s+", "", str(sequence_data.get("value") or "")).upper()
    facts = {
        "accession": str(detail.get("primaryAccession") or ""),
        "entry_id": str(detail.get("uniProtkbId") or ""),
        "tax_id": organism.get("taxonId"),
        "sequence_length": len(sequence),
        "sequence_sha256": _sha256_bytes(sequence.encode("ascii")) if sequence else "",
        "upstream_names": [n for n in names if n],
    }
    if detail.get("entryType") != "UniProtKB reviewed (Swiss-Prot)":
        return "NOT_REVIEWED", facts
    if not facts["accession"] or not facts["entry_id"] or not isinstance(facts["tax_id"], int):
        return "IDENTITY_FIELDS_MISSING", facts
    if not sequence or not set(sequence) <= PROTEIN_ALPHABET:
        return "SEQUENCE_ALPHABET_INVALID", facts
    if not MIN_LENGTH <= len(sequence) <= MAX_LENGTH:
        return "SEQUENCE_LENGTH_OUT_OF_BOUNDS", facts
    upstream_text = " ".join([*names, str(organism.get("scientificName") or "")])
    if SAFETY_PATTERN.search(upstream_text):
        return "SAFETY_TEXT_FLAGGED", facts
    if facts["sequence_sha256"] in digests:
        return "SEQUENCE_DUPLICATE", facts
    digests.add(facts["sequence_sha256"])
    return "accepted", facts


def _resolve(client: UniProtClient, candidate: dict[str, Any]) -> tuple[str, str]:
    query = urllib.parse.urlencode({
        "query": f'({candidate["query"]}) AND reviewed:true',
        "format": "json",
        "fields": "accession,id,reviewed",
        "size": "10",
    })
    body, _, _, _ = client.get(f"https://rest.uniprot.org/uniprotkb/search?{query}")
    payload = json.loads(body.decode("utf-8"))
    results = payload.get("results", [])
    if not results:
        return "", ""
    if candidate.get("expect"):
        for item in results:
            if item.get("uniProtkbId") == candidate["expect"]:
                return str(item["primaryAccession"]), str(item["uniProtkbId"])
        return "", ""
    first = results[0]
    return str(first["primaryAccession"]), str(first["uniProtkbId"])


def _run(repo: Path) -> int:
    client = UniProtClient()
    state = _load_state(repo)
    digests = _load_seed_sequence_digests(repo)
    for entry in state.values():
        if entry.get("decision") == "accepted" and entry.get("sequence_sha256"):
            digests.add(entry["sequence_sha256"])
    for accession in REFRESH_ACCESSIONS:
        if accession in state:
            continue
        url = f"https://rest.uniprot.org/uniprotkb/{accession}.json"
        body, content_type, retrieved_at, headers = client.get(url)
        detail = json.loads(body.decode("utf-8"))
        # Refresh entries are the seed records themselves; dedupe only guards
        # NEW candidates against re-adding a sequence the seed already has.
        decision, facts = _evaluate(detail, digests=set())
        entry = {
            "accession": accession,
            "decision": decision if decision == "accepted" else "rejected",
            "refresh": True,
            "url": url,
            "retrieved_at": retrieved_at,
            "content_sha256": _sha256_bytes(body),
            "byte_count": len(body),
            "content_type": content_type,
            "response_headers": headers,
            **facts,
        }
        if decision != "accepted":
            entry["reason"] = decision
        _append_state(repo, entry)
        state[accession] = entry
        (repo / _safe_relative(f"{EVIDENCE_DIRECTORY}/{accession}.json")).write_bytes(body)
        print(f"refresh {accession}: {decision} ({facts.get('entry_id')})", flush=True)
    for candidate in CANDIDATES:
        if candidate.get("skip"):
            print(f"skip {candidate['key']}: {candidate['skip']}", flush=True)
            continue
        accession, entry_id = _resolve(client, candidate)
        if not accession:
            print(f"reject {candidate['key']}: no reviewed search hit", flush=True)
            continue
        if accession in state:
            continue
        url = f"https://rest.uniprot.org/uniprotkb/{accession}.json"
        body, content_type, retrieved_at, headers = client.get(url)
        detail = json.loads(body.decode("utf-8"))
        decision, facts = _evaluate(detail, digests=digests)
        entry = {
            "accession": accession,
            "candidate_key": candidate["key"],
            "decision": decision if decision == "accepted" else "rejected",
            "url": url,
            "retrieved_at": retrieved_at,
            "content_sha256": _sha256_bytes(body),
            "byte_count": len(body),
            "content_type": content_type,
            "response_headers": headers,
            **facts,
        }
        if decision != "accepted":
            entry["reason"] = decision
        _append_state(repo, entry)
        state[accession] = entry
        if decision == "accepted":
            (repo / _safe_relative(f"{EVIDENCE_DIRECTORY}/{accession}.json")).write_bytes(body)
        print(f"{candidate['key']}: {accession} {facts['entry_id']} -> {decision}", flush=True)
    candidates_by_key = {item["key"]: item for item in CANDIDATES}
    records = []
    for entry in state.values():
        key = entry.get("candidate_key")
        if entry.get("decision") != "accepted" or not key or key not in candidates_by_key:
            continue
        candidate = candidates_by_key[key]
        records.append({
            "accession": entry["accession"],
            "entry_id": entry.get("entry_id"),
            "tax_id": entry.get("tax_id"),
            "length": entry.get("sequence_length"),
            "sha256": entry.get("sequence_sha256"),
            "aliases": candidate["aliases"],
            "role_terms": candidate["role_terms"],
            "description_en": candidate["description_en"],
            "description_zh": candidate["description_zh"],
        })
    records = sorted(records, key=lambda item: item["accession"])
    manifest = {
        "schema_version": "proto-agent.materials.uniprot-expansion.v1",
        "generated_at": _now(),
        "record_count": len(records),
        "records": records,
    }
    path = repo / _safe_relative(MANIFEST_PATH)
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"manifest emitted with {len(records)} curated proteins", flush=True)
    return 0


def _status(repo: Path) -> int:
    state = _load_state(repo)
    accepted = sum(1 for entry in state.values() if entry.get("decision") == "accepted")
    print(f"state entries: {len(state)}; accepted: {accepted}")
    for accession, entry in sorted(state.items()):
        print(f"  {accession} {entry.get('entry_id') or '':16} {entry.get('decision')} {entry.get('reason') or ''}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--run", action="store_true", help="Resolve, fetch, verify, and emit the protein expansion manifest (resumable).")
    group.add_argument("--status", action="store_true", help="Print crawl progress from the state file.")
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    repo = args.repo.resolve()
    if args.status:
        return _status(repo)
    return _run(repo)


if __name__ == "__main__":
    raise SystemExit(main())
