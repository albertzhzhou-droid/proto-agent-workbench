"""First repository-owned read-only CIF probe adapter (QUERY_ONLY, RFC/ADR-0003).

This module parses a bounded CIF 1.1 subset with a fail-closed, dependency-free
scanner and classifies a source against the ``cif-p1-explicit-v1`` profile:
exactly one data block, complete cell parameters, explicit fractional sites
with type symbols, unit occupancies, and identity symmetry only. It produces a
bounded summary and a schema-valid loss report; it emits no typed structure,
because decimal quantities are outside the exact-integer alpha
canonicalization. The capability is registered in the package-owned static
registry and resolved from it at runtime; nothing here installs, imports, or
executes third-party code.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import Any

from chem_workbench.adapters.registry import load_bundled_registry
from chem_workbench.adapters.validation import (
    AdapterContractError,
    canonical_format_capability_hash,
    validate_loss_report,
)
from chem_workbench.chemir.constraints import ELEMENT_SYMBOLS

ADAPTER_ID = "chem.cif.probe"
ADAPTER_VERSION = "0.1.0"
CAPABILITY_ID = "chem.cif.probe.cif-p1-explicit.import"
IMPORT_CAPABILITY_ID = "chem.cif.probe.cif-p1-explicit.structure-import"
PROBE_PROFILE = "cif-p1-explicit-v1"

_MAX_TOKENS = 2_000_000
_MAX_ITEMS = 100_000
_MAX_LOOPS = 10_000
_MAX_COLUMNS = 4_096
_MAX_TAG_LENGTH = 512

_NUMERIC = re.compile(r"^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?(?:\([0-9]+\))?$")
_STANDARD_UNCERTAINTY = re.compile(r"\([0-9]+\)$")
_ELEMENT_PREFIX = re.compile(r"^([A-Za-z]{1,2})")
_KNOWN_SPACE_GROUP = {"p1", "p 1"}

_CELL_TAGS = (
    "_cell_length_a",
    "_cell_length_b",
    "_cell_length_c",
    "_cell_angle_alpha",
    "_cell_angle_beta",
    "_cell_angle_gamma",
)
_FRACTIONAL_TAGS = (
    "_atom_site_fract_x",
    "_atom_site_fract_y",
    "_atom_site_fract_z",
)
_SYMMETRY_OPERATION_TAGS = (
    "_symmetry_equiv_pos_as_xyz",
    "_space_group_symop_operation_xyz",
)
_SPACE_GROUP_NAME_TAGS = (
    "_symmetry_space_group_name_h-m",
    "_space_group_name_h-m_alt",
)
_SPACE_GROUP_NUMBER_TAGS = ("_space_group_it_number",)
_CONSUMED_TAGS = frozenset(
    {
        *_CELL_TAGS,
        *_FRACTIONAL_TAGS,
        "_atom_site_type_symbol",
        "_atom_site_label",
        "_atom_site_occupancy",
        *_SYMMETRY_OPERATION_TAGS,
        *_SPACE_GROUP_NAME_TAGS,
        *_SPACE_GROUP_NUMBER_TAGS,
    }
)


class CifSyntaxError(ValueError):
    """Raised for bounded CIF grammar violations discovered by the scanner."""

    def __init__(self, code: str, message: str, line: int, column: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.line = line
        self.column = column


@dataclass(frozen=True, slots=True)
class Token:
    kind: str  # "data" | "loop" | "tag" | "value"
    value: str
    line: int
    column: int


@dataclass(slots=True)
class Loop:
    columns: list[str]
    column_lines: dict[str, int]
    rows: list[list[str]] = field(default_factory=list)
    start_line: int = 1


@dataclass(slots=True)
class Block:
    name: str
    line: int
    column: int
    items: dict[str, tuple[str, int, int]] = field(default_factory=dict)
    item_tag_lines: dict[str, int] = field(default_factory=dict)
    loops: list[Loop] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class CifProbeResult:
    summary: dict[str, Any]
    loss_report: dict[str, Any]

    @property
    def admitted(self) -> bool:
        return bool(self.summary["admitted"])


@dataclass(frozen=True, slots=True)
class CifAnalysis:
    """Shared admission analysis for the probe and structure-import capabilities."""

    summary: dict[str, Any]
    issues: list[_Issue]
    input_hash: dict[str, str]
    blocks: list[Block]


class _Scanner:
    def __init__(self, text: str) -> None:
        self.lines = text.splitlines()
        self.line_index = 0
        self.column = 0

    def _current_line(self) -> str | None:
        if self.line_index >= len(self.lines):
            return None
        return self.lines[self.line_index]

    def next_token(self) -> Token | None:
        line = self._current_line()
        while line is not None:
            rest = line[self.column :]
            if not rest.strip():
                self.line_index += 1
                self.column = 0
                line = self._current_line()
                continue
            stripped = rest.lstrip()
            offset = len(rest) - len(stripped)
            self.column += offset
            position = self.column + 1
            if stripped.startswith("#"):
                self.line_index += 1
                self.column = 0
                line = self._current_line()
                continue
            if self.column == 0 and stripped.startswith(";"):
                return self._text_field(self.line_index + 1, 1)
            token_text, width = self._take_token(stripped)
            self.column += width
            return Token(self._classify(token_text), token_text, self.line_index + 1, position)
        return None

    def _text_field(self, line: int, column: int) -> Token:
        closing = self.line_index + 1
        while closing < len(self.lines) and not self.lines[closing].startswith(";"):
            closing += 1
        if closing >= len(self.lines):
            raise CifSyntaxError(
                "CIF_SYNTAX_ERROR",
                "Semicolon text field is never terminated.",
                line,
                column,
            )
        content = "\n".join(self.lines[self.line_index + 1 : closing])
        self.line_index = closing + 1
        self.column = 0
        return Token("value", content, line, column)

    @staticmethod
    def _take_token(stripped: str) -> tuple[str, int]:
        quote = stripped[0]
        if quote in ("'", '"'):
            index = 1
            while index < len(stripped):
                if stripped[index] == quote and (
                    index + 1 == len(stripped) or stripped[index + 1].isspace()
                ):
                    return stripped[: index + 1], index + 1
                index += 1
            raise CifSyntaxError(
                "CIF_SYNTAX_ERROR",
                "Quoted value is not terminated on its line.",
                0,
                0,
            )
        width = 0
        while width < len(stripped) and not stripped[width].isspace():
            width += 1
        return stripped[:width], width

    @staticmethod
    def _classify(token_text: str) -> str:
        lowered = token_text.lower()
        if lowered.startswith("data_"):
            return "data"
        if lowered == "loop_":
            return "loop"
        if token_text.startswith("_"):
            return "tag"
        if lowered.startswith(("save_", "global_", "stop_")):
            raise CifSyntaxError(
                "CIF_SYNTAX_ERROR",
                f"Reserved CIF construct {token_text!r} is outside the probe profile.",
                0,
                0,
            )
        return "value"


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] in ("'", '"') and value[-1] == value[0]:
        return value[1:-1]
    return value


def parse_cif_text(text: str) -> list[Block]:
    """Parse a bounded single-purpose CIF subset into data blocks."""
    scanner = _Scanner(text)
    blocks: list[Block] = []
    block: Block | None = None
    phase = "items"
    pending_tag: Token | None = None
    loop: Loop | None = None
    loop_values: list[str] = []
    tokens = 0

    def close_loop() -> None:
        nonlocal loop, loop_values, phase
        if loop is None:
            return
        if loop.columns and len(loop_values) % len(loop.columns) != 0:
            raise CifSyntaxError(
                "CIF_LOOP_ROW_INCOMPLETE",
                f"Loop starting at line {loop.start_line} has an incomplete final row.",
                loop.start_line,
                1,
            )
        assert block is not None
        row: list[str] = []
        for value in loop_values:
            row.append(value)
            if len(row) == len(loop.columns):
                loop.rows.append(row)
                row = []
        block.loops.append(loop)
        loop = None
        loop_values = []
        phase = "items"

    while True:
        token = scanner.next_token()
        if token is None:
            break
        tokens += 1
        if tokens > _MAX_TOKENS:
            raise CifSyntaxError(
                "CIF_SYNTAX_ERROR",
                "CIF source exceeds the probe token limit.",
                token.line,
                token.column,
            )
        if token.kind == "data":
            name = token.value[5:]
            if not name:
                raise CifSyntaxError(
                    "CIF_SYNTAX_ERROR", "Data block name is empty.", token.line, token.column
                )
            close_loop()
            pending_tag = None
            block = Block(name, token.line, token.column)
            blocks.append(block)
            phase = "items"
            continue
        if block is None:
            raise CifSyntaxError(
                "CIF_SYNTAX_ERROR",
                "Content appears before the first data block.",
                token.line,
                token.column,
            )
        if token.kind == "loop":
            close_loop()
            pending_tag = None
            loop = Loop([], {}, [], token.line)
            if len(blocks[-1].loops) + 1 > _MAX_LOOPS:
                raise CifSyntaxError(
                    "CIF_SYNTAX_ERROR",
                    "CIF source exceeds the probe loop limit.",
                    token.line,
                    token.column,
                )
            phase = "loop_tags"
            continue
        if token.kind == "tag":
            if len(token.value) > _MAX_TAG_LENGTH or not token.value[1:].strip():
                raise CifSyntaxError(
                    "CIF_SYNTAX_ERROR",
                    f"Malformed CIF tag {token.value!r}.",
                    token.line,
                    token.column,
                )
            tag = token.value.lower()
            if phase == "loop_tags":
                assert loop is not None
                if tag in loop.columns:
                    raise CifSyntaxError(
                        "CIF_DUPLICATE_ITEM",
                        f"Loop declares column {tag!r} more than once.",
                        token.line,
                        token.column,
                    )
                if len(loop.columns) + 1 > _MAX_COLUMNS:
                    raise CifSyntaxError(
                        "CIF_SYNTAX_ERROR",
                        "CIF loop exceeds the probe column limit.",
                        token.line,
                        token.column,
                    )
                loop.columns.append(tag)
                loop.column_lines[tag] = token.line
                continue
            close_loop()
            pending_tag = token
            phase = "items"
            continue
        # value token
        if phase == "loop_tags":
            assert loop is not None
            if not loop.columns:
                raise CifSyntaxError(
                    "CIF_SYNTAX_ERROR",
                    "Loop has no columns before its first value.",
                    token.line,
                    token.column,
                )
            phase = "loop_values"
        if phase == "loop_values":
            assert loop is not None
            if pending_tag is not None:
                raise CifSyntaxError(
                    "CIF_SYNTAX_ERROR",
                    "A loop value appears where a single item value was expected.",
                    token.line,
                    token.column,
                )
            loop_values.append(token.value)
            continue
        if pending_tag is None:
            raise CifSyntaxError(
                "CIF_SYNTAX_ERROR",
                f"Value {token.value!r} appears without a preceding tag.",
                token.line,
                token.column,
            )
        tag = pending_tag.value.lower()
        if tag in block.items:
            raise CifSyntaxError(
                "CIF_DUPLICATE_ITEM",
                f"Item {tag!r} is declared more than once.",
                pending_tag.line,
                pending_tag.column,
            )
        if len(block.items) + 1 > _MAX_ITEMS:
            raise CifSyntaxError(
                "CIF_SYNTAX_ERROR",
                "CIF data block exceeds the probe item limit.",
                token.line,
                token.column,
            )
        block.items[tag] = (_unquote(token.value), token.line, token.column)
        block.item_tag_lines[tag] = pending_tag.line
        pending_tag = None
    close_loop()
    if pending_tag is not None:
        raise CifSyntaxError(
            "CIF_SYNTAX_ERROR",
            f"Item {pending_tag.value.lower()!r} has no value.",
            pending_tag.line,
            pending_tag.column,
        )
    return blocks


@dataclass(frozen=True, slots=True)
class _Issue:
    code: str
    severity: str
    disposition: str
    feature: str
    message: str
    suggestion: str
    line: int
    column: int


def _is_unknown(value: str) -> bool:
    return value in {"?", "."}


def _numeric_without_uncertainty(value: str) -> str | None:
    if _NUMERIC.fullmatch(value) is None:
        return None
    return _STANDARD_UNCERTAINTY.sub("", value)


def _identity_symmetry_operation(operation: str) -> bool:
    return operation.replace(" ", "").lower() in {"x,y,z", ""}


def bundled_capability(capability_id: str) -> dict[str, Any]:
    """Return one registered CIF adapter capability from the package trust root."""
    registry = load_bundled_registry()
    for registration in registry.document["adapters"]:
        manifest = registration["manifest"]
        if manifest["adapter_id"] == ADAPTER_ID and manifest["adapter_version"] == ADAPTER_VERSION:
            for record in registration["format_capabilities"]:
                capability: dict[str, Any] = record["capability"]
                if capability["capability_id"] == capability_id:
                    return capability
    raise AdapterContractError(f"CIF capability {capability_id!r} is not in the bundled registry")


def bundled_cif_capability() -> dict[str, Any]:
    """Return the registered QUERY_ONLY probe capability."""
    return bundled_capability(CAPABILITY_ID)


def analyze_cif_bytes(source: bytes) -> CifAnalysis:
    """Analyze CIF bytes against the registered explicit P1 profile."""
    digest = hashlib.sha256(source).hexdigest()
    input_hash = {"type": "source_sha256", "algorithm": "sha256", "value": digest}
    issues: list[_Issue] = []
    summary: dict[str, Any] = {
        "capability_id": CAPABILITY_ID,
        "profile": PROBE_PROFILE,
        "data_block": None,
        "admitted": False,
        "site_count": 0,
        "elements": [],
        "element_counts": {},
        "cell_parameters": {},
        "cell_complete": False,
        "symmetry_operations": 0,
        "symmetry_identity_only": False,
        "space_group_name": None,
        "standard_uncertainty_count": 0,
        "unknown_value_count": 0,
        "unmapped_tags": [],
        "issue_codes": [],
    }
    try:
        text = source.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError(f"CIF source is not valid UTF-8 at byte {error.start}") from error
    try:
        blocks = parse_cif_text(text)
    except CifSyntaxError as error:
        issues.append(
            _Issue(
                code=error.code,
                severity="error",
                disposition="unsupported",
                feature="cif syntax",
                message=error.message,
                suggestion="Fix the CIF syntax or use a file inside the probe profile.",
                line=error.line if error.line > 0 else 1,
                column=error.column if error.column > 0 else 1,
            )
        )
        summary["issue_codes"] = [issues[0].code]
        return CifAnalysis(summary, issues, input_hash, [])

    if not blocks:
        issues.append(
            _Issue(
                code="NO_DATA_BLOCK",
                severity="error",
                disposition="unsupported",
                feature="cif data block",
                message="The file contains no data block.",
                suggestion="Provide a CIF file with exactly one data_ block.",
                line=1,
                column=1,
            )
        )
        return CifAnalysis(summary, issues, input_hash, [])
    if len(blocks) > 1:
        issues.append(
            _Issue(
                code="MULTIPLE_DATA_BLOCKS",
                severity="error",
                disposition="unsupported",
                feature="cif data block",
                message=f"The file contains {len(blocks)} data blocks; the profile admits one.",
                suggestion="Split the file so each source has exactly one data block.",
                line=blocks[1].line,
                column=blocks[1].column,
            )
        )
        return CifAnalysis(summary, issues, input_hash, [])

    block = blocks[0]
    summary["data_block"] = block.name
    uncertainty_count = 0
    unknown_count = 0
    seen_tags: set[str] = set()

    for tag, (value, _line, _column) in block.items.items():
        if _is_unknown(value):
            unknown_count += 1
        if tag in _CONSUMED_TAGS:
            seen_tags.add(tag)

    cell_parameters: dict[str, str] = {}
    for tag in _CELL_TAGS:
        entry = block.items.get(tag)
        if entry is None:
            issues.append(
                _Issue(
                    code="MISSING_CELL_PARAMETER",
                    severity="error",
                    disposition="unsupported",
                    feature=tag,
                    message=f"Required cell parameter {tag!r} is missing.",
                    suggestion="Provide all six cell parameters.",
                    line=block.line,
                    column=block.column,
                )
            )
            continue
        value, line, column = entry
        if _is_unknown(value):
            unknown_count += 1
            issues.append(
                _Issue(
                    code="MISSING_CELL_PARAMETER",
                    severity="error",
                    disposition="unsupported",
                    feature=tag,
                    message=f"Cell parameter {tag!r} has an unknown value.",
                    suggestion="Provide a numeric cell parameter.",
                    line=line,
                    column=column,
                )
            )
            continue
        if _numeric_without_uncertainty(value) is None:
            issues.append(
                _Issue(
                    code="NON_NUMERIC_SITE_VALUE",
                    severity="error",
                    disposition="unsupported",
                    feature=tag,
                    message=f"Cell parameter {tag!r} is not a CIF number.",
                    suggestion="Provide a numeric cell parameter without units.",
                    line=line,
                    column=column,
                )
            )
            continue
        if _STANDARD_UNCERTAINTY.search(value) is not None:
            uncertainty_count += 1
        cell_parameters[tag] = value
    summary["cell_parameters"] = dict(sorted(cell_parameters.items()))
    summary["cell_complete"] = len(cell_parameters) == len(_CELL_TAGS)

    site_loop: Loop | None = None
    for candidate in block.loops:
        if all(tag in candidate.columns for tag in _FRACTIONAL_TAGS):
            if site_loop is not None:
                issues.append(
                    _Issue(
                        code="MISSING_FRACTIONAL_SITES",
                        severity="error",
                        disposition="unsupported",
                        feature="cif atom_site loop",
                        message="More than one loop declares fractional coordinates.",
                        suggestion="Provide exactly one atom_site loop.",
                        line=candidate.start_line,
                        column=1,
                    )
                )
                break
            site_loop = candidate
    if site_loop is None:
        issues.append(
            _Issue(
                code="MISSING_FRACTIONAL_SITES",
                severity="error",
                disposition="unsupported",
                feature="cif atom_site loop",
                message="No loop provides _atom_site_fract_x, _y, and _z together.",
                suggestion="List explicit fractional sites in one atom_site loop.",
                line=block.line,
                column=block.column,
            )
        )
    else:
        seen_tags.update(site_loop.columns)
        summary["site_count"] = len(site_loop.rows)
        has_type_symbol = "_atom_site_type_symbol" in site_loop.columns
        if not has_type_symbol:
            issues.append(
                _Issue(
                    code="MISSING_TYPE_SYMBOL",
                    severity="error",
                    disposition="unsupported",
                    feature="_atom_site_type_symbol",
                    message="The atom_site loop does not declare _atom_site_type_symbol.",
                    suggestion="Add a type symbol column; element inference is not performed.",
                    line=site_loop.start_line,
                    column=1,
                )
            )
        occupancy_column: int | None = None
        if "_atom_site_occupancy" in site_loop.columns:
            occupancy_column = site_loop.columns.index("_atom_site_occupancy")
        else:
            issues.append(
                _Issue(
                    code="CIF_OCCUPANCY_DEFAULTED",
                    severity="info",
                    disposition="normalized",
                    feature="_atom_site_occupancy",
                    message=(
                        "No occupancy column is present; the CIF default of 1 applies "
                        "and is recorded rather than silently assumed for calculation."
                    ),
                    suggestion="Declare occupancy 1 explicitly to remove this notice.",
                    line=site_loop.start_line,
                    column=1,
                )
            )
        element_counts: dict[str, int] = {}
        for row in site_loop.rows:
            for index, tag in enumerate(site_loop.columns):
                if tag in _FRACTIONAL_TAGS:
                    value = row[index]
                    if _is_unknown(value):
                        unknown_count += 1
                        issues.append(
                            _Issue(
                                code="UNKNOWN_SITE_VALUE",
                                severity="error",
                                disposition="unsupported",
                                feature=tag,
                                message=f"Site value for {tag!r} is unknown.",
                                suggestion="Provide an explicit fractional coordinate.",
                                line=site_loop.start_line,
                                column=1,
                            )
                        )
                    elif _numeric_without_uncertainty(value) is None:
                        issues.append(
                            _Issue(
                                code="NON_NUMERIC_SITE_VALUE",
                                severity="error",
                                disposition="unsupported",
                                feature=tag,
                                message=f"Site value for {tag!r} is not a CIF number.",
                                suggestion="Provide a numeric fractional coordinate.",
                                line=site_loop.start_line,
                                column=1,
                            )
                        )
                    elif _STANDARD_UNCERTAINTY.search(value) is not None:
                        uncertainty_count += 1
                elif tag == "_atom_site_type_symbol" and has_type_symbol:
                    value = row[index]
                    if _is_unknown(value):
                        unknown_count += 1
                        issues.append(
                            _Issue(
                                code="UNKNOWN_ELEMENT",
                                severity="error",
                                disposition="unsupported",
                                feature="_atom_site_type_symbol",
                                message=f"Type symbol {value!r} is unknown.",
                                suggestion="Provide an explicit element type symbol.",
                                line=site_loop.start_line,
                                column=1,
                            )
                        )
                        continue
                    match = _ELEMENT_PREFIX.match(_unquote(value))
                    element = match.group(1).capitalize() if match else ""
                    if element not in ELEMENT_SYMBOLS:
                        issues.append(
                            _Issue(
                                code="UNKNOWN_ELEMENT",
                                severity="error",
                                disposition="unsupported",
                                feature="_atom_site_type_symbol",
                                message=f"Type symbol {value!r} is not a known element.",
                                suggestion="Use a standard element symbol such as Cu.",
                                line=site_loop.start_line,
                                column=1,
                            )
                        )
                        continue
                    element_counts[element] = element_counts.get(element, 0) + 1
                elif tag == "_atom_site_occupancy" and occupancy_column is not None:
                    value = row[index]
                    if _is_unknown(value):
                        unknown_count += 1
                        issues.append(
                            _Issue(
                                code="PARTIAL_OCCUPANCY",
                                severity="review_required",
                                disposition="unsupported",
                                feature="_atom_site_occupancy",
                                message=(
                                    "A site occupancy is unknown; disorder cannot be ruled out."
                                ),
                                suggestion=(
                                    "Declare explicit occupancy or use a fully occupied source."
                                ),
                                line=site_loop.start_line,
                                column=1,
                            )
                        )
                        continue
                    numeric = _numeric_without_uncertainty(value)
                    if numeric is None or float(numeric) != 1.0:
                        issues.append(
                            _Issue(
                                code="PARTIAL_OCCUPANCY",
                                severity="review_required",
                                disposition="unsupported",
                                feature="_atom_site_occupancy",
                                message=(
                                    "A site occupancy is not exactly 1; average and "
                                    "disordered structures are outside this profile."
                                ),
                                suggestion=(
                                    "Use a fully occupied explicit source; average occupancy "
                                    "requires the future disorder profile."
                                ),
                                line=site_loop.start_line,
                                column=1,
                            )
                        )
                    elif _STANDARD_UNCERTAINTY.search(value) is not None:
                        uncertainty_count += 1
        summary["element_counts"] = dict(sorted(element_counts.items()))
        summary["elements"] = sorted(element_counts)

    operations: list[str] = []
    for tag in _SYMMETRY_OPERATION_TAGS:
        for candidate in block.loops:
            if tag in candidate.columns:
                seen_tags.update(candidate.columns)
                operations.extend(row[candidate.columns.index(tag)] for row in candidate.rows)
    identity_only = not operations or all(
        _identity_symmetry_operation(_unquote(operation)) for operation in operations
    )
    summary["symmetry_operations"] = len(operations)
    summary["symmetry_identity_only"] = identity_only
    if not identity_only:
        issues.append(
            _Issue(
                code="SYMMETRY_EXPANSION_REQUIRED",
                severity="error",
                disposition="unsupported",
                feature="cif symmetry operations",
                message=(
                    f"The file lists {len(operations)} symmetry operations; only the "
                    "identity is admitted without a reviewed expansion algorithm."
                ),
                suggestion="Export the structure with all sites listed explicitly in P 1.",
                line=block.line,
                column=block.column,
            )
        )
    for tag in _SPACE_GROUP_NAME_TAGS:
        entry = block.items.get(tag)
        if entry is not None:
            seen_tags.add(tag)
            value, line, column = entry
            summary["space_group_name"] = value
            if _is_unknown(value):
                unknown_count += 1
            elif value.replace(" ", "").lower() not in _KNOWN_SPACE_GROUP:
                issues.append(
                    _Issue(
                        code="SYMMETRY_EXPANSION_REQUIRED",
                        severity="error",
                        disposition="unsupported",
                        feature=tag,
                        message=f"Space group {value!r} requires symmetry expansion.",
                        suggestion="Use a P 1 export with explicit sites.",
                        line=line,
                        column=column,
                    )
                )
    for tag in _SPACE_GROUP_NUMBER_TAGS:
        entry = block.items.get(tag)
        if entry is not None:
            seen_tags.add(tag)
            value, line, column = entry
            numeric = _numeric_without_uncertainty(value)
            if numeric is None or int(float(numeric)) != 1:
                issues.append(
                    _Issue(
                        code="SYMMETRY_EXPANSION_REQUIRED",
                        severity="error",
                        disposition="unsupported",
                        feature=tag,
                        message=f"Space group number {value!r} is not 1.",
                        suggestion="Use a P 1 export with explicit sites.",
                        line=line,
                        column=column,
                    )
                )

    unmapped = sorted(
        tag
        for tag in (
            *block.items,
            *(column for candidate in block.loops for column in candidate.columns),
        )
        if tag not in seen_tags
    )
    if unmapped:
        preview = ", ".join(unmapped[:16])
        issues.append(
            _Issue(
                code="UNMAPPED_CIF_ITEMS_PRESERVED",
                severity="info",
                disposition="preserved",
                feature="cif items",
                message=(
                    f"{len(unmapped)} CIF item(s) are outside the probe profile and "
                    f"preserved in the source only: {preview}."
                ),
                suggestion="No action is required; the probe reads a bounded item set.",
                line=block.line,
                column=block.column,
            )
        )
        summary["unmapped_tags"] = unmapped[:64]
    if uncertainty_count:
        issues.append(
            _Issue(
                code="STANDARD_UNCERTAINTY_STRIPPED",
                severity="info",
                disposition="normalized",
                feature="cif standard uncertainties",
                message=(
                    f"{uncertainty_count} value(s) carry a standard uncertainty in "
                    "parentheses; the probe records but does not propagate it."
                ),
                suggestion="No action is required for a read-only probe.",
                line=block.line,
                column=block.column,
            )
        )
    summary["standard_uncertainty_count"] = uncertainty_count
    summary["unknown_value_count"] = unknown_count
    summary["issue_codes"] = sorted({issue.code for issue in issues})
    summary["admitted"] = not any(
        issue.severity == "error" or issue.disposition == "unsupported" for issue in issues
    )
    return CifAnalysis(summary, issues, input_hash, blocks)


def probe_cif_bytes(source: bytes) -> CifProbeResult:
    """Probe CIF bytes against the registered QUERY_ONLY capability."""
    analysis = analyze_cif_bytes(source)
    report = build_loss_report(
        capability=bundled_cif_capability(),
        classification="QUERY_ONLY" if analysis.summary["admitted"] else "UNSUPPORTED",
        issues=analysis.issues,
        input_hash=analysis.input_hash,
        output_hash=None,
    )
    return CifProbeResult(summary=analysis.summary, loss_report=report)


def build_loss_report(
    *,
    capability: dict[str, Any],
    classification: str,
    issues: list[_Issue],
    input_hash: dict[str, str],
    output_hash: dict[str, str] | None,
) -> dict[str, Any]:
    """Bind issues to one registered capability as a schema-valid loss report."""
    report = {
        "loss_report_version": "loss/v1alpha1",
        "adapter": capability["adapter"],
        "capability_hash": canonical_format_capability_hash(capability),
        "direction": capability["direction"],
        "format": capability["format"],
        "profile": capability["profile"],
        "input_hash": input_hash,
        "output_hash": output_hash,
        "classification": classification,
        "issues": [
            {
                "code": issue.code,
                "severity": issue.severity,
                "location": {
                    "kind": "source",
                    "source_hash": input_hash,
                    "line": issue.line,
                    "column": issue.column,
                },
                "feature": issue.feature,
                "disposition": issue.disposition,
                "message": issue.message,
                "suggestion": issue.suggestion,
                "evidence_hashes": [input_hash],
            }
            for issue in issues[:4096]
        ],
    }
    validate_loss_report(report)
    return report
