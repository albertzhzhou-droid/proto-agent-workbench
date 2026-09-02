#!/usr/bin/env python3
"""Fetch, lock, and deterministically audit the small reviewed materials seed.

All upstream bytes are treated as untrusted evidence.  ``--fetch`` performs
bounded HTTPS GETs and stores exact responses plus a retrieval receipt.
``--from-evidence`` rebuilds the reviewed seeds, three-round audit, and source
lock without network access.  ``--check`` performs the same rebuild in memory
and fails if any checked-in output differs.
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
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

import certifi

from proto_agent.materials import PROTEIN_ALPHABET, canonical_license_id
from proto_agent.materials_promotion import audit_promotion_candidates


RECEIPT_SCHEMA = "proto-agent.materials-source-receipt.v1"
REVIEW_SCHEMA = "proto-agent.materials.reviewed.v1"
EVIDENCE_DIRECTORY = "materials/reviewed/source_responses/2026-09"
RECEIPT_PATH = f"{EVIDENCE_DIRECTORY}/retrieval-receipt.json"
IGEM_SEED_PATH = "materials/reviewed/igem_design_eligible_2026-09.json"
PROTEIN_SEED_PATH = "materials/reviewed/protein_design_eligible_2026-09.json"
AUDIT_PATH = "materials/reviewed/promotion_audit_2026-09.json"
SOURCE_LOCK_PATH = "materials/bundles/source-lock.json"
IGEM_LICENSE_API = "https://api.registry.igem.org/v1/licenses/"
UNIPROT_LICENSE_API = "https://rest.uniprot.org/help/license"
UNIPROT_LICENSE_PAGE = "https://www.uniprot.org/help/license"
MAX_RESPONSE_BYTES = 2_000_000
USER_AGENT = "Proto-Agent-Materials-Audit/2026.09 (+software-catalog-review)"


IGEM_PARTS: tuple[dict[str, Any], ...] = (
    {"uuid": "3c51179f-e370-4738-84b7-91773f750175", "name": "BBa_B0034", "part_type": "rbs", "role": "SO:0000139", "length": 12, "sha256": "c13f21d5d2147d1098e0915248ade426568ac037a2299f58faedbcb1fd156b55"},
    {"uuid": "f2171f1c-73c5-49ed-a466-b3a2c9ad9132", "name": "BBa_J23119", "part_type": "promoter", "role": "SO:0000167", "length": 35, "sha256": "30685375c37557d018a5d9615952cfe14e2a1d77750da24af2b68f9b3a7db6fa"},
    {"uuid": "a0ebeeab-3947-440e-9cf1-f0a47bbc4c33", "name": "BBa_B0015", "part_type": "terminator", "role": "SO:0000141", "length": 129, "sha256": "696c73e5a7a8819fe92177a8866f62fb5549c71284bf8f930854f26fae51318a"},
    {"uuid": "54457b65-1485-4665-92e4-b549d19c4ebe", "name": "BBa_25FAVHQY", "part_type": "cds", "role": "SO:0000316", "length": 717, "sha256": "d65530952b23612a7f7d3f66692f138f5316ad7efdd42695b8e30b084d246cd9"},
    {"uuid": "09c8558f-f976-4d04-bd8c-cfd7d8d2d7e2", "name": "BBa_25RT9PC8", "part_type": "promoter", "role": "SO:0000167", "length": 60, "sha256": "8e38878c49a3d2141666f8f1c8c8f20dfdf037e8210c3fc70e199a66d30c1a38"},
    {"uuid": "3e30ad4f-5360-49f7-bda4-60929b0f2971", "name": "BBa_B0030", "part_type": "rbs", "role": "SO:0000139", "length": 15, "sha256": "497c824d85114b3acbe93021466cf1999459f8271aaf6f53e9085a854b3b0b2b"},
    {"uuid": "a7a86504-1527-423b-8d1d-0c6fda1aacf9", "name": "BBa_B0031", "part_type": "rbs", "role": "SO:0000139", "length": 14, "sha256": "48ca6b2261599f393698a17e3c76a31d2194c6033be9bba4ef70c4cd6973c715"},
    {"uuid": "dd29b240-f03a-42ce-8612-6d562f74308e", "name": "BBa_B0032", "part_type": "rbs", "role": "SO:0000139", "length": 13, "sha256": "7480912e8220d0d9cf8135103da53e5deecb26686b7793cef00b876e0ac5db9b"},
    {"uuid": "843d0552-bcc1-4539-a678-7b3dae4c9849", "name": "BBa_B0033", "part_type": "rbs", "role": "SO:0000139", "length": 11, "sha256": "716bac8a7e5d9308884633edab58206b7c780f9e8a76be5470e86105b76c53ba"},
    {"uuid": "9b3b1fbd-1557-49a5-964a-7f8b491c9101", "name": "BBa_J23100", "part_type": "promoter", "role": "SO:0000167", "length": 35, "sha256": "b95f3c79165567c1bb4a5262e4c83503f313ac6a1970a57b4812e1f86d43644b"},
    {"uuid": "83c27e59-1d6f-4fe4-9f61-7b44034025b9", "name": "BBa_B0010", "part_type": "terminator", "role": "SO:0000141", "length": 80, "revision_date": "2021-09-08"},
    {"uuid": "8a1349a1-7bf2-4199-a79c-484de054629b", "name": "BBa_B0012", "part_type": "terminator", "role": "SO:0000141", "length": 41, "revision_date": "2021-09-08"},
    {"uuid": "64596782-8ede-4c91-9b8b-fb281f7c9bc6", "name": "BBa_B0013", "part_type": "terminator", "role": "SO:0000141", "length": 47, "revision_date": "2021-09-08"},
    {"uuid": "ee82e626-e0dd-434a-8c06-41a4120e6d9a", "name": "BBa_J23101", "part_type": "promoter", "role": "SO:0000167", "length": 35, "revision_date": "2021-09-08"},
    {"uuid": "960d257b-aa5b-4852-873c-2257858df041", "name": "BBa_J23102", "part_type": "promoter", "role": "SO:0000167", "length": 35, "revision_date": "2021-09-08"},
)

UNIPROT_RECORDS: tuple[dict[str, Any], ...] = (
    {
        "accession": "P42212", "entry_id": "GFP_AEQVI", "tax_id": 6100, "length": 238,
        "sha256": "44f2688342a00e4b01e82be5e655b26499f981515d5da9a6076315627355b403",
        "aliases": ["Aequorea victoria GFP", "green fluorescent protein"],
        "description_en": "Green fluorescent protein sequence from Aequorea victoria, retained as a reviewed reporter-protein reference for software-level design composition.",
        "description_zh": "来自维多利亚水母的绿色荧光蛋白序列；作为已审查的报告蛋白参考，用于软件层设计组合。",
    },
    {
        "accession": "Q9U6Y8", "entry_id": "RFP_DISSP", "tax_id": 86600, "length": 225,
        "sha256": "016abb252860c3952220cc3698048f23bc7983664b322b933a62df0b328e0301",
        "aliases": ["DsRed", "drFP583", "red fluorescent protein"],
        "description_en": "Red fluorescent protein drFP583 sequence from Discosoma sp., retained as a reviewed reporter-protein reference for software-level design composition.",
        "description_zh": "来自 Discosoma 属的红色荧光蛋白 drFP583 序列；作为已审查的报告蛋白参考，用于软件层设计组合。",
    },
    {
        "accession": "Q9U6Y4", "entry_id": "GFPL2_ZOASP", "tax_id": 105402, "length": 231,
        "sha256": "6de05b2c8ad5084018adf2cce4447ed8946d74a895446dd2a4ab8ff614c1ed49",
        "aliases": ["zFP538", "FP538", "green fluorescent chromoprotein"],
        "description_en": "GFP-like fluorescent chromoprotein FP538 sequence from Zoanthus sp., retained as a reviewed reporter-protein reference for software-level design composition.",
        "description_zh": "来自 Zoanthus 属的 GFP 类荧光色素蛋白 FP538 序列；作为已审查的报告蛋白参考，用于软件层设计组合。",
    },
)

IGEM_LICENSES = {
    "d6c69ca7-8be4-4bc0-b4a8-d3ae1d428aa6": "CC-BY-4.0",
    "5b2a6fd4-f5fa-4626-a37f-35f1ea89eec7": "CC0-1.0",
}
ROLE_LABELS = {
    "SO:0000139": "Ribosome Entry Site",
    "SO:0000167": "Promoter",
    "SO:0000316": "CDS",
    "SO:0000141": "Terminator",
}


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False) + "\n").encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_relative(value: str) -> str:
    path = PurePosixPath(value)
    if not value or "\\" in value or path.is_absolute() or ".." in path.parts or value != path.as_posix():
        raise ValueError(f"Unsafe repository-relative path: {value!r}")
    return value


def _read_json_bytes(value: bytes, *, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(value.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"Invalid JSON response for {label}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object for {label}")
    return payload


def _fetch_one(item: dict[str, str]) -> tuple[dict[str, Any], bytes]:
    request = urllib.request.Request(item["url"], headers={"Accept": item["accept"], "User-Agent": USER_AGENT})
    context = ssl.create_default_context(cafile=certifi.where())
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=45, context=context) as response:
                if response.status != 200 or response.geturl() != item["url"]:
                    raise ValueError(f"Unexpected response for {item['url']}: {response.status} {response.geturl()}")
                body = response.read(MAX_RESPONSE_BYTES + 1)
                if not body or len(body) > MAX_RESPONSE_BYTES:
                    raise ValueError(f"Response size is invalid for {item['url']}")
                content_type = str(response.headers.get("Content-Type") or "").split(";", 1)[0].lower()
                headers = {
                    key: str(response.headers.get(key))
                    for key in ("X-UniProt-Release", "X-UniProt-Release-Date", "X-API-Deployment-Date")
                    if response.headers.get(key)
                }
            break
        except urllib.error.HTTPError as exc:
            if exc.code not in {429, 503} or attempt == 3:
                raise
            retry_after = str(exc.headers.get("Retry-After") or "")
            delay = min(10.0, float(retry_after)) if retry_after.replace(".", "", 1).isdigit() else float(2 ** (attempt + 1))
            time.sleep(delay)
    expected_type = item["accept"].split(";", 1)[0]
    if expected_type == "application/json" and content_type != "application/json":
        raise ValueError(f"Expected JSON response for {item['url']}; received {content_type}")
    receipt = {
        "path": item["path"],
        "url": item["url"],
        "retrieved_at": _now(),
        "sha256": _sha256_bytes(body),
        "byte_count": len(body),
        "content_type": content_type,
        "response_headers": headers,
    }
    return receipt, body


def _fetch_plan() -> list[dict[str, str]]:
    plan: list[dict[str, str]] = []
    for item in IGEM_PARTS:
        uuid = item["uuid"]
        plan.append({
            "path": f"{EVIDENCE_DIRECTORY}/igem/parts/{uuid}.json",
            "url": f"https://api.registry.igem.org/v1/parts/{uuid}",
            "accept": "application/json",
        })
    for uuid in sorted(IGEM_LICENSES):
        plan.append({
            "path": f"{EVIDENCE_DIRECTORY}/igem/licenses/{uuid}.json",
            "url": f"{IGEM_LICENSE_API}{uuid}",
            "accept": "application/json",
        })
    for item in UNIPROT_RECORDS:
        accession = item["accession"]
        plan.append({
            "path": f"{EVIDENCE_DIRECTORY}/uniprot/entries/{accession}.json",
            "url": f"https://rest.uniprot.org/uniprotkb/{accession}.json",
            "accept": "application/json",
        })
    plan.append({
        "path": f"{EVIDENCE_DIRECTORY}/uniprot/license.json",
        "url": UNIPROT_LICENSE_API,
        "accept": "application/json",
    })
    return sorted(plan, key=lambda item: item["path"])


def fetch(repo: Path) -> None:
    plan = _fetch_plan()
    results: dict[str, tuple[dict[str, Any], bytes]] = {}
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="materials-audit") as pool:
        futures = {pool.submit(_fetch_one, item): item for item in plan}
        for future in as_completed(futures):
            item = futures[future]
            receipt, body = future.result()
            _read_json_bytes(body, label=item["url"])
            results[item["path"]] = (receipt, body)
    for relative in sorted(results):
        path = repo / _safe_relative(relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(results[relative][1])
    receipt = {
        "schema_version": RECEIPT_SCHEMA,
        "completed_at": _now(),
        "transport": "HTTPS GET with certificate validation via certifi; redirects and non-200 responses rejected.",
        "responses": [results[item["path"]][0] for item in plan],
    }
    receipt_path = repo / RECEIPT_PATH
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    receipt_path.write_bytes(_json_bytes(receipt))


def _load_receipt(repo: Path) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    path = repo / RECEIPT_PATH
    receipt = _read_json_bytes(path.read_bytes(), label=RECEIPT_PATH)
    if receipt.get("schema_version") != RECEIPT_SCHEMA or not isinstance(receipt.get("responses"), list):
        raise ValueError("Unsupported or malformed retrieval receipt")
    try:
        datetime.fromisoformat(str(receipt["completed_at"]).replace("Z", "+00:00"))
    except (KeyError, ValueError) as exc:
        raise ValueError("Receipt completion time is invalid") from exc
    responses: dict[str, dict[str, Any]] = {}
    for item in receipt["responses"]:
        if not isinstance(item, dict):
            raise ValueError("Receipt response entry is invalid")
        relative = _safe_relative(str(item.get("path") or ""))
        if relative in responses:
            raise ValueError(f"Duplicate receipt path: {relative}")
        evidence_path = repo / relative
        if evidence_path.is_symlink() or not evidence_path.is_file():
            raise ValueError(f"Evidence response is missing or unsafe: {relative}")
        body = evidence_path.read_bytes()
        if len(body) != int(item.get("byte_count", -1)) or _sha256_bytes(body) != str(item.get("sha256") or ""):
            raise ValueError(f"Evidence response does not match its receipt: {relative}")
        if str(item.get("url") or "") not in {entry["url"] for entry in _fetch_plan()}:
            raise ValueError(f"Receipt URL is not in the reviewed fetch plan: {item.get('url')}")
        responses[relative] = item
    expected = {item["path"] for item in _fetch_plan()}
    if set(responses) != expected:
        raise ValueError("Receipt response set does not match the reviewed fetch plan")
    return receipt, responses


def _response(repo: Path, responses: dict[str, dict[str, Any]], relative: str) -> tuple[dict[str, Any], dict[str, Any]]:
    receipt = responses[relative]
    payload = _read_json_bytes((repo / relative).read_bytes(), label=relative)
    return payload, receipt


def _source_evidence(record_receipt: dict[str, Any], license_receipt: dict[str, Any], *, license_id: str, license_url: str) -> dict[str, Any]:
    return {
        "record_response": {
            key: record_receipt[key] for key in ("path", "url", "retrieved_at", "sha256", "byte_count")
        },
        "license_response": {
            **{key: license_receipt[key] for key in ("path", "url", "retrieved_at", "sha256", "byte_count")},
            "declared_license_id": license_id,
            "declared_license_url": license_url,
        },
    }


def _igem_records(repo: Path, responses: dict[str, dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    records: list[dict[str, Any]] = []
    evidence: dict[str, dict[str, Any]] = {}
    for expected in IGEM_PARTS:
        uuid = expected["uuid"]
        relative = f"{EVIDENCE_DIRECTORY}/igem/parts/{uuid}.json"
        payload, receipt = _response(repo, responses, relative)
        role = payload.get("role") if isinstance(payload.get("role"), dict) else {}
        topology = payload.get("topology") if isinstance(payload.get("topology"), dict) else {}
        audit = payload.get("audit") if isinstance(payload.get("audit"), dict) else {}
        sequence = re.sub(r"\s+", "", str(payload.get("sequence") or "")).upper()
        sequence_sha256 = _sha256_bytes(sequence.encode("ascii")) if sequence else ""
        revision = str(audit.get("updated") or "")
        if (
            payload.get("uuid") != uuid
            or payload.get("name") != expected["name"]
            or str(payload.get("status") or "").lower() != "published"
            or role.get("accession") != expected["role"]
            or topology.get("accession") != "SO:0000987"
            or not sequence
            or not set(sequence) <= set("ACGTRYSWKMBDHVN")
            or len(sequence) != expected["length"]
            or (expected.get("sha256") and sequence_sha256 != expected["sha256"])
            or (expected.get("revision_date") and not revision.startswith(expected["revision_date"]))
        ):
            raise ValueError(f"iGEM identity, sequence, ontology, topology, or publication invariant failed: {uuid}")
        license_uuid = str(payload.get("licenseUUID") or "")
        if license_uuid not in IGEM_LICENSES:
            raise ValueError(f"Unreviewed iGEM license UUID for {uuid}: {license_uuid}")
        license_relative = f"{EVIDENCE_DIRECTORY}/igem/licenses/{license_uuid}.json"
        license_payload, license_receipt = _response(repo, responses, license_relative)
        license_id = canonical_license_id(license_payload.get("spdxID"))
        license_url = str(license_payload.get("url") or "").rstrip("/")
        if (
            license_payload.get("uuid") != license_uuid
            or license_id != IGEM_LICENSES[license_uuid]
            or license_url not in {
                "https://creativecommons.org/licenses/by/4.0/legalcode",
                "https://creativecommons.org/publicdomain/zero/1.0/legalcode",
            }
        ):
            raise ValueError(f"iGEM license response invariant failed: {license_uuid}")
        resource_id = f"igem:{uuid}"
        role_label = ROLE_LABELS[expected["role"]]
        record = {
            "resource_id": resource_id,
            "kind": "genetic_part",
            "name": expected["name"],
            "aliases": [],
            "description_en": f"Published iGEM Registry DNA {expected['part_type']} record {expected['name']}, retained for software-only design composition after controlled catalog review.",
            "description_zh": f"已发布的 iGEM Registry DNA {role_label} 记录 {expected['name']}；经受控目录审核后，仅用于软件层设计组合。",
            "chassis": ["ecoli_k12"],
            "role_terms": [role_label],
            "part_type": expected["part_type"],
            "sequence": sequence,
            "sequence_sha256": sequence_sha256,
            "sequence_kind": "DNA",
            "source": {
                "provider": "iGEM Registry",
                "record_id": uuid,
                "revision": revision,
                "release": revision,
                "url": receipt["url"],
                "retrieved_at": receipt["retrieved_at"],
                "content_sha256": receipt["sha256"],
                "sequence_sha256": sequence_sha256,
            },
            "license": {
                "id": license_id,
                "url": license_url,
                "attribution": "iGEM Registry contributor",
                "rights_notes": (
                    "The declared Creative Commons Attribution license permits redistribution with attribution. "
                    if license_id == "CC-BY-4.0"
                    else "The declared CC0 dedication permits redistribution and reuse. "
                ) + "Chassis is a local software compatibility annotation because upstream chassis fields are empty.",
                "redistribution_status": "REDISTRIBUTABLE",
            },
            "evidence_refs": [receipt["url"], license_receipt["url"]],
            "review_status": "DESIGN_ELIGIBLE",
            "safety_status": "NO_FLAG",
            "design_eligibility": True,
            "metadata": {
                "registry_status": "published",
                "role_accession": expected["role"],
                "chassis_basis": "controlled_review_software_annotation",
            },
        }
        records.append(record)
        evidence[resource_id] = _source_evidence(
            receipt,
            license_receipt,
            license_id=license_id,
            license_url=license_url,
        )
    return records, evidence


def _uniprot_records(repo: Path, responses: dict[str, dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    license_relative = f"{EVIDENCE_DIRECTORY}/uniprot/license.json"
    license_payload, license_receipt = _response(repo, responses, license_relative)
    content = str(license_payload.get("content") or "")
    if license_payload.get("id") != "license" or "CC BY 4.0" not in content or "patent" not in content.lower():
        raise ValueError("UniProt license/disclaimer response did not contain the reviewed rights assertions")
    records: list[dict[str, Any]] = []
    evidence: dict[str, dict[str, Any]] = {}
    for expected in UNIPROT_RECORDS:
        accession = expected["accession"]
        relative = f"{EVIDENCE_DIRECTORY}/uniprot/entries/{accession}.json"
        payload, receipt = _response(repo, responses, relative)
        sequence_data = payload.get("sequence") if isinstance(payload.get("sequence"), dict) else {}
        audit = payload.get("entryAudit") if isinstance(payload.get("entryAudit"), dict) else {}
        organism = payload.get("organism") if isinstance(payload.get("organism"), dict) else {}
        sequence = re.sub(r"\s+", "", str(sequence_data.get("value") or "")).upper()
        sequence_sha256 = _sha256_bytes(sequence.encode("ascii")) if sequence else ""
        if (
            payload.get("primaryAccession") != accession
            or payload.get("uniProtkbId") != expected["entry_id"]
            or payload.get("entryType") != "UniProtKB reviewed (Swiss-Prot)"
            or organism.get("taxonId") != expected["tax_id"]
            or not sequence
            or not set(sequence) <= PROTEIN_ALPHABET
            or int(sequence_data.get("length", -1)) != expected["length"]
            or len(sequence) != expected["length"]
            or sequence_sha256 != expected["sha256"]
            or not isinstance(audit.get("entryVersion"), int)
            or not isinstance(audit.get("sequenceVersion"), int)
        ):
            raise ValueError(f"UniProt identity, reviewed status, or sequence invariant failed: {accession}")
        release = str((receipt.get("response_headers") or {}).get("X-UniProt-Release") or "")
        if not re.fullmatch(r"20\d{2}_\d{2}", release):
            raise ValueError(f"UniProt release header is missing for {accession}")
        resource_id = f"uniprot:{accession}"
        license_id = "CC-BY-4.0"
        license_url = "https://creativecommons.org/licenses/by/4.0"
        record = {
            "resource_id": resource_id,
            "kind": "protein_sequence",
            "name": expected["entry_id"],
            "aliases": expected["aliases"],
            "description_en": expected["description_en"],
            "description_zh": expected["description_zh"],
            "organism": {
                "tax_id": expected["tax_id"],
                "name": str(organism.get("scientificName") or ""),
                "strain": "",
            },
            "role_terms": ["fluorescent protein", "reporter protein", "visualization"],
            "sequence_kind": "PROTEIN",
            "sequence": sequence,
            "sequence_sha256": sequence_sha256,
            "source": {
                "provider": "UniProtKB/Swiss-Prot",
                "record_id": accession,
                "revision": f"entry-version-{audit['entryVersion']};sequence-version-{audit['sequenceVersion']}",
                "release": release,
                "url": receipt["url"],
                "retrieved_at": receipt["retrieved_at"],
                "content_sha256": receipt["sha256"],
                "sequence_sha256": sequence_sha256,
            },
            "license": {
                "id": license_id,
                "url": license_url,
                "attribution": "UniProt Consortium",
                "rights_notes": "UniProt applies CC BY 4.0 to copyrightable database content and notes that patent or other third-party rights may still apply.",
                "redistribution_status": "REDISTRIBUTABLE",
            },
            "evidence_refs": [receipt["url"], UNIPROT_LICENSE_PAGE],
            "review_status": "DESIGN_ELIGIBLE",
            "safety_status": "NO_FLAG",
            "design_eligibility": True,
            "metadata": {
                "reviewed_record": True,
                "entry_length": expected["length"],
                "eligibility_basis": "controlled software-catalog review 2026-09; exact accession and sequence digest locked",
            },
        }
        records.append(record)
        evidence[resource_id] = _source_evidence(
            receipt,
            license_receipt,
            license_id=license_id,
            license_url=license_url,
        )
    return records, evidence


def _build_outputs(repo: Path) -> dict[str, bytes]:
    receipt, responses = _load_receipt(repo)
    igem_records, igem_evidence = _igem_records(repo, responses)
    protein_records, protein_evidence = _uniprot_records(repo, responses)
    evidence = {**igem_evidence, **protein_evidence}
    generated_at = str(receipt["completed_at"])
    audit = audit_promotion_candidates(
        [*igem_records, *protein_records],
        generated_at=generated_at,
        source_evidence=evidence,
    )
    if audit["candidate_count"] != 18 or audit["pass_count"] != 18 or audit["fail_count"] != 0:
        failed = [item["resource_id"] for item in audit["candidates"] if item["decision"] != "PASS"]
        raise ValueError(f"Promotion audit failed closed; no reviewed seed was advanced: {failed}")
    igem_seed = {
        "schema_version": REVIEW_SCHEMA,
        "reviewed_at": generated_at,
        "reviewer": "controlled-three-round-audit",
        "notice": "Small open-license, software-only eligibility seed. Passing this audit is not a wet-lab, orderability, biosafety, or regulatory claim. Activation remains an explicit human action.",
        "records": sorted(igem_records, key=lambda item: item["resource_id"].casefold()),
    }
    protein_seed = {
        "schema_version": REVIEW_SCHEMA,
        "reviewed_at": generated_at,
        "reviewer": "controlled-three-round-audit",
        "notice": "Reviewed reporter-protein references for the software compiler domain only. Activation remains an explicit human action.",
        "records": sorted(protein_records, key=lambda item: item["resource_id"].casefold()),
    }
    initial = {
        IGEM_SEED_PATH: _json_bytes(igem_seed),
        PROTEIN_SEED_PATH: _json_bytes(protein_seed),
        AUDIT_PATH: _json_bytes(audit),
    }
    old_lock = _read_json_bytes((repo / SOURCE_LOCK_PATH).read_bytes(), label=SOURCE_LOCK_PATH)
    evidence_entries: list[dict[str, Any]] = []
    for relative in sorted([*responses, RECEIPT_PATH]):
        path = repo / relative
        entry: dict[str, Any] = {"path": relative, "sha256": _sha256_file(path)}
        if relative in responses:
            entry.update({
                "url": responses[relative]["url"],
                "retrieved_at": responses[relative]["retrieved_at"],
                "byte_count": responses[relative]["byte_count"],
            })
        else:
            entry["kind"] = "retrieval_receipt"
        evidence_entries.append(entry)
    source_lock = {
        "schema_version": "proto-agent.public-materials-source-lock.v1",
        "exported_at": generated_at,
        "eligible_inputs": [
            {
                "path": IGEM_SEED_PATH,
                "sha256": _sha256_bytes(initial[IGEM_SEED_PATH]),
                "selected_record_count": 15,
                "provider": "iGEM Registry",
            },
            {
                "path": PROTEIN_SEED_PATH,
                "sha256": _sha256_bytes(initial[PROTEIN_SEED_PATH]),
                "selected_record_count": 3,
                "provider": "UniProtKB/Swiss-Prot",
            },
        ],
        "promotion_audit": {
            "path": AUDIT_PATH,
            "sha256": _sha256_bytes(initial[AUDIT_PATH]),
            "schema_version": audit["schema_version"],
            "policy_version": audit["policy_version"],
            "candidate_count": audit["candidate_count"],
            "pass_count": audit["pass_count"],
            "fail_count": audit["fail_count"],
        },
        "source_evidence": evidence_entries,
        "quarantine_inputs": old_lock.get("quarantine_inputs", []),
        "activation_policy": "EXPLICIT_HUMAN_ONLY",
        "active_pointer_mutated": False,
    }
    return {**initial, SOURCE_LOCK_PATH: _json_bytes(source_lock)}


def write_outputs(repo: Path) -> None:
    outputs = _build_outputs(repo)
    for relative, body in outputs.items():
        path = repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)


def check_outputs(repo: Path) -> None:
    outputs = _build_outputs(repo)
    mismatches = [relative for relative, body in outputs.items() if not (repo / relative).is_file() or (repo / relative).read_bytes() != body]
    if mismatches:
        raise ValueError(f"Reviewed materials outputs are stale or missing: {mismatches}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--fetch", action="store_true", help="Fetch fresh official evidence, then rebuild reviewed outputs.")
    mode.add_argument("--from-evidence", action="store_true", help="Rebuild reviewed outputs from locked local evidence without network access.")
    mode.add_argument("--check", action="store_true", help="Verify checked-in outputs against locked local evidence without writing.")
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    repo = args.repo.resolve()
    try:
        if args.fetch:
            fetch(repo)
            write_outputs(repo)
        elif args.from_evidence:
            write_outputs(repo)
        else:
            check_outputs(repo)
    except Exception as exc:
        print(f"materials promotion review failed: {exc}", file=sys.stderr)
        return 1
    print("materials promotion review passed: 18/18 candidates; reviewed outputs remain inactive")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
