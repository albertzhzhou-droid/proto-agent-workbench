"""Independent evidence axes; execution and eligibility never establish validity."""
from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict

DataOrigin = Literal["fixture", "synthetic", "imported", "governed-snapshot", "unknown"]
ExecutionStatus = Literal["not-run", "running", "completed", "error", "cancelled", "effect-unknown", "incomplete-evidence", "unverifiable", "unknown"]
MethodMaturity = Literal["not-established", "numerical-reference-tested", "method-implementation", "demonstration", "heuristic"]
METHOD_MATURITIES = frozenset({"not-established", "numerical-reference-tested", "method-implementation", "demonstration", "heuristic"})


class EvidenceStanding(TypedDict):
    dataOrigin: DataOrigin
    eligibility: NotRequired[Literal["DESIGN_ELIGIBLE", "QUARANTINED", "unknown"]]
    methodMaturity: Literal["not-established", "numerical-reference-tested", "method-implementation", "demonstration", "heuristic"]
    executionStatus: ExecutionStatus
    humanReview: Literal["required", "reviewed-supported", "reviewed-rejected"]


TOY_LIBRARY_NOTICE = "Toy development fixture. Replace with a reviewed parts library before any real design work."


def evidence_standing(*, method_maturity: MethodMaturity, data_origin: DataOrigin = "unknown", execution_status: ExecutionStatus = "unknown") -> EvidenceStanding:
    if not isinstance(method_maturity, str) or method_maturity not in METHOD_MATURITIES:
        raise ValueError("An explicit supported method maturity is required.")
    return {"dataOrigin": data_origin, "methodMaturity": method_maturity, "executionStatus": execution_status, "humanReview": "required"}


def library_data_origin(metadata: Any) -> DataOrigin:
    """Recognize the existing explicit fixture notice, never a path or part ID.

    Other library metadata is not proof of governance. The review verifier can
    separately establish materialization provenance and attach eligibility.
    """
    if isinstance(metadata, dict) and metadata.get("notice") == TOY_LIBRARY_NOTICE:
        return "fixture"
    return "unknown"


def standing_from_manifest(manifest: dict[str, Any]) -> EvidenceStanding:
    """Old manifests remain visibly unknown; software success grants no review."""
    candidate = manifest.get("evidence_standing")
    if isinstance(candidate, dict):
        origin = candidate.get("dataOrigin", "unknown")
        if origin in ("fixture", "synthetic", "imported", "governed-snapshot", "unknown"):
            maturity = candidate.get("methodMaturity", "not-established")
            status = candidate.get("executionStatus", "unknown")
            result = evidence_standing(data_origin=origin,
                method_maturity=maturity if isinstance(maturity, str) and maturity in METHOD_MATURITIES else "not-established",
                execution_status=status if status in ("not-run", "running", "completed", "error", "cancelled", "effect-unknown", "incomplete-evidence", "unverifiable", "unknown") else "unknown")
            if candidate.get("humanReview") in ("required", "reviewed-supported", "reviewed-rejected"):
                result["humanReview"] = candidate["humanReview"]
            if candidate.get("eligibility") in ("DESIGN_ELIGIBLE", "QUARANTINED", "unknown"):
                result["eligibility"] = candidate["eligibility"]
            return result
    return evidence_standing(method_maturity="not-established", execution_status="completed" if manifest.get("ok") else "error")
