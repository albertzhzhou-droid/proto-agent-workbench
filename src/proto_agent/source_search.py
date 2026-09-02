from __future__ import annotations

import csv
import hashlib
import io
import json
import ssl
from datetime import datetime, timezone
from itertools import islice
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener

from .json_validation import strict_json_loads
from .security import MAX_CA_FILE_BYTES, MAX_FIXTURE_FILE_BYTES, MAX_JSON_FILE_BYTES, read_bytes_bounded, read_json_bounded, read_text_bounded, write_text_bounded


DEFAULT_EVIDENCE_CACHE_DIR = Path("build") / "cache" / "evidence"

EUROPE_PMC_DOCUMENTATION = "https://europepmc.org/RestfulWebService"
CROSSREF_DOCUMENTATION = "https://api.crossref.org/swagger-ui/index.html"
UNIPROT_DOCUMENTATION = "https://www.uniprot.org/help/api"
RHEA_DOCUMENTATION = "https://www.rhea-db.org/help/rest-api"
MAX_NETWORK_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_QUERY_CHARS = 512


def search_europe_pmc(
    query: str,
    limit: int = 5,
    cache_dir: str | Path = DEFAULT_EVIDENCE_CACHE_DIR,
    allow_network: bool = True,
    fixture_path: str | Path | None = None,
    cafile: str | Path | None = None,
    timeout: int = 20,
) -> dict[str, Any]:
    _validate_search_request(query, limit, timeout)
    provider = "europe_pmc"
    params = {
        "query": query,
        "format": "json",
        "pageSize": str(_bounded_limit(limit)),
        "resultType": "core",
    }
    url = f"https://www.ebi.ac.uk/europepmc/webservices/rest/search?{urlencode(params)}"
    loaded = _load_json(provider, query, limit, cache_dir, allow_network, fixture_path, cafile, timeout, url)
    if loaded[0] is None:
        return _error_payload(provider, query, limit, loaded[3], loaded[1], loaded[2], EUROPE_PMC_DOCUMENTATION)
    raw, mode, cache_path, _error = loaded
    records = raw.get("resultList", {}).get("result", [])
    matches = []
    for record in records[: _bounded_limit(limit)]:
        pmid = str(record.get("pmid") or "").strip()
        pmcid = str(record.get("pmcid") or "").strip()
        doi = str(record.get("doi") or "").strip()
        source = str(record.get("source") or "MED").strip()
        external_id = str(record.get("id") or pmid or pmcid).strip()
        source_id = f"PMID:{pmid}" if pmid else f"PMCID:{pmcid}" if pmcid else f"EuropePMC:{source}:{external_id}"
        identifiers = [source_id]
        if pmcid and f"PMCID:{pmcid}" not in identifiers:
            identifiers.append(f"PMCID:{pmcid}")
        if doi:
            identifiers.append(f"DOI:{doi}")
        matches.append(
            {
                "source_id": source_id,
                "identifiers": identifiers,
                "title": record.get("title", ""),
                "authors": record.get("authorString", ""),
                "journal": record.get("journalTitle", ""),
                "publication_date": record.get("firstPublicationDate") or record.get("firstIndexDate", ""),
                "publication_types": record.get("pubTypeList", {}).get("pubType", []),
                "is_open_access": record.get("isOpenAccess") == "Y",
                "url": f"https://europepmc.org/article/{source}/{external_id}",
            }
        )
    return _success_payload(provider, query, limit, mode, cache_path, matches, EUROPE_PMC_DOCUMENTATION)


def search_crossref(
    query: str,
    limit: int = 5,
    cache_dir: str | Path = DEFAULT_EVIDENCE_CACHE_DIR,
    allow_network: bool = True,
    fixture_path: str | Path | None = None,
    cafile: str | Path | None = None,
    timeout: int = 20,
) -> dict[str, Any]:
    _validate_search_request(query, limit, timeout)
    provider = "crossref"
    params = {
        "query.bibliographic": query,
        "rows": str(_bounded_limit(limit)),
        "select": "DOI,title,author,published,container-title,URL,type,score",
    }
    url = f"https://api.crossref.org/works?{urlencode(params)}"
    loaded = _load_json(provider, query, limit, cache_dir, allow_network, fixture_path, cafile, timeout, url)
    if loaded[0] is None:
        return _error_payload(provider, query, limit, loaded[3], loaded[1], loaded[2], CROSSREF_DOCUMENTATION)
    raw, mode, cache_path, _error = loaded
    records = raw.get("message", {}).get("items", [])
    matches = []
    for record in records[: _bounded_limit(limit)]:
        doi = str(record.get("DOI") or "").strip()
        if not doi:
            continue
        date_parts = record.get("published", {}).get("date-parts", [[]])
        published = "-".join(str(part) for part in (date_parts[0] if date_parts else []))
        authors = []
        for author in record.get("author", [])[:8]:
            name = " ".join(part for part in [author.get("given", ""), author.get("family", "")] if part).strip()
            if name:
                authors.append(name)
        matches.append(
            {
                "source_id": f"DOI:{doi}",
                "identifiers": [f"DOI:{doi}"],
                "title": _first(record.get("title")),
                "authors": authors,
                "container_title": _first(record.get("container-title")),
                "publication_date": published,
                "work_type": record.get("type", ""),
                "score": record.get("score"),
                "url": record.get("URL") or f"https://doi.org/{doi}",
            }
        )
    return _success_payload(provider, query, limit, mode, cache_path, matches, CROSSREF_DOCUMENTATION)


def search_uniprot(
    query: str,
    limit: int = 5,
    organism_id: int | None = None,
    reviewed_only: bool = True,
    cache_dir: str | Path = DEFAULT_EVIDENCE_CACHE_DIR,
    allow_network: bool = True,
    fixture_path: str | Path | None = None,
    cafile: str | Path | None = None,
    timeout: int = 20,
) -> dict[str, Any]:
    _validate_search_request(query, limit, timeout)
    if organism_id is not None and (isinstance(organism_id, bool) or not 1 <= organism_id <= 2**31 - 1):
        raise ValueError("Organism id must be between 1 and 2147483647.")
    provider = "uniprot"
    clauses = [f"({query})"]
    if organism_id:
        clauses.append(f"(organism_id:{organism_id})")
    if reviewed_only:
        clauses.append("(reviewed:true)")
    effective_query = " AND ".join(clauses)
    params = {
        "query": effective_query,
        "format": "json",
        "size": str(_bounded_limit(limit)),
        "fields": "accession,id,protein_name,gene_names,organism_name,reviewed,ec,cc_function,cc_catalytic_activity",
    }
    url = f"https://rest.uniprot.org/uniprotkb/search?{urlencode(params)}"
    loaded = _load_json(provider, effective_query, limit, cache_dir, allow_network, fixture_path, cafile, timeout, url)
    if loaded[0] is None:
        return _error_payload(provider, query, limit, loaded[3], loaded[1], loaded[2], UNIPROT_DOCUMENTATION)
    raw, mode, cache_path, _error = loaded
    matches = []
    for record in raw.get("results", [])[: _bounded_limit(limit)]:
        accession = str(record.get("primaryAccession") or "").strip()
        if not accession:
            continue
        functions = []
        catalytic_activities = []
        rhea_ids = []
        for comment in record.get("comments", []):
            if comment.get("commentType") == "FUNCTION":
                functions.extend(text.get("value", "") for text in comment.get("texts", []) if text.get("value"))
            if comment.get("commentType") == "CATALYTIC ACTIVITY":
                reaction = comment.get("reaction") or {}
                if reaction.get("name"):
                    catalytic_activities.append(reaction["name"])
                for reference in reaction.get("reactionCrossReferences", []):
                    if str(reference.get("database", "")).lower() == "rhea" and reference.get("id"):
                        rhea_ids.append(str(reference["id"]))
        identifiers = [f"UniProt:{accession}", *sorted(set(rhea_ids))]
        matches.append(
            {
                "source_id": f"UniProt:{accession}",
                "identifiers": identifiers,
                "entry_id": record.get("uniProtkbId", ""),
                "protein_name": _protein_name(record.get("proteinDescription", {})),
                "gene_names": _gene_names(record.get("genes", [])),
                "organism": record.get("organism", {}).get("scientificName", ""),
                "reviewed": "swiss-prot" in str(record.get("entryType", "")).lower(),
                "functions": functions,
                "catalytic_activities": catalytic_activities,
                "rhea_ids": sorted(set(rhea_ids)),
                "url": f"https://www.uniprot.org/uniprotkb/{accession}/entry",
            }
        )
    payload = _success_payload(provider, query, limit, mode, cache_path, matches, UNIPROT_DOCUMENTATION)
    payload["effective_query"] = effective_query
    return payload


def search_rhea(
    query: str,
    limit: int = 5,
    cache_dir: str | Path = DEFAULT_EVIDENCE_CACHE_DIR,
    allow_network: bool = True,
    fixture_path: str | Path | None = None,
    cafile: str | Path | None = None,
    timeout: int = 20,
) -> dict[str, Any]:
    _validate_search_request(query, limit, timeout)
    provider = "rhea"
    params = {
        "query": query,
        "columns": "rhea-id,equation,chebi-id,ec,pubmed,reaction-xref(EcoCyc),reaction-xref(MetaCyc),reaction-xref(KEGG)",
        "format": "tsv",
        "limit": str(_bounded_limit(limit)),
    }
    url = f"https://www.rhea-db.org/rhea/?{urlencode(params)}"
    loaded = _load_text(provider, query, limit, cache_dir, allow_network, fixture_path, cafile, timeout, url)
    if loaded[0] is None:
        return _error_payload(provider, query, limit, loaded[3], loaded[1], loaded[2], RHEA_DOCUMENTATION)
    raw, mode, cache_path, _error = loaded
    reader = csv.DictReader(io.StringIO(raw), delimiter="\t")
    matches = []
    for row in islice(reader, _bounded_limit(limit)):
        rhea_id = _row_value(row, "Reaction identifier", "rhea-id", "RHEA_ID")
        if not rhea_id:
            continue
        source_id = rhea_id if rhea_id.upper().startswith("RHEA:") else f"RHEA:{rhea_id}"
        pmids = _split_values(_row_value(row, "PubMed", "pubmed"))
        identifiers = [source_id, *(f"PMID:{pmid.removeprefix('PMID:')}" for pmid in pmids)]
        matches.append(
            {
                "source_id": source_id,
                "identifiers": identifiers,
                "equation": _row_value(row, "Equation", "equation"),
                "chebi_ids": _split_values(_row_value(row, "ChEBI identifier", "chebi-id")),
                "ec_numbers": _split_values(_row_value(row, "EC number", "ec")),
                "pubmed_ids": pmids,
                "ecocyc_xrefs": _split_values(_row_value(row, "Cross-reference (EcoCyc)", "reaction-xref(EcoCyc)")),
                "metacyc_xrefs": _split_values(_row_value(row, "Cross-reference (MetaCyc)", "reaction-xref(MetaCyc)")),
                "kegg_xrefs": _split_values(_row_value(row, "Cross-reference (KEGG)", "reaction-xref(KEGG)")),
                "url": f"https://www.rhea-db.org/rhea/{source_id.split(':', 1)[1]}",
            }
        )
    return _success_payload(provider, query, limit, mode, cache_path, matches, RHEA_DOCUMENTATION)


def _load_json(
    provider: str,
    query: str,
    limit: int,
    cache_dir: str | Path,
    allow_network: bool,
    fixture_path: str | Path | None,
    cafile: str | Path | None,
    timeout: int,
    url: str,
) -> tuple[dict[str, Any] | None, str, Path, str]:
    cache_path = _cache_path(provider, query, limit, cache_dir, ".json")
    if fixture_path:
        return read_json_bounded(fixture_path, MAX_FIXTURE_FILE_BYTES), "fixture", cache_path, ""
    if cache_path.exists():
        return read_json_bounded(cache_path, MAX_JSON_FILE_BYTES), "cache", cache_path, ""
    if not allow_network:
        return None, "offline", cache_path, "No cache entry exists and network access is disabled."
    try:
        raw = strict_json_loads(_get_text(url, timeout, cafile, "application/json"), max_bytes=MAX_NETWORK_RESPONSE_BYTES)
    except (OSError, HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
        return None, "network", cache_path, str(exc)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    write_text_bounded(cache_path, json.dumps(raw, indent=2) + "\n", boundary=cache_path.parent)
    return raw, "network", cache_path, ""


def _load_text(
    provider: str,
    query: str,
    limit: int,
    cache_dir: str | Path,
    allow_network: bool,
    fixture_path: str | Path | None,
    cafile: str | Path | None,
    timeout: int,
    url: str,
) -> tuple[str | None, str, Path, str]:
    cache_path = _cache_path(provider, query, limit, cache_dir, ".tsv")
    if fixture_path:
        return read_text_bounded(fixture_path, MAX_FIXTURE_FILE_BYTES), "fixture", cache_path, ""
    if cache_path.exists():
        return read_text_bounded(cache_path, MAX_JSON_FILE_BYTES), "cache", cache_path, ""
    if not allow_network:
        return None, "offline", cache_path, "No cache entry exists and network access is disabled."
    try:
        raw = _get_text(url, timeout, cafile, "text/tab-separated-values")
    except (OSError, HTTPError, URLError, TimeoutError, ValueError) as exc:
        return None, "network", cache_path, str(exc)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    write_text_bounded(cache_path, raw, boundary=cache_path.parent)
    return raw, "network", cache_path, ""


def _get_text(url: str, timeout: int, cafile: str | Path | None, accept: str) -> str:
    parsed_url = urlsplit(url)
    if parsed_url.scheme != "https" or not parsed_url.hostname:
        raise ValueError("External evidence URL must use HTTPS and an explicit host.")
    request = Request(
        url,
        headers={
            "Accept": accept,
            "User-Agent": "Proto-Workbench/0.1 (local scientific evidence client)",
        },
    )
    opener = build_opener(
        ProxyHandler({}),
        HTTPSHandler(context=_ssl_context(cafile)),
        _SameHostRedirectHandler(parsed_url.hostname),
    )
    with opener.open(request, timeout=timeout) as response:
        content_length = response.headers.get("Content-Length")
        if content_length and int(content_length) > MAX_NETWORK_RESPONSE_BYTES:
            raise ValueError("External evidence response exceeds the byte limit.")
        raw = response.read(MAX_NETWORK_RESPONSE_BYTES + 1)
        if len(raw) > MAX_NETWORK_RESPONSE_BYTES:
            raise ValueError("External evidence response exceeds the byte limit.")
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("External evidence response is not valid UTF-8.") from exc


def _ssl_context(cafile: str | Path | None) -> ssl.SSLContext:
    configured_cafile = cafile
    if configured_cafile:
        return _context_with_bounded_ca(configured_cafile)
    try:
        import certifi  # type: ignore[import-not-found]

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def _context_with_bounded_ca(cafile: str | Path) -> ssl.SSLContext:
    payload = read_bytes_bounded(cafile, MAX_CA_FILE_BYTES)
    context = ssl.create_default_context()
    if b"-----BEGIN CERTIFICATE-----" in payload:
        try:
            context.load_verify_locations(cadata=payload.decode("ascii"))
        except UnicodeDecodeError as exc:
            raise ValueError("PEM CA bundle must contain ASCII text.") from exc
    else:
        context.load_verify_locations(cadata=payload)
    return context


def _cache_path(provider: str, query: str, limit: int, cache_dir: str | Path, suffix: str) -> Path:
    key = hashlib.sha256(f"{provider}\n{query}\n{limit}".encode("utf-8")).hexdigest()[:16]
    return Path(cache_dir) / provider / f"{key}{suffix}"


def _success_payload(
    provider: str,
    query: str,
    limit: int,
    mode: str,
    cache_path: Path,
    matches: list[dict[str, Any]],
    documentation: str,
) -> dict[str, Any]:
    return {
        "ok": True,
        "source": provider,
        "query": query,
        "limit": _bounded_limit(limit),
        "mode": mode,
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "matches": matches,
        "match_count": len(matches),
        "source_ids": sorted({identifier for match in matches for identifier in match.get("identifiers", [])}),
        "cache_path": str(cache_path),
        "documentation": documentation,
        "notice": "External metadata is evidence input, not experimental validation. Review source records before supporting scientific claims.",
    }


def _error_payload(
    provider: str,
    query: str,
    limit: int,
    message: str,
    mode: str,
    cache_path: Path,
    documentation: str,
) -> dict[str, Any]:
    return {
        "ok": False,
        "source": provider,
        "query": query,
        "limit": _bounded_limit(limit),
        "mode": mode,
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "matches": [],
        "match_count": 0,
        "source_ids": [],
        "cache_path": str(cache_path),
        "documentation": documentation,
        "diagnostics": [
            {
                "severity": "error",
                "file": str(cache_path),
                "line": 0,
                "code": f"{provider.upper()}_SEARCH_ERROR",
                "message": message,
            }
        ],
    }


def _bounded_limit(limit: int) -> int:
    return max(1, min(int(limit), 20))


def _validate_search_request(query: str, limit: int, timeout: int) -> None:
    if not isinstance(query, str) or not query.strip() or len(query) > MAX_QUERY_CHARS or "\x00" in query:
        raise ValueError(f"Search query must contain 1 to {MAX_QUERY_CHARS} characters and no NUL.")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 20:
        raise ValueError("Search result limit must be between 1 and 20.")
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= 60:
        raise ValueError("Search timeout must be between 1 and 60 seconds.")


class _SameHostRedirectHandler(HTTPRedirectHandler):
    def __init__(self, hostname: str) -> None:
        super().__init__()
        self.hostname = hostname

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        parsed = urlsplit(newurl)
        if parsed.scheme != "https" or parsed.hostname != self.hostname:
            raise URLError("Cross-host or non-HTTPS redirect was blocked.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _first(value: Any) -> str:
    if isinstance(value, list) and value:
        return str(value[0])
    return str(value or "")


def _protein_name(description: dict[str, Any]) -> str:
    recommended = description.get("recommendedName", {}).get("fullName", {}).get("value")
    if recommended:
        return str(recommended)
    submitted = description.get("submissionNames", [])
    if submitted:
        return str(submitted[0].get("fullName", {}).get("value", ""))
    return ""


def _gene_names(genes: list[dict[str, Any]]) -> list[str]:
    names = []
    for gene in genes:
        primary = gene.get("geneName", {}).get("value")
        if primary:
            names.append(str(primary))
        names.extend(str(item.get("value")) for item in gene.get("synonyms", []) if item.get("value"))
    return names


def _row_value(row: dict[str, str], *keys: str) -> str:
    for key in keys:
        if row.get(key):
            return str(row[key]).strip()
    return ""


def _split_values(value: str) -> list[str]:
    return [item.strip() for item in value.replace(";", " ").split() if item.strip()]
