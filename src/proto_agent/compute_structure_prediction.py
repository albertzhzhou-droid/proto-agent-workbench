"""Import a bounded local ColabFold result, without running a prediction engine.

The handler consumes already guarded bytes. PDB identity and CA coordinates reuse
compute_structures; additional checks enforce this importer's narrower producer
format rather than claiming support for arbitrary experimental PDB files.
"""
from __future__ import annotations

import hashlib
import json
import math

from .compute_structures import _comparison_chain, _residue_identity
from .security import _validate_relative_path_text


SCHEMA_VERSION = "proto-agent.structure-prediction-import.v1"
MAX_RESIDUES = 384
MAX_STRUCTURE_BYTES = 2 * 1024 * 1024
MAX_SCORES_BYTES = 4 * 1024 * 1024
MAX_RESULT_BYTES = 4 * 1024 * 1024
BF_PLDDT_TOLERANCE = 0.0100001
MAX_PAE_ROUNDING_TOLERANCE = 0.0050001
# Operational input bound, not a universal scientific maximum for PAE.
MAX_PAE_ANGSTROM = 1000.0


class StructurePredictionImportError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _fail(code, message):
    raise StructurePredictionImportError(code, message)


def _number(value, label, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail("INVALID_CONFIDENCE_VALUE", f"{label} must be a finite number in [{low}, {high}].")
    if not low <= value <= high or not math.isfinite(value):
        _fail("INVALID_CONFIDENCE_VALUE", f"{label} must be finite and in [{low}, {high}].")
    return float(value)


def _decode_scores(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                _fail("INVALID_SCORES_JSON", f"Duplicate scores JSON property: {key}.")
            result[key] = value
        return result

    def reject_constant(value):
        _fail("INVALID_SCORES_JSON", f"Nonfinite scores JSON value {value} is not allowed.")

    try:
        scores = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=pairs, parse_constant=reject_constant)
    except (UnicodeError, RecursionError, ValueError) as error:
        if isinstance(error, StructurePredictionImportError):
            raise
        _fail("INVALID_SCORES_JSON", f"Scores must be UTF-8 ColabFold scores JSON: {error}")
    if not isinstance(scores, dict):
        _fail("INVALID_SCORES_JSON", "Supply the per-model ColabFold scores JSON object, not an AFDB PAE list or a pickle.")
    nodes = 0

    def inspect(value, depth=0):
        nonlocal nodes
        nodes += 1
        if nodes > MAX_RESIDUES ** 2 + 20000 or depth > 10:
            _fail("SCORES_LIMIT", "Scores JSON exceeds the bounded import depth or item count.")
        if isinstance(value, dict):
            if len(value) > 100 or any(len(key) > 128 for key in value):
                _fail("SCORES_LIMIT", "Scores JSON contains too many or oversized property names.")
            for child in value.values():
                inspect(child, depth + 1)
        elif isinstance(value, list):
            if len(value) > MAX_RESIDUES:
                _fail("SCORES_LIMIT", f"Scores JSON arrays must not exceed {MAX_RESIDUES} items.")
            for child in value:
                inspect(child, depth + 1)
        elif isinstance(value, float) and not math.isfinite(value):
            _fail("INVALID_SCORES_JSON", "Scores JSON contains a nonfinite number.")
        elif isinstance(value, str) and len(value) > 4096:
            _fail("SCORES_LIMIT", "Scores JSON contains an oversized string.")
    inspect(scores)
    return scores


def _structure(raw):
    try:
        text = raw.decode("ascii", "strict")
    except UnicodeError:
        _fail("INVALID_PDB", "ColabFold PDB input must be ASCII fixed-column text.")
    residue_order, atoms, ca_bfactors, chain_order = [], {}, {}, []
    terminated_chains = set()
    model_open, explicit_model, saw_atoms, ended = False, False, False, False
    model_count, end_model_count = 0, 0
    for line_number, line in enumerate(text.splitlines(), 1):
        record = line[:6].strip()
        if ended and record in {"ATOM", "HETATM", "MODEL", "ENDMDL", "TER"}:
            _fail("INVALID_PDB", f"Structural records follow END at line {line_number}.")
        if record == "MODEL":
            model_count += 1
            if model_count > 1 or model_open or saw_atoms:
                _fail("UNSUPPORTED_PDB_MODEL", "Import one ColabFold model per PDB; mixed or multiple MODEL records are not supported.")
            model_open, explicit_model = True, True
        elif record == "ENDMDL":
            if not model_open:
                _fail("INVALID_PDB", "ENDMDL has no matching MODEL.")
            end_model_count += 1
            model_open = False
        elif record == "END":
            if model_open:
                _fail("INVALID_PDB", "PDB MODEL is not closed before END.")
            ended = True
        elif record == "TER":
            if (explicit_model and not model_open) or not residue_order or residue_order[-1][0] in terminated_chains:
                _fail("INVALID_PDB", f"TER requires an open observed chain at line {line_number}.")
            # TER closes the preceding polymer chain even when its identifying
            # columns are absent. Never concatenate a later segment.
            terminated_chains.add(residue_order[-1][0])
        elif record == "HETATM":
            _fail("UNSUPPORTED_PDB_COMPONENT", "This ColabFold import profile accepts polymer ATOM records only; HETATM needs a separate reviewed importer.")
        elif record == "ATOM":
            if explicit_model and not model_open:
                _fail("INVALID_PDB", f"ATOM outside the declared MODEL at line {line_number}.")
            saw_atoms = True
            if len(line) < 66:
                _fail("INVALID_PDB", f"ATOM record lacks coordinates, occupancy or B-factor at line {line_number}.")
            if line[16].strip() or line[26].strip():
                _fail("UNSUPPORTED_PDB_IDENTITY", "ColabFold import does not accept alternate locations or insertion codes; they are not silently collapsed.")
            chain, name, atom = line[21].strip(), line[17:20].strip(), line[12:16].strip()
            if chain and not chain.isalnum() or not name or not atom:
                _fail("INVALID_PDB", f"Invalid chain, residue or atom identity at line {line_number}.")
            if chain in terminated_chains:
                _fail("PDB_ORDER_MISMATCH", f"Chain {chain!r} resumes after TER at line {line_number}; separate polymer segments are not concatenated.")
            try:
                number = int(line[22:26])
                xyz = [float(line[30:38]), float(line[38:46]), float(line[46:54])]
                occupancy, bfactor = float(line[54:60]), float(line[60:66])
            except ValueError:
                _fail("INVALID_PDB", f"Invalid fixed-column numeric field at line {line_number}.")
            if number < 1 or not all(math.isfinite(value) and abs(value) <= 1e6 for value in xyz):
                _fail("INVALID_PDB", f"Residue number must be positive and all ATOM coordinates finite/bounded at line {line_number}.")
            if not math.isfinite(occupancy) or not 0 < occupancy <= 1:
                _fail("INVALID_PDB", f"Observed ATOM occupancy must be in (0, 1] at line {line_number}.")
            if not math.isfinite(bfactor) or not 0 <= bfactor <= 100:
                _fail("PDB_PLDDT_RANGE", f"PDB B-factor must encode pLDDT in [0, 100], not an experimental temperature factor (line {line_number}).")
            key = (chain, number, "")
            if not residue_order or key != residue_order[-1]:
                if key in atoms:
                    _fail("PDB_ORDER_MISMATCH", "Residue atoms must form one contiguous block; repeated residue blocks are ambiguous.")
                if residue_order and chain == residue_order[-1][0] and number != residue_order[-1][1] + 1:
                    _fail("PDB_RESIDUE_GAP", "Within each imported chain, residue numbering must be consecutive; missing residues are not reconstructed.")
                if not chain_order or chain != chain_order[-1]:
                    if chain in chain_order:
                        _fail("PDB_ORDER_MISMATCH", "Each chain must form one contiguous block in the producer's PDB order.")
                    chain_order.append(chain)
                    if len(chain_order) > 62:
                        _fail("STRUCTURE_LIMIT", "ColabFold PDB import supports at most 62 chains.")
                residue_order.append(key)
                atoms[key] = {"name": name, "atoms": {}, "line": line_number}
                if len(residue_order) > MAX_RESIDUES:
                    _fail("STRUCTURE_LIMIT", f"This bounded result importer supports at most {MAX_RESIDUES} residues.")
            entry = atoms[key]
            if entry["name"] != name or atom in entry["atoms"]:
                _fail("DUPLICATE_PDB_IDENTITY", f"Duplicate atom or conflicting residue name at line {line_number}.")
            entry["atoms"][atom] = bfactor
            if atom == "CA":
                ca_bfactors[key] = bfactor
    if not ended or model_count != end_model_count:
        _fail("INCOMPLETE_PDB", "ColabFold PDB input requires END and balanced MODEL/ENDMDL records.")
    if not residue_order:
        _fail("INVALID_PDB", "PDB input contains no observed polymer residues.")
    for key in residue_order:
        if key not in ca_bfactors:
            _fail("MISSING_CA", f"Residue {key} lacks CA coordinates; confidence indices cannot be aligned by skipping it.")
        if any(abs(value - ca_bfactors[key]) > BF_PLDDT_TOLERANCE for value in atoms[key]["atoms"].values()):
            _fail("PDB_PLDDT_INCONSISTENT", f"Atoms within residue {key} disagree on pLDDT beyond {BF_PLDDT_TOLERANCE:g} points.")
    # Identity/coordinates come from the same parser used by structure comparison.
    records, chains = [], []
    try:
        for chain in chain_order:
            selected, metadata = _comparison_chain(raw, None, chain, "prediction")
            if len(metadata["available_models"]) != 1 or metadata["unknown_residues"]:
                _fail("UNSUPPORTED_PDB_IDENTITY", "Import requires one model with canonical amino-acid identities; unknown residues need explicit preprocessing.")
            start = len(records)
            records.extend(selected)
            sequence = "".join(item["one_letter"] for item in selected)
            chains.append({"chain": chain, "model": metadata["model"], "sequence": sequence,
                           "sequence_sha256": hashlib.sha256(sequence.encode("ascii")).hexdigest(),
                           "start_index": start, "stop_index": len(records), "residue_count": len(selected)})
    except ValueError as error:
        if isinstance(error, StructurePredictionImportError):
            raise
        _fail("INVALID_PDB", str(error))
    parsed_order = [(item["chain"], item["residue_number"], item["insertion_code"]) for item in records]
    if parsed_order != residue_order:
        _fail("PDB_ORDER_MISMATCH", "CA parser identity order differs from the complete ATOM residue order.")
    return records, chains, [ca_bfactors[key] for key in residue_order]


def import_colabfold_result(arguments, files):
    """Validate already-read local bytes and return source-bound result data only."""
    if not isinstance(arguments, dict) or set(arguments) - {"structure_path", "scores_path", "expected_chains"}:
        _fail("INVALID_IMPORT_ARGUMENTS", "Use structure_path, scores_path and optional expected_chains only.")
    sources, raw_files = {}, {}
    for field, suffix, maximum in (("structure_path", ".pdb", MAX_STRUCTURE_BYTES), ("scores_path", ".json", MAX_SCORES_BYTES)):
        path = arguments.get(field)
        if not isinstance(path, str) or not path.lower().endswith(suffix):
            _fail("INVALID_IMPORT_ARGUMENTS", f"{field} must name a workspace-relative {suffix} file.")
        _validate_relative_path_text(path)
        raw = files.get(field) if isinstance(files, dict) else None
        if not isinstance(raw, bytes) or not raw or len(raw) > maximum:
            _fail("IMPORT_INPUT_MISSING_OR_LARGE", f"{field} requires 1 to {maximum} already-guarded source bytes.")
        raw_files[field] = raw
        sources[field] = {"path": path.replace("\\", "/"), "sha256": hashlib.sha256(raw).hexdigest(), "size_bytes": len(raw)}
    records, chains, bfactors = _structure(raw_files["structure_path"])
    scores = _decode_scores(raw_files["scores_path"])
    count = len(records)
    if "plddt" not in scores:
        _fail("MISSING_PLDDT", "The per-model ColabFold scores JSON must contain plddt; B-factors are not used as an invented JSON fallback.")
    if not isinstance(scores["plddt"], list) or len(scores["plddt"]) != count:
        _fail("PLDDT_LENGTH_MISMATCH", f"scores.plddt must contain exactly {count} values, one per observed PDB residue in file order.")
    plddt = [_number(value, f"plddt[{index}]", 0, 100) for index, value in enumerate(scores["plddt"])]
    for index, (score, bfactor) in enumerate(zip(plddt, bfactors)):
        if abs(score - bfactor) > BF_PLDDT_TOLERANCE:
            identity = _residue_identity(records[index])
            _fail("PLDDT_BFACTOR_MISMATCH", f"scores.plddt[{index}]={score:g} differs from PDB CA B-factor {bfactor:g} at {identity} beyond rounding tolerance {BF_PLDDT_TOLERANCE:g}.")
    expected = arguments.get("expected_chains")
    if expected is not None:
        if not isinstance(expected, list) or len(expected) != len(chains):
            _fail("EXPECTED_CHAIN_MISMATCH", "expected_chains must match every observed chain in PDB encounter order.")
        for supplied, observed in zip(expected, chains):
            if not isinstance(supplied, dict) or set(supplied) != {"chain", "sequence"}:
                _fail("EXPECTED_CHAIN_MISMATCH", "Each expected chain requires exactly chain and sequence.")
            sequence = supplied["sequence"]
            if supplied["chain"] != observed["chain"] or not isinstance(sequence, str) or not sequence.isascii() or sequence.upper() != observed["sequence"]:
                _fail("EXPECTED_CHAIN_MISMATCH", f"Expected chain identity or sequence differs from observed chain {observed['chain']!r}; no alignment or renumbering is inferred.")
    diagnostics = []
    if expected is None:
        diagnostics.append({"code": "EXPECTED_SEQUENCE_NOT_SUPPLIED", "message": "Observed sequences were not compared with an independently supplied expected sequence."})
    pae = {"status": "unavailable", "unit": "angstrom", "reason": "scores JSON has no pae matrix", "values": None}
    if "pae" in scores:
        matrix = scores["pae"]
        if not isinstance(matrix, list) or len(matrix) != count or any(not isinstance(row, list) or len(row) != count for row in matrix):
            _fail("PAE_SHAPE_MISMATCH", f"pae must be a {count} x {count} matrix matching all PDB residues; no chain slice is inferred.")
        matrix = [[_number(value, f"pae[{i}][{j}]", 0, MAX_PAE_ANGSTROM) for j, value in enumerate(row)] for i, row in enumerate(matrix)]
        matrix_max = max(max(row) for row in matrix)
        reported_max = None
        if "max_pae" in scores:
            reported_max = _number(scores["max_pae"], "max_pae", 0, MAX_PAE_ANGSTROM)
            if abs(reported_max - matrix_max) > MAX_PAE_ROUNDING_TOLERANCE:
                _fail("MAX_PAE_MISMATCH", f"ColabFold max_pae={reported_max:g} must match the rounded matrix maximum {matrix_max:g} within {MAX_PAE_ROUNDING_TOLERANCE:g} angstrom; it is not a theoretical PAE ceiling.")
        else:
            diagnostics.append({"code": "MAX_PAE_UNAVAILABLE", "message": "No producer max_pae field was supplied; matrix maximum is descriptive only."})
        pae = {"status": "available", "unit": "angstrom", "values": matrix, "shape": [count, count],
               "source_field": "/pae", "observed_matrix_max": matrix_max, "reported_max_pae": reported_max,
               "max_pae_rounding_tolerance": MAX_PAE_ROUNDING_TOLERANCE,
               "axis_mapping": "Both axes index residues in the returned PDB order; producer row/column orientation is preserved without transposition or symmetrization."}
    else:
        if "max_pae" in scores:
            _fail("PAE_MISSING", "max_pae was supplied without its pae matrix; the bound cannot be checked.")
        diagnostics.append({"code": "PAE_UNAVAILABLE", "message": "PAE is absent; no inter-residue confidence or matrix has been invented."})
    scalar_confidence = {}
    for field in ("ptm", "iptm"):
        scalar_confidence[field] = ({"status": "available", "value": _number(scores[field], field, 0, 1), "unit": "score-0-1", "source_field": f"/{field}"}
                                    if field in scores else {"status": "unavailable", "value": None, "reason": f"scores JSON has no {field}"})
    if "iptm" in scores and len(chains) == 1:
        diagnostics.append({"code": "IPTM_WITH_SINGLE_CHAIN", "message": "ipTM is present for one observed chain; its interface applicability is unestablished."})
    unimported_fields = sorted(set(scores) - {"plddt", "pae", "max_pae", "ptm", "iptm"})
    if unimported_fields:
        diagnostics.append({"code": "UNIMPORTED_SCORE_FIELDS", "message": "Additional producer fields are retained only through the source hash, not interpreted by this importer."})
    result = {
        "schema_version": SCHEMA_VERSION, "operation": "result-import", "prediction_execution": "not-performed",
        "scope": "local-result-import-only; predictor confidence is not experimental validation",
        "sources": sources,
        "structure": {"format": "colabfold-pdb-import-profile", "coordinate_unit": "angstrom", "model": records[0]["model"],
                      "residue_count": count, "chain_count": len(chains), "chains": chains,
                      "residues": [{"index": index, "identity": _residue_identity(record), "coordinates_angstrom": record["coordinates"],
                                    "plddt": plddt[index], "pdb_ca_bfactor_plddt": bfactors[index], "plddt_source_pointer": f"/plddt/{index}"}
                                   for index, record in enumerate(records)]},
        "confidence": {"source": "scores_path", "interpretation": "predictor-confidence-not-experimental-validation",
                       "plddt": {"status": "available", "unit": "score-0-100", "source_field": "/plddt", "values": plddt,
                                 "mean": sum(plddt) / count, "minimum": min(plddt), "maximum": max(plddt)},
                       "pae": pae, **scalar_confidence},
        "mapping": {"index_base": 0, "order": "PDB ATOM residue encounter order, grouped in contiguous chains; not author-residue-number indexing",
                    "expected_sequence_status": "exact-match-uppercase-normalized" if expected is not None else "not-supplied",
                    "bfactor_plddt_status": "consistent-within-rounding", "bfactor_plddt_tolerance": BF_PLDDT_TOLERANCE,
                    "same_prediction_provenance": "unestablished"},
        "unimported_score_fields": unimported_fields, "diagnostics": diagnostics,
        "limitations": ["This operation imports existing local result bytes; it does not execute, resume or certify completion of a prediction job.",
                        "Matching lengths, residue identities and pLDDT/B-factors show content consistency, not proof that both files came from the same prediction run.",
                        "pLDDT, PAE, pTM and ipTM are predictor confidence outputs, not experimental accuracy, biological function or clinical validation.",
                        "This bounded ColabFold profile requires canonical residues, one model, consecutive numbering within each chain, one CA per residue and no alternate locations, insertion codes or HETATM components.",
                        "PAE is retained in the producer's matrix order and is not forced symmetric. Missing metrics remain unavailable.",
                        "Only CA coordinates are returned; all supplied ATOM numeric fields are checked, but geometry, side-chain completeness and stereochemistry are not validated."],
    }
    if len((json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")) > MAX_RESULT_BYTES:
        _fail("IMPORT_RESULT_TOO_LARGE", "Complete import result exceeds 4 MiB; no PAE or residue rows are silently truncated.")
    return result


TOOLS = {"import_colabfold_result": {
    "title": "Import local ColabFold result",
    "description": "Import a local single-model ColabFold PDB and per-model scores JSON with explicit residue mapping and source hashes; no prediction is executed.",
    "implementation": "proto-native", "upstream_functions": [], "dependency": [],
    "method_references": ["https://github.com/sokrypton/ColabFold/blob/main/colabfold/batch.py", "https://alphafold.ebi.ac.uk/faq"],
    "file_inputs": {"structure_path": {"extensions": [".pdb"], "max_bytes": MAX_STRUCTURE_BYTES},
                    "scores_path": {"extensions": [".json"], "max_bytes": MAX_SCORES_BYTES}},
    "input_schema": {"type": "object", "additionalProperties": False, "required": ["structure_path", "scores_path"], "properties": {
        "structure_path": {"type": "string", "minLength": 1, "maxLength": 400},
        "scores_path": {"type": "string", "minLength": 1, "maxLength": 400},
        "expected_chains": {"type": "array", "minItems": 1, "maxItems": 62, "items": {
            "type": "object", "additionalProperties": False, "required": ["chain", "sequence"], "properties": {
                "chain": {"type": "string", "maxLength": 1},
                "sequence": {"type": "string", "minLength": 1, "maxLength": MAX_RESIDUES}}}}}},
    "example": {"structure_path": "build/compute-inputs/prediction.pdb", "scores_path": "build/compute-inputs/scores.json"},
}}
HANDLERS = {"import_colabfold_result": import_colabfold_result}
