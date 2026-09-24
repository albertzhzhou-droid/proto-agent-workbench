"""Reviewed output adapters: declared data, units and entities are all required.

Existing numeric fields are preserved. Quantity nodes are additional evidence,
not scientific validation. No scale or biological identity is guessed.
"""
from __future__ import annotations

from typing import Any
from .scientific_contracts import QUANTITY_SCHEMA, ScientificContractError, validate_quantity

QUANTITY_SUPPORTED = frozenset({"descriptive_statistics", "normalize_gene_expression_counts"})


def _error(message: str) -> None:
    raise ScientificContractError("COMPUTE_QUANTITY_BINDING_INVALID", message)


def _binding(value: Any, contexts: list[dict]) -> tuple[dict, list]:
    if not isinstance(value, dict) or set(value) != {"dataset_id", "entity_id", "unit", "quantity_kind"}:
        _error("A quantity binding must declare dataset_id, entity_id, unit and quantity_kind.")
    matches = [item["manifest"] for item in contexts if item["manifest"]["dataset_id"] == value["dataset_id"]]
    if len(matches) != 1:
        _error("Quantity bindings require one verified declared dataset.")
    dataset = matches[0]
    # Validate the unit and entity even if no declared measurements match.
    probe = {"schema_version": QUANTITY_SCHEMA, "value": 0,
             **{key: value[key] for key in ("entity_id", "unit", "quantity_kind")}}
    validate_quantity(probe, entity_ids={item["id"] for item in dataset["entities"]})
    measurements = [q["value"] for q in dataset["quantities"]
                    if all(q.get(key) == value[key] for key in ("entity_id", "unit", "quantity_kind"))]
    if not measurements or any(item is None for item in measurements):
        _error("The bound dataset must declare nonmissing measurements with the selected entity and unit.")
    return probe, measurements


def validate_bindings(tool: str, arguments: dict, bindings: Any, contexts: list[dict]) -> None:
    """Run before calculation and in fingerprint preflight, never after writes."""
    if bindings is None:
        return
    if tool not in QUANTITY_SUPPORTED:
        _error("This method has no reviewed quantity output adapter.")
    if not isinstance(bindings, dict):
        _error("quantity_bindings must be an object.")
    if tool == "descriptive_statistics":
        if set(bindings) != {"values"}:
            _error("descriptive_statistics requires a values quantity binding.")
        _, measurements = _binding(bindings["values"], contexts)
        if measurements != arguments["values"]:
            _error("Statistics values must equal the selected dataset measurements in declared order.")
    else:
        if set(bindings) != {"libraries"} or not isinstance(bindings["libraries"], dict):
            _error("RNA count normalization requires a libraries mapping keyed by sample_id.")
        samples, counts = arguments["sample_ids"], arguments["counts"]
        if set(bindings["libraries"]) != set(samples):
            _error("Every sample must have exactly one declared library quantity binding.")
        if any(not isinstance(row, list) or len(row) != len(samples) for row in counts):
            _error("Count rows must match the declared samples.")
        for index, sample in enumerate(samples):
            probe, measurements = _binding(bindings["libraries"][sample], contexts)
            if probe["unit"] != "count" or probe["quantity_kind"] != "value":
                _error("Library totals require the count unit and value kind.")
            if measurements != [sum(row[index] for row in counts)]:
                _error("Each declared library count must equal its supplied count-matrix column total.")


def add_result_quantities(tool: str, arguments: dict, result: dict, bindings: Any, contexts: list[dict]) -> dict:
    if bindings is None:
        return result
    validate_bindings(tool, arguments, bindings, contexts)
    quantities: dict[str, Any] = {}
    if tool == "descriptive_statistics":
        probe, _ = _binding(bindings["values"], contexts)
        fields = ["minimum", "maximum"]
        # Integer count/index units cannot represent fractional means/quantiles.
        # Variances need squared units; spread of absolute temperatures needs an
        # interval kind. Those fields deliberately remain unquantified here.
        if probe["unit"] not in {"count", "residue", "base_pair", "index"}:
            fields += ["mean", "median", "q1", "q3"]
        for field in fields:
            quantities[field] = validate_quantity({**probe, "value": result[field]})
    else:
        quantities["libraries"] = []
        for library in result["libraries"]:
            probe, _ = _binding(bindings["libraries"][library["sample_id"]], contexts)
            quantities["libraries"].append({"sample_id": library["sample_id"], "total_counts":
                validate_quantity({**probe, "value": library["total_counts"]})})
    # Put the bounded contracted outputs first so a large ordinary table cannot
    # consume the value-index budget before its library-count quantities.
    return {"quantities": quantities, **result}
