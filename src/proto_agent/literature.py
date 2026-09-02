from __future__ import annotations

import hashlib
import json
import ssl
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener

from .json_validation import strict_json_loads
from .security import MAX_CA_FILE_BYTES, MAX_FIXTURE_FILE_BYTES, MAX_JSON_FILE_BYTES, read_bytes_bounded, read_json_bounded, write_text_bounded

DEFAULT_LITERATURE_PATH = Path("literature") / "seed_sources.json"
DEFAULT_PUBMED_CACHE_DIR = Path("build") / "cache" / "pubmed"
NCBI_EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
MAX_NETWORK_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_QUERY_CHARS = 512
MAX_RESULTS = 20


def load_literature(path: str | Path = DEFAULT_LITERATURE_PATH) -> dict[str, Any]:
    payload = read_json_bounded(path, MAX_JSON_FILE_BYTES)
    if not isinstance(payload, dict):
        raise ValueError("Literature registry must be a JSON object.")
    return payload


def search_literature(
    query: str,
    path: str | Path = DEFAULT_LITERATURE_PATH,
    limit: int = 10,
) -> dict[str, Any]:
    _validate_search_request(query, limit)
    registry = load_literature(path)
    needle = query.lower()
    matches = []
    for source in registry.get("sources", []):
        if not isinstance(source, dict):
            continue
        haystack = " ".join(
            [
                source.get("id", ""),
                source.get("title", ""),
                source.get("source", ""),
                source.get("summary", ""),
                " ".join(source.get("tags", [])),
            ]
        ).lower()
        if needle in haystack:
            normalized = dict(source)
            normalized.setdefault("source_id", f"LOCAL:{source.get('id', 'unknown')}")
            matches.append(normalized)
    return {
        "ok": True,
        "registry": str(path),
        "query": query,
        "matches": matches[:limit],
        "match_count": len(matches),
        "notice": registry.get("notice", ""),
    }


def search_pubmed(
    query: str,
    retmax: int = 5,
    cache_dir: str | Path = DEFAULT_PUBMED_CACHE_DIR,
    allow_network: bool = True,
    fixture_path: str | Path | None = None,
    cafile: str | Path | None = None,
    timeout: int = 15,
) -> dict[str, Any]:
    _validate_search_request(query, retmax)
    if not 1 <= timeout <= 60:
        raise ValueError("PubMed timeout must be between 1 and 60 seconds.")
    cache_path = _pubmed_cache_path(query, retmax, cache_dir)
    if fixture_path:
        payload = read_json_bounded(fixture_path, MAX_FIXTURE_FILE_BYTES)
        return _pubmed_payload(query, retmax, payload, "fixture", cache_path)

    if cache_path.exists():
        payload = read_json_bounded(cache_path, MAX_JSON_FILE_BYTES)
        return _pubmed_payload(query, retmax, payload, "cache", cache_path)

    if not allow_network:
        return {
            "ok": False,
            "query": query,
            "retmax": retmax,
            "source": "pubmed",
            "mode": "offline",
            "matches": [],
            "diagnostics": [
                {
                    "severity": "error",
                    "file": str(cache_path),
                    "line": 0,
                    "code": "PUBMED_CACHE_MISS",
                    "message": "No PubMed cache entry exists and network access is disabled.",
                }
            ],
        }

    try:
        payload = _fetch_pubmed(query, retmax, timeout, cafile)
    except (OSError, URLError, TimeoutError, ValueError) as exc:
        return {
            "ok": False,
            "query": query,
            "retmax": retmax,
            "source": "pubmed",
            "mode": "network",
            "matches": [],
            "diagnostics": [
                {
                    "severity": "error",
                    "file": "",
                    "line": 0,
                    "code": "PUBMED_NETWORK_ERROR",
                    "message": str(exc),
                }
            ],
        }

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    write_text_bounded(cache_path, json.dumps(payload, indent=2) + "\n", boundary=cache_path.parent)
    return _pubmed_payload(query, retmax, payload, "network", cache_path)


def _fetch_pubmed(query: str, retmax: int, timeout: int, cafile: str | Path | None) -> dict[str, Any]:
    search_params = {
        "db": "pubmed",
        "term": query,
        "retmode": "json",
        "retmax": str(retmax),
        "tool": "proto-agent",
    }
    search_url = f"{NCBI_EUTILS_BASE}/esearch.fcgi?{urlencode(search_params)}"
    search_data = _get_json(search_url, timeout, cafile)
    if not isinstance(search_data, dict):
        raise ValueError("PubMed search payload must be a JSON object.")
    search_result = search_data.get("esearchresult", {})
    if not isinstance(search_result, dict):
        raise ValueError("PubMed search result is malformed.")
    ids = search_result.get("idlist", [])
    if not isinstance(ids, list):
        raise ValueError("PubMed id list is malformed.")
    ids = [str(identifier) for identifier in ids[:retmax] if str(identifier).isdigit() and len(str(identifier)) <= 16]
    if not ids:
        return {"search": search_data, "summary": {"result": {"uids": []}}}

    summary_params = {
        "db": "pubmed",
        "id": ",".join(ids),
        "retmode": "json",
        "tool": "proto-agent",
    }
    summary_url = f"{NCBI_EUTILS_BASE}/esummary.fcgi?{urlencode(summary_params)}"
    return {
        "search": search_data,
        "summary": _get_json(summary_url, timeout, cafile),
    }


def _get_json(url: str, timeout: int, cafile: str | Path | None) -> dict[str, Any]:
    context = _ssl_context(cafile)
    hostname = urlsplit(url).hostname
    if hostname != "eutils.ncbi.nlm.nih.gov":
        raise ValueError("PubMed request host is not permitted.")
    opener = build_opener(ProxyHandler({}), HTTPSHandler(context=context), _SameHostRedirectHandler(hostname))
    request = Request(url, headers={"User-Agent": "Proto-Workbench/0.1 (local scientific evidence client)"})
    with opener.open(request, timeout=timeout) as response:
        content_length = response.headers.get("Content-Length")
        if content_length and int(content_length) > MAX_NETWORK_RESPONSE_BYTES:
            raise ValueError("PubMed response exceeds the byte limit.")
        raw = response.read(MAX_NETWORK_RESPONSE_BYTES + 1)
        if len(raw) > MAX_NETWORK_RESPONSE_BYTES:
            raise ValueError("PubMed response exceeds the byte limit.")
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("PubMed response is not valid UTF-8.") from exc
        return strict_json_loads(text, max_bytes=MAX_NETWORK_RESPONSE_BYTES)


def _ssl_context(cafile: str | Path | None) -> ssl.SSLContext:
    configured_cafile = cafile
    if configured_cafile:
        return _context_with_bounded_ca(configured_cafile)
    try:
        import certifi  # type: ignore[import-not-found]

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
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


def _validate_search_request(query: str, limit: int) -> None:
    if not isinstance(query, str) or not query.strip() or len(query) > MAX_QUERY_CHARS or "\x00" in query:
        raise ValueError(f"Search query must contain 1 to {MAX_QUERY_CHARS} characters and no NUL.")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_RESULTS:
        raise ValueError(f"Search result limit must be between 1 and {MAX_RESULTS}.")


class _SameHostRedirectHandler(HTTPRedirectHandler):
    def __init__(self, hostname: str) -> None:
        super().__init__()
        self.hostname = hostname

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        parsed = urlsplit(newurl)
        if parsed.scheme != "https" or parsed.hostname != self.hostname:
            raise URLError("Cross-host or non-HTTPS redirect was blocked.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _pubmed_cache_path(query: str, retmax: int, cache_dir: str | Path) -> Path:
    key = hashlib.sha256(f"{query}\n{retmax}".encode("utf-8")).hexdigest()[:16]
    return Path(cache_dir) / f"{key}.json"


def _pubmed_payload(
    query: str,
    retmax: int,
    raw_payload: dict[str, Any],
    mode: str,
    cache_path: Path,
) -> dict[str, Any]:
    if not isinstance(raw_payload, dict):
        raise ValueError("PubMed payload must be a JSON object.")
    summary_container = raw_payload.get("summary", {})
    if not isinstance(summary_container, dict):
        raise ValueError("PubMed summary payload is malformed.")
    summary = summary_container.get("result", {})
    if not isinstance(summary, dict):
        raise ValueError("PubMed summary result is malformed.")
    uids = summary.get("uids", [])
    matches = []
    if not isinstance(uids, list):
        raise ValueError("PubMed summary uid list is malformed.")
    for uid in uids[:retmax]:
        uid = str(uid)
        if not uid.isdigit() or len(uid) > 16:
            continue
        record = summary.get(uid, {})
        if not isinstance(record, dict):
            continue
        article_ids = record.get("articleids", [])
        if not isinstance(article_ids, list):
            article_ids = []
        doi = next(
            (
                str(item.get("value", ""))[:512]
                for item in article_ids
                if isinstance(item, dict) and item.get("idtype") == "doi"
            ),
            "",
        )
        authors = record.get("authors", [])
        if not isinstance(authors, list):
            authors = []
        matches.append(
            {
                "source_id": f"PMID:{uid}",
                "identifiers": [
                    f"PMID:{uid}",
                    *([f"DOI:{doi}"] if doi else []),
                ],
                "pmid": uid,
                "title": str(record.get("title", ""))[:4096],
                "source": str(record.get("source", ""))[:512],
                "pubdate": str(record.get("pubdate", ""))[:128],
                "authors": [
                    str(author.get("name", ""))[:512]
                    for author in authors[:6]
                    if isinstance(author, dict) and author.get("name")
                ],
                "doi": doi,
                "url": f"https://pubmed.ncbi.nlm.nih.gov/{uid}/",
            }
        )
    return {
        "ok": True,
        "query": query,
        "retmax": retmax,
        "source": "pubmed",
        "mode": mode,
        "matches": matches,
        "match_count": len(matches),
        "source_ids": sorted(
            {identifier for match in matches for identifier in match.get("identifiers", [])}
        ),
        "cache_path": str(cache_path),
        "documentation": "https://www.ncbi.nlm.nih.gov/books/NBK25501/",
        "notice": "PubMed metadata is retrieved through NCBI E-utilities. Verify sources before using them in scientific claims.",
    }
