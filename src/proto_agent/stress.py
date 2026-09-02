from __future__ import annotations

import hashlib
import json
import os
import random
import stat
import tempfile
import time
import tracemalloc
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Any, Callable, Mapping

from .json_validation import (
    JsonValidationError,
    strict_json_loads,
    validate_json_schema,
    validate_json_shape,
)
from .parser import parse_design
from .security import SecurityBoundaryError, WorkspacePaths, read_bytes_bounded


DEFAULT_SEED = 0x50524F54
BLNS_COMMIT = "db33ec7b1d5d9616a88c76394b7d0897bd0b97eb"
JSON_TEST_SUITE_COMMIT = "1ef36fa01286573e846ac449e8683f8833c5b26a"
_MAX_CORPUS_FILE_BYTES = 1024 * 1024
_MAX_CORPUS_FILES = 256
_MAX_CORPUS_TOTAL_BYTES = 16 * 1024 * 1024
_MAX_BLNS_RECORDS = 256
_MAX_AVAILABLE_CASES = 512
_STRESS_TOOL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["name", "arguments"],
    "properties": {
        "name": {"type": "string", "minLength": 1, "maxLength": 64},
        "arguments": {
            "type": "object",
            "properties": {},
            "additionalProperties": True,
            "maxProperties": 16,
        },
    },
    "additionalProperties": False,
    "maxProperties": 2,
}
@dataclass(frozen=True)
class StressBudget:
    """Cooperative limits for one in-process, offline stress run."""

    max_cases: int = 64
    max_total_seconds: float = 5.0
    max_case_seconds: float = 0.25
    max_input_bytes: int = 64 * 1024
    max_report_bytes: int = 2 * 1024 * 1024

    def validate(self) -> None:
        if self.max_cases <= 0:
            raise ValueError("max_cases must be positive")
        if self.max_total_seconds <= 0:
            raise ValueError("max_total_seconds must be positive")
        if self.max_case_seconds <= 0:
            raise ValueError("max_case_seconds must be positive")
        if self.max_input_bytes <= 0:
            raise ValueError("max_input_bytes must be positive")
        if self.max_report_bytes <= 0:
            raise ValueError("max_report_bytes must be positive")


@dataclass(frozen=True)
class _StressCase:
    name: str
    category: str
    input_bytes: int
    execute: Callable[[Path], dict[str, Any]]


def _default_corpus_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "tests" / "security_corpus"


def _is_link_or_reparse(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    attributes = getattr(metadata, "st_file_attributes", 0)
    return path.is_symlink() or bool(reparse_flag and attributes & reparse_flag)


def _reject_reparse_components(path: Path) -> None:
    absolute = path.absolute()
    current = Path(absolute.anchor)
    for component in absolute.parts[1:]:
        current /= component
        if _is_link_or_reparse(current):
            raise ValueError("path contains a symbolic-link or reparse-point component")


def _safe_corpus_path(corpus_root: Path, relative: str) -> Path:
    if not relative or Path(relative).is_absolute() or PureWindowsPath(relative).drive:
        raise ValueError("corpus manifest contains a non-relative path")
    unresolved = corpus_root / relative
    _reject_reparse_components(unresolved)
    candidate = unresolved.resolve(strict=False)
    try:
        candidate.relative_to(corpus_root)
    except ValueError as exc:
        raise ValueError("corpus manifest path escapes the corpus directory") from exc
    return candidate


def _load_json_bytes(payload: bytes) -> Any:
    try:
        return strict_json_loads(
            payload.decode("utf-8"),
            max_bytes=_MAX_CORPUS_FILE_BYTES,
        )
    except (UnicodeDecodeError, JsonValidationError) as exc:
        raise ValueError("corpus JSON is not valid bounded UTF-8 JSON") from exc


def _check_deadline(deadline: float, stage: str) -> None:
    if time.perf_counter() >= deadline:
        raise TimeoutError(f"stress total deadline exhausted during {stage}")


def _verify_corpus(
    corpus_root: Path,
    *,
    deadline: float,
) -> tuple[dict[str, Any], dict[str, bytes]]:
    _check_deadline(deadline, "corpus setup")
    provenance_path = corpus_root / "PROVENANCE.json"
    checksums_path = corpus_root / "SHA256SUMS"
    if not provenance_path.is_file() or not checksums_path.is_file():
        raise ValueError("security corpus requires PROVENANCE.json and SHA256SUMS")

    provenance_bytes = read_bytes_bounded(provenance_path, _MAX_CORPUS_FILE_BYTES)
    _check_deadline(deadline, "corpus provenance")
    provenance = _load_json_bytes(provenance_bytes)
    if not isinstance(provenance, dict):
        raise ValueError("invalid corpus provenance root")
    commits = {
        source.get("id"): source.get("commit")
        for source in provenance.get("sources", [])
        if isinstance(source, dict)
    }
    if commits.get("blns") != BLNS_COMMIT:
        raise ValueError("BLNS provenance is not pinned to the approved commit")
    if commits.get("json-test-suite") != JSON_TEST_SUITE_COMMIT:
        raise ValueError("JSONTestSuite provenance is not pinned to the approved commit")

    expected: dict[str, str] = {}
    checksum_bytes = read_bytes_bounded(checksums_path, _MAX_CORPUS_FILE_BYTES)
    _check_deadline(deadline, "corpus checksum manifest")
    try:
        checksum_text = checksum_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("SHA256SUMS must be UTF-8") from exc
    for line in checksum_text.splitlines():
        _check_deadline(deadline, "corpus checksum parsing")
        if not line.strip():
            continue
        parts = line.split("  ", 1)
        if len(parts) != 2 or len(parts[0]) != 64:
            raise ValueError("malformed SHA256SUMS entry")
        digest, relative = parts
        if relative in expected:
            raise ValueError("duplicate SHA256SUMS entry")
        expected[relative] = digest.lower()

    if not expected:
        raise ValueError("empty SHA256SUMS")
    if len(expected) > _MAX_CORPUS_FILES:
        raise ValueError("SHA256SUMS exceeds the corpus file-count limit")
    checked_bytes = 0
    verified_files: dict[str, bytes] = {}
    for relative, digest in expected.items():
        _check_deadline(deadline, "corpus integrity verification")
        path = _safe_corpus_path(corpus_root, relative)
        if not path.is_file():
            raise ValueError("corpus checksum references a missing file")
        payload = read_bytes_bounded(path, _MAX_CORPUS_FILE_BYTES)
        checked_bytes += len(payload)
        if checked_bytes > _MAX_CORPUS_TOTAL_BYTES:
            raise ValueError("corpus exceeds the aggregate integrity-check byte limit")
        if hashlib.sha256(payload).hexdigest() != digest:
            raise ValueError("security corpus checksum mismatch")
        verified_files[relative] = payload
        _check_deadline(deadline, "corpus integrity verification")

    if verified_files.get("PROVENANCE.json") != provenance_bytes:
        raise ValueError("corpus provenance changed during integrity verification")

    return (
        {
            "schema_version": provenance.get("schema_version"),
            "source_commits": commits,
            "verified_file_count": len(expected),
            "verified_bytes": checked_bytes,
        },
        verified_files,
    )


def _environment_delta(before: Mapping[str, str], after: Mapping[str, str]) -> dict[str, int]:
    before_keys = set(before)
    after_keys = set(after)
    return {
        "added_key_count": len(after_keys - before_keys),
        "removed_key_count": len(before_keys - after_keys),
        "changed_value_count": sum(
            before[key] != after[key] for key in before_keys & after_keys
        ),
    }


def _restore_environment(snapshot: Mapping[str, str]) -> None:
    for key in set(os.environ) - set(snapshot):
        del os.environ[key]
    for key, value in snapshot.items():
        if os.environ.get(key) != value:
            os.environ[key] = value


def _contained_path(workspace: Path, raw_path: str) -> tuple[bool, str]:
    """Exercise the production workspace resolver without requiring a leaf file."""

    try:
        policy = WorkspacePaths.create(workspace)
        policy._resolve_relative(raw_path, policy.workspace, must_exist=False)
    except SecurityBoundaryError as exc:
        return False, exc.code
    except (OSError, ValueError):
        return False, "PATH_REJECTED"
    return True, "contained"


def _validate_tool_envelope(payload: Any, *, max_bytes: int) -> bool:
    try:
        validate_json_shape(payload)
        validate_json_schema(payload, _STRESS_TOOL_SCHEMA, path="$")
        text = json.dumps(payload, ensure_ascii=True, allow_nan=False)
        encoded = text.encode("utf-8")
        strict_json_loads(text, max_bytes=max_bytes)
    except (JsonValidationError, TypeError, ValueError):
        return False
    return len(encoded) <= max_bytes


def _json_cases(verified_files: Mapping[str, bytes], *, deadline: float) -> list[_StressCase]:
    cases: list[_StressCase] = []
    fixture_names = sorted(
        relative
        for relative in verified_files
        if relative.startswith("json_tests/") and relative.endswith(".json")
    )
    for relative in fixture_names:
        _check_deadline(deadline, "JSON case construction")
        if len(cases) >= _MAX_AVAILABLE_CASES:
            raise ValueError("JSON case count exceeds the construction limit")
        path = Path(relative)
        fixture_bytes = verified_files[relative]
        if path.name == "y_object_duplicated_key.json":
            classification = "security_must_reject"
        elif path.name.startswith("y_"):
            classification = "must_accept"
        elif path.name.startswith("n_"):
            classification = "must_reject"
        elif path.name.startswith("i_"):
            classification = "implementation_defined"
        else:
            continue
        size = len(fixture_bytes)

        def execute(_: Path, fixture: bytes = fixture_bytes, expected: str = classification) -> dict[str, Any]:
            accepted = True
            try:
                strict_json_loads(
                    fixture.decode("utf-8"),
                    max_bytes=_MAX_CORPUS_FILE_BYTES,
                )
            except (UnicodeDecodeError, JsonValidationError):
                accepted = False
            expectation_met = (
                expected == "implementation_defined"
                or (expected == "security_must_reject" and not accepted)
                or (expected == "must_accept" and accepted)
                or (expected == "must_reject" and not accepted)
            )
            return {
                "passed": expectation_met,
                "classification": expected,
                "parser_outcome": "accepted" if accepted else "rejected",
            }

        cases.append(_StressCase(path.name, "json", size, execute))
    return cases


def _blns_cases(
    verified_files: Mapping[str, bytes],
    max_input_bytes: int,
    *,
    deadline: float,
) -> list[_StressCase]:
    records = _load_json_bytes(verified_files["blns_subset.json"])
    if not isinstance(records, list):
        raise ValueError("blns_subset.json must contain a list")
    if len(records) > _MAX_BLNS_RECORDS:
        raise ValueError("blns_subset.json exceeds the record-count limit")
    cases: list[_StressCase] = []
    for record in records:
        _check_deadline(deadline, "BLNS case construction")
        if len(cases) >= _MAX_AVAILABLE_CASES:
            raise ValueError("BLNS case count exceeds the construction limit")
        if not isinstance(record, dict):
            raise ValueError("invalid BLNS subset record")
        upstream_index = record.get("upstream_index")
        value = record.get("value")
        if not isinstance(upstream_index, int) or not isinstance(value, str):
            raise ValueError("invalid BLNS subset value")
        input_size = len(value.encode("utf-8"))

        def execute(
            case_root: Path,
            text: str = value,
            source_index: int = upstream_index,
        ) -> dict[str, Any]:
            round_trip = strict_json_loads(
                json.dumps(text, ensure_ascii=True),
                max_bytes=max_input_bytes + 256,
            ) == text
            schema_valid = _validate_tool_envelope(
                {"name": "stress_boundary", "arguments": {"value": text}},
                max_bytes=max_input_bytes + 256,
            )
            accepted, path_reason = _contained_path(case_root, text)
            path_contained = not accepted or path_reason == "contained"

            proto_path = case_root / "boundary.proto"
            proto_path.write_text(
                "design stress chassis ecoli_k12\n"
                "construct boundary:\n"
                f"unknown {text}\n",
                encoding="utf-8",
            )
            design, diagnostics = parse_design(proto_path)
            return {
                "passed": round_trip and schema_valid and path_contained,
                "upstream_index": source_index,
                "json_round_trip": round_trip,
                "schema_envelope_valid": schema_valid,
                "path_outcome": "accepted" if accepted else "rejected",
                "path_reason": path_reason,
                "proto_completed": design is not None,
                "proto_diagnostic_count": len(diagnostics),
            }

        cases.append(
            _StressCase(
                f"blns-index-{upstream_index}",
                "multi_boundary",
                input_size,
                execute,
            )
        )
    return cases


def _path_cases(*, deadline: float) -> list[_StressCase]:
    definitions = [
        ("safe-relative", "designs/input.proto", True),
        ("safe-unicode", "nested/\u03b4.json", True),
        ("safe-dot-substring", "nested/a..b.json", True),
        ("parent-posix", "../escape.json", False),
        ("parent-windows", "..\\escape.json", False),
        ("posix-absolute", "/etc/passwd", False),
        ("windows-absolute", "C:\\Windows\\win.ini", False),
        ("unc", "\\\\server\\share\\file", False),
        ("device", "nested/NUL.txt", False),
        ("uri", "file:///etc/passwd", False),
        ("encoded-traversal", "%2e%2e/%2fetc/passwd", False),
    ]
    cases: list[_StressCase] = []
    for name, value, expected in definitions:
        _check_deadline(deadline, "path case construction")

        def execute(
            case_root: Path,
            raw: str = value,
            expected_allowed: bool = expected,
        ) -> dict[str, Any]:
            allowed, reason = _contained_path(case_root, raw)
            return {
                "passed": allowed is expected_allowed,
                "accepted": allowed,
                "reason": reason,
            }

        cases.append(_StressCase(name, "path", len(value.encode("utf-8")), execute))
    cases.append(_hardlink_boundary_case())
    return cases


def _hardlink_boundary_case() -> _StressCase:
    def execute(case_root: Path) -> dict[str, Any]:
        outside = case_root.parent / f"outside-{case_root.name}.json"
        alias = case_root / "alias.json"
        outside.write_text('{"outside":true}', encoding="utf-8")
        try:
            try:
                os.link(outside, alias)
            except OSError:
                return {"passed": True, "outcome": "hardlink_unavailable"}
            try:
                WorkspacePaths.create(case_root).workspace_file(alias.name, extensions={".json"})
            except SecurityBoundaryError as exc:
                return {
                    "passed": exc.code == "HARDLINK_NOT_ALLOWED",
                    "outcome": "rejected",
                    "code": exc.code,
                }
            return {"passed": False, "outcome": "accepted"}
        finally:
            alias.unlink(missing_ok=True)
            outside.unlink(missing_ok=True)

    return _StressCase("production-hardlink-boundary", "path", 16, execute)


def _schema_cases(max_input_bytes: int, *, deadline: float) -> list[_StressCase]:
    definitions: list[tuple[str, Any, bool]] = [
        ("valid-minimal", {"name": "check", "arguments": {}}, True),
        ("valid-bounded", {"name": "check", "arguments": {"path": "a.proto"}}, True),
        ("root-array", [], False),
        ("missing-arguments", {"name": "check"}, False),
        ("unexpected-property", {"name": "check", "arguments": {}, "extra": True}, False),
        ("empty-name", {"name": "", "arguments": {}}, False),
        ("long-name", {"name": "x" * 65, "arguments": {}}, False),
        ("arguments-array", {"name": "check", "arguments": []}, False),
        ("non-string-key", {"name": "check", "arguments": {1: "value"}}, False),
    ]
    cases: list[_StressCase] = []
    for name, payload, expected in definitions:
        _check_deadline(deadline, "schema case construction")
        encoded_size = len(json.dumps(payload, ensure_ascii=True).encode("utf-8"))

        def execute(
            _: Path,
            value: Any = payload,
            expected_valid: bool = expected,
        ) -> dict[str, Any]:
            valid = _validate_tool_envelope(value, max_bytes=max_input_bytes)
            return {"passed": valid is expected_valid, "schema_valid": valid}

        cases.append(_StressCase(name, "schema", encoded_size, execute))
    return cases


def _parser_cases(*, deadline: float) -> list[_StressCase]:
    definitions = [
        (
            "valid-design",
            "design stress chassis ecoli_k12\nconstruct unit:\npromoter pLac\n",
            True,
            False,
        ),
        ("empty-design", "", False, True),
        ("missing-header", "construct unit:\n", False, True),
        ("unknown-statement", "design stress chassis ecoli_k12\nunknown value\n", True, True),
        ("invalid-construct", "design stress chassis ecoli_k12\nconstruct missing_colon\n", True, True),
    ]
    cases: list[_StressCase] = []
    for name, content, expect_design, expect_diagnostics in definitions:
        _check_deadline(deadline, "parser case construction")

        def execute(
            case_root: Path,
            source: str = content,
            design_expected: bool = expect_design,
            diagnostics_expected: bool = expect_diagnostics,
        ) -> dict[str, Any]:
            source_path = case_root / "input.proto"
            source_path.write_text(source, encoding="utf-8")
            design, diagnostics = parse_design(source_path)
            has_design = design is not None
            has_diagnostics = bool(diagnostics)
            return {
                "passed": has_design is design_expected and has_diagnostics is diagnostics_expected,
                "design_created": has_design,
                "diagnostic_count": len(diagnostics),
            }

        cases.append(_StressCase(name, "parser", len(content.encode("utf-8")), execute))
    return cases


def _canonical_workspace(workspace_root: str | Path | None) -> Path:
    requested = Path.cwd() if workspace_root is None else Path(workspace_root)
    _reject_reparse_components(requested)
    resolved = requested.resolve(strict=True)
    _reject_reparse_components(resolved)
    if not resolved.is_dir():
        raise ValueError("workspace_root must be a directory")
    return resolved


def _prepare_report_path(
    workspace_root: Path,
    build_dir: str | Path,
    report_path: str | Path,
) -> tuple[Path, Path, str]:
    if len(str(report_path).encode("utf-8", errors="surrogatepass")) > 4096:
        raise ValueError("report_path is too long")
    expected_build = (workspace_root / "build").resolve(strict=False)
    requested_build = Path(build_dir)
    if not requested_build.is_absolute():
        requested_build = workspace_root / requested_build
    _reject_reparse_components(requested_build)
    build_root = requested_build.resolve(strict=False)
    if build_root != expected_build:
        raise ValueError("build_dir must be workspace_root/build")

    requested = Path(report_path)
    unresolved = requested if requested.is_absolute() else build_root / requested
    _reject_reparse_components(unresolved)
    candidate = unresolved.resolve(strict=False)
    try:
        relative = candidate.relative_to(build_root)
    except ValueError as exc:
        raise ValueError("report_path must remain inside build_dir") from exc
    if candidate.suffix.casefold() != ".json":
        raise ValueError("stress report must use a .json suffix")
    if _is_link_or_reparse(candidate):
        raise ValueError("stress report path must not be a symbolic link or reparse point")
    return build_root, candidate, relative.as_posix()


def _write_json_report(
    target: Path,
    build_root: Path,
    payload: dict[str, Any],
    *,
    max_bytes: int,
) -> None:
    encoded = (json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True) + "\n").encode(
        "utf-8"
    )
    if len(encoded) > max_bytes:
        raise ValueError("stress report exceeds max_report_bytes")

    _reject_reparse_components(build_root)
    _reject_reparse_components(target.parent)
    target.parent.mkdir(parents=True, exist_ok=True)
    _reject_reparse_components(build_root)
    _reject_reparse_components(target.parent)
    resolved_target = target.resolve(strict=False)
    resolved_target.relative_to(build_root)
    if _is_link_or_reparse(target):
        raise ValueError("refusing to replace a link or reparse-point report")

    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=".proto-stress-report-",
            suffix=".tmp",
            dir=target.parent,
            delete=False,
        ) as handle:
            temporary_path = Path(handle.name)
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        _reject_reparse_components(target.parent)
        if _is_link_or_reparse(target):
            raise ValueError("report path changed to a link or reparse point")
        target.resolve(strict=False).relative_to(build_root)
        os.replace(temporary_path, target)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def _prepare_stress_run(
    *,
    corpus_dir: str | Path | None,
    workspace_root: str | Path | None,
    build_dir: str | Path,
    report_path: str | Path | None,
    seed: int,
    budget: StressBudget,
    deadline: float,
) -> tuple[
    Path,
    dict[str, Any],
    Path | None,
    Path | None,
    str | None,
    list[_StressCase],
    list[_StressCase],
]:
    _check_deadline(deadline, "workspace setup")
    workspace = _canonical_workspace(workspace_root)
    requested_corpus = Path(corpus_dir) if corpus_dir is not None else _default_corpus_dir()
    _reject_reparse_components(requested_corpus)
    corpus_root = requested_corpus.resolve(strict=True)
    _reject_reparse_components(corpus_root)
    if not corpus_root.is_dir():
        raise ValueError("corpus_dir must be a directory")
    corpus_info, verified_files = _verify_corpus(corpus_root, deadline=deadline)

    report_build_root: Path | None = None
    report_target: Path | None = None
    report_relative: str | None = None
    if report_path is not None:
        _check_deadline(deadline, "report path setup")
        report_build_root, report_target, report_relative = _prepare_report_path(
            workspace,
            build_dir,
            report_path,
        )

    cases = [
        *_json_cases(verified_files, deadline=deadline),
        *_blns_cases(verified_files, budget.max_input_bytes, deadline=deadline),
        *_path_cases(deadline=deadline),
        *_schema_cases(budget.max_input_bytes, deadline=deadline),
        *_parser_cases(deadline=deadline),
    ]
    if len(cases) > _MAX_AVAILABLE_CASES:
        raise ValueError("stress case construction exceeds the available-case limit")
    _check_deadline(deadline, "case selection")
    random.Random(seed).shuffle(cases)
    categories = {case.category for case in cases}
    if budget.max_cases >= len(categories):
        covered: set[str] = set()
        coverage_cases: list[_StressCase] = []
        remaining_cases: list[_StressCase] = []
        for case in cases:
            if case.category not in covered:
                covered.add(case.category)
                coverage_cases.append(case)
            else:
                remaining_cases.append(case)
        selected_cases = (coverage_cases + remaining_cases)[: budget.max_cases]
    else:
        selected_cases = cases[: budget.max_cases]
    _check_deadline(deadline, "case selection")
    return (
        workspace,
        corpus_info,
        report_build_root,
        report_target,
        report_relative,
        cases,
        selected_cases,
    )


def run_stress(
    *,
    corpus_dir: str | Path | None = None,
    workspace_root: str | Path | None = None,
    build_dir: str | Path = "build",
    report_path: str | Path | None = None,
    seed: int = DEFAULT_SEED,
    max_cases: int = 64,
    max_total_seconds: float = 5.0,
    max_case_seconds: float = 0.25,
    max_input_bytes: int = 64 * 1024,
    max_report_bytes: int = 2 * 1024 * 1024,
) -> dict[str, Any]:
    """Run bounded parser/path/schema stress cases without network or child processes.

    Time limits are cooperative: a case is marked failed after it returns if it
    exceeded its per-case budget. The harness intentionally does not claim to
    provide an operating-system sandbox or hard preemption.
    """

    budget = StressBudget(
        max_cases=max_cases,
        max_total_seconds=max_total_seconds,
        max_case_seconds=max_case_seconds,
        max_input_bytes=max_input_bytes,
        max_report_bytes=max_report_bytes,
    )
    budget.validate()
    if not isinstance(seed, int):
        raise TypeError("seed must be an integer")

    run_started = time.perf_counter()
    deadline = run_started + budget.max_total_seconds
    environment_before = dict(os.environ)
    tracing_was_active = tracemalloc.is_tracing()
    if not tracing_was_active:
        tracemalloc.start()
    preprocessing_current_before, _ = tracemalloc.get_traced_memory()
    try:
        (
            workspace,
            corpus_info,
            report_build_root,
            report_target,
            report_relative,
            cases,
            selected_cases,
        ) = _prepare_stress_run(
            corpus_dir=corpus_dir,
            workspace_root=workspace_root,
            build_dir=build_dir,
            report_path=report_path,
            seed=seed,
            budget=budget,
            deadline=deadline,
        )
    except Exception:
        _restore_environment(environment_before)
        if not tracing_was_active and tracemalloc.is_tracing():
            tracemalloc.stop()
        raise
    preprocessing_current_after, preprocessing_peak_after = tracemalloc.get_traced_memory()
    preprocessing_peak_delta = max(
        0,
        (preprocessing_current_after if tracing_was_active else preprocessing_peak_after)
        - preprocessing_current_before,
    )
    sentinel = hashlib.sha256(f"proto-stress:{seed}:{len(cases)}".encode("ascii")).hexdigest()
    results: list[dict[str, Any]] = []
    total_input_bytes = 0
    total_temp_files = 0
    total_temp_bytes = 0
    total_budget_exhausted = False
    case_environment_mutation_count = 0
    report: dict[str, Any] | None = None
    run_directory = ""
    temporary_root_text = ""
    environment_restore_error: str | None = None
    try:
        with tempfile.TemporaryDirectory(prefix="proto-security-stress-") as run_directory:
            run_root = Path(run_directory).resolve()
            sentinel_path = run_root / ".leak-sentinel"
            sentinel_path.write_text(sentinel, encoding="ascii")

            for index, case in enumerate(selected_cases):
                elapsed_total = time.perf_counter() - run_started
                if elapsed_total >= budget.max_total_seconds:
                    total_budget_exhausted = True
                    break

                if case.input_bytes > budget.max_input_bytes:
                    results.append(
                        {
                            "name": case.name,
                            "category": case.category,
                            "status": "budget_rejected",
                            "input_bytes": case.input_bytes,
                            "elapsed_ms": 0.0,
                            "peak_traced_memory_bytes": 0,
                            "details": {"reason": "input_size_limit"},
                        }
                    )
                    continue

                current_before, _ = tracemalloc.get_traced_memory()
                if not tracing_was_active:
                    tracemalloc.reset_peak()
                case_started = time.perf_counter()
                case_environment_before = dict(os.environ)
                status = "passed"
                details: dict[str, Any]
                temp_file_count = 0
                temp_file_bytes = 0
                case_environment_delta = {
                    "added_key_count": 0,
                    "removed_key_count": 0,
                    "changed_value_count": 0,
                }
                try:
                    with tempfile.TemporaryDirectory(
                        prefix=f"case-{index:03d}-",
                        dir=run_root,
                    ) as case_directory:
                        case_root = Path(case_directory).resolve()
                        details = case.execute(case_root)
                        for created in case_root.rglob("*"):
                            if not created.is_file():
                                continue
                            created.resolve().relative_to(case_root)
                            temp_file_count += 1
                            temp_file_bytes += created.stat().st_size
                        if not bool(details.pop("passed", False)):
                            status = "failed"
                except Exception as exc:  # A crash is a stress result, not a harness crash.
                    status = "failed"
                    details = {"error_type": type(exc).__name__}
                finally:
                    case_environment_delta = _environment_delta(
                        case_environment_before,
                        dict(os.environ),
                    )
                    try:
                        _restore_environment(case_environment_before)
                    except Exception as exc:  # Preserve evidence without leaking values or names.
                        status = "failed"
                        details["environment_restore_error"] = type(exc).__name__

                if any(case_environment_delta.values()):
                    case_environment_mutation_count += 1
                    status = "failed"
                    details["environment_mutation_detected"] = True
                    details["environment_mutation_counts"] = case_environment_delta

                elapsed_case = time.perf_counter() - case_started
                current_after, peak_after = tracemalloc.get_traced_memory()
                peak_delta = max(
                    0,
                    (current_after if tracing_was_active else peak_after) - current_before,
                )
                if elapsed_case > budget.max_case_seconds:
                    status = "time_budget_exceeded"

                total_input_bytes += case.input_bytes
                total_temp_files += temp_file_count
                total_temp_bytes += temp_file_bytes
                results.append(
                    {
                        "name": case.name,
                        "category": case.category,
                        "status": status,
                        "input_bytes": case.input_bytes,
                        "elapsed_ms": round(elapsed_case * 1000, 3),
                        "peak_traced_memory_bytes": peak_delta,
                        "temporary_file_count": temp_file_count,
                        "temporary_file_bytes": temp_file_bytes,
                        "details": details,
                    }
                )

            environment_after_cases = dict(os.environ)
            environment_delta = _environment_delta(environment_before, environment_after_cases)
            environment_unchanged = environment_before == environment_after_cases
            all_temp_outputs_contained = all(
                path.resolve().is_relative_to(run_root)
                for path in run_root.rglob("*")
            )
            temporary_root_text = str(run_root)

            elapsed_seconds = time.perf_counter() - run_started
            failed_count = sum(
                result["status"] in {"failed", "time_budget_exceeded"} for result in results
            )
            report = {
            "schema_version": "proto-agent.security-stress.v1",
            "ok": (
                failed_count == 0
                and not total_budget_exhausted
                and environment_unchanged
                and case_environment_mutation_count == 0
                and all_temp_outputs_contained
            ),
            "seed": seed,
            "offline": True,
            "external_processes_started": 0,
            "network_requests_made": 0,
            "budgets": {
                "max_cases": budget.max_cases,
                "max_total_seconds": budget.max_total_seconds,
                "max_case_seconds": budget.max_case_seconds,
                "max_input_bytes": budget.max_input_bytes,
                "max_report_bytes": budget.max_report_bytes,
                "max_corpus_files": _MAX_CORPUS_FILES,
                "max_corpus_total_bytes": _MAX_CORPUS_TOTAL_BYTES,
                "max_blns_records": _MAX_BLNS_RECORDS,
                "max_available_cases": _MAX_AVAILABLE_CASES,
                "time_enforcement": "preprocessing_deadline_and_cooperative_post_case_measurement",
            },
            "corpus": corpus_info,
            "summary": {
                "available_cases": len(cases),
                "selected_cases": len(selected_cases),
                "executed_cases": len(results),
                "passed_cases": sum(result["status"] == "passed" for result in results),
                "failed_cases": failed_count,
                "budget_rejected_cases": sum(
                    result["status"] == "budget_rejected" for result in results
                ),
                "total_budget_exhausted": total_budget_exhausted,
                "case_environment_mutations": case_environment_mutation_count,
            },
            "resources": {
                "elapsed_ms": round(elapsed_seconds * 1000, 3),
                "processed_input_bytes": total_input_bytes,
                "temporary_file_count": total_temp_files,
                "temporary_file_bytes": total_temp_bytes,
                "preprocessing_peak_traced_memory_bytes": preprocessing_peak_delta,
                "peak_traced_memory_bytes": max(
                    [
                        preprocessing_peak_delta,
                        *(result["peak_traced_memory_bytes"] for result in results),
                    ],
                    default=0,
                ),
                "tracemalloc_mode": (
                    "shared_current_delta" if tracing_was_active else "owned_peak"
                ),
            },
            "leak_sentinels": {
                "environment_unchanged": environment_unchanged,
                "environment_mutation_counts": environment_delta,
                "environment_restored": False,
                "temporary_outputs_contained": all_temp_outputs_contained,
                "sentinel_not_in_result": True,
                "temporary_path_not_in_result": True,
                "temporary_directory_removed": False,
            },
            "report": {
                "written": False,
                "relative_to_build": report_relative,
            },
            "cases": results,
            "limitations": [
                "in_process_only",
                "no_os_sandbox_claim",
                "no_hard_case_preemption",
            ],
            }

            serialized = json.dumps(report, ensure_ascii=True, sort_keys=True)
            sentinel_absent = sentinel not in serialized
            temp_path_absent = temporary_root_text not in serialized
            report["leak_sentinels"]["sentinel_not_in_result"] = sentinel_absent
            report["leak_sentinels"]["temporary_path_not_in_result"] = temp_path_absent
            if not sentinel_absent or not temp_path_absent:
                report["ok"] = False
    finally:
        try:
            _restore_environment(environment_before)
        except Exception as exc:
            environment_restore_error = type(exc).__name__
        if tracing_was_active and not tracemalloc.is_tracing():
            tracemalloc.start()
        elif not tracing_was_active and tracemalloc.is_tracing():
            tracemalloc.stop()

    if report is None:
        raise RuntimeError("stress run did not produce a report")

    environment_restored = environment_before == dict(os.environ)
    report["leak_sentinels"]["environment_restored"] = environment_restored
    if environment_restore_error is not None:
        report["leak_sentinels"]["environment_restore_error"] = environment_restore_error
    report["leak_sentinels"]["temporary_directory_removed"] = not Path(run_directory).exists()
    if not environment_restored or not report["leak_sentinels"]["temporary_directory_removed"]:
        report["ok"] = False

    final_serialized = json.dumps(report, ensure_ascii=True, sort_keys=True)
    if sentinel in final_serialized or temporary_root_text in final_serialized:
        raise RuntimeError("refusing to expose stress-run sentinel data")

    if report_target is not None and report_build_root is not None:
        report["report"]["written"] = True
        _write_json_report(
            report_target,
            report_build_root,
            report,
            max_bytes=budget.max_report_bytes,
        )

    return report


__all__ = ["DEFAULT_SEED", "StressBudget", "run_stress"]
