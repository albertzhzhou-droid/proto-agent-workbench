from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .literature import DEFAULT_LITERATURE_PATH, search_literature
from .security import write_text_bounded


EVIDENCE_SCHEMA_VERSION = "proto-agent.evidence.v1"


STEP_CLAIMS = {
    "check": "Design syntax, references, and local constraints were checked.",
    "compile": "Design compiled into typed JSON IR.",
    "sequence_validate": "Assembled construct sequences passed local sequence constraints.",
    "score": "Design received a local software-readiness score.",
    "export_sbol": "Design was exported to an SBOL-like exchange artifact.",
    "sbol_validate": "SBOL-like export passed local structural validation.",
    "export_genbank": "Design was exported to a GenBank-like exchange artifact.",
    "export_fasta": "Design was exported to FASTA.",
}


def build_evidence_cards(
    manifest: dict[str, Any],
    literature_query: str | None = None,
    literature_registry: str | Path = DEFAULT_LITERATURE_PATH,
    literature_limit: int = 5,
) -> dict[str, Any]:
    cards = []
    for index, step in enumerate(manifest.get("steps", []), start=1):
        cards.append(_card_from_step(index, manifest, step))

    if manifest.get("sequence_validation"):
        cards.append(_sequence_card(len(cards) + 1, manifest))
    if manifest.get("sbol_validation"):
        cards.append(_sbol_card(len(cards) + 1, manifest))
    if manifest.get("score"):
        cards.append(_score_card(len(cards) + 1, manifest))

    cards.append(_review_gate_card(len(cards) + 1, manifest))

    if literature_query:
        cards.append(
            _literature_card(
                len(cards) + 1,
                literature_query,
                literature_registry,
                literature_limit,
            )
        )

    return {
        "schema_version": EVIDENCE_SCHEMA_VERSION,
        "run_id": manifest.get("run_id", ""),
        "manifest_path": manifest.get("manifest_path", ""),
        "cards": cards,
        "summary": _summarize_cards(cards),
    }


def write_evidence_cards(cards_payload: dict[str, Any], path: str | Path) -> Path:
    output_path = Path(path)
    write_text_bounded(output_path, json.dumps(cards_payload, indent=2) + "\n", boundary=output_path.parent)
    return output_path


def _card_from_step(index: int, manifest: dict[str, Any], step: dict[str, Any]) -> dict[str, Any]:
    step_id = step.get("id", f"step_{index}")
    return {
        "id": f"evidence-{index:03d}-{step_id}",
        "claim": STEP_CLAIMS.get(step_id, f"Workflow step '{step_id}' was evaluated."),
        "evidence_type": "workflow_step",
        "source": f"manifest:{manifest.get('run_id', '')}:{step_id}",
        "status": _step_status(step),
        "artifacts": step.get("artifacts", []),
        "details": {
            "required": bool(step.get("required", True)),
            "skipped": bool(step.get("skipped", False)),
            "diagnostics": step.get("diagnostics", []),
        },
    }


def _sequence_card(index: int, manifest: dict[str, Any]) -> dict[str, Any]:
    report = manifest.get("sequence_validation", {})
    return {
        "id": f"evidence-{index:03d}-sequence-summary",
        "claim": "Local sequence validation produced a construct-level report.",
        "evidence_type": "validator_result",
        "source": f"manifest:{manifest.get('run_id', '')}:sequence_validation",
        "status": "supported" if report.get("ok") else "failed",
        "artifacts": [],
        "details": report,
    }


def _sbol_card(index: int, manifest: dict[str, Any]) -> dict[str, Any]:
    report = manifest.get("sbol_validation", {})
    return {
        "id": f"evidence-{index:03d}-sbol-summary",
        "claim": "Local SBOL structural validation produced an interoperability report.",
        "evidence_type": "validator_result",
        "source": f"manifest:{manifest.get('run_id', '')}:sbol_validation",
        "status": "supported" if report.get("ok") else "failed",
        "artifacts": [],
        "details": report,
    }


def _score_card(index: int, manifest: dict[str, Any]) -> dict[str, Any]:
    score = manifest.get("score", {})
    return {
        "id": f"evidence-{index:03d}-score-summary",
        "claim": "Local scoring produced a reviewable design summary.",
        "evidence_type": "validator_result",
        "source": f"manifest:{manifest.get('run_id', '')}:score",
        "status": "supported" if score.get("ok") else "failed",
        "artifacts": [],
        "details": score,
    }


def _review_gate_card(index: int, manifest: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": f"evidence-{index:03d}-human-review-gate",
        "claim": "Human scientific review is required before real-world use.",
        "evidence_type": "human_review_gate",
        "source": f"manifest:{manifest.get('run_id', '')}:review_status",
        "status": "needs_review",
        "artifacts": [manifest.get("manifest_path", "")],
        "details": {
            "review_status": manifest.get("review_status", "human_review_required"),
            "safety_boundary": (
                "Software validation only; this packet does not certify wet-lab readiness, "
                "orderability, biosafety, or regulatory compliance."
            ),
        },
    }


def _literature_card(
    index: int,
    query: str,
    literature_registry: str | Path,
    literature_limit: int,
) -> dict[str, Any]:
    result = search_literature(query, literature_registry, literature_limit)
    return {
        "id": f"evidence-{index:03d}-literature-notes",
        "claim": f"Local source notes were searched for: {query}",
        "evidence_type": "literature_source",
        "source": str(literature_registry),
        "status": "supported" if result.get("matches") else "needs_review",
        "artifacts": [],
        "details": result,
    }


def _step_status(step: dict[str, Any]) -> str:
    if step.get("skipped"):
        return "not_applicable"
    if step.get("ok"):
        return "supported"
    if step.get("required", True):
        return "failed"
    return "needs_review"


def _summarize_cards(cards: list[dict[str, Any]]) -> dict[str, Any]:
    counts: dict[str, int] = {
        "supported": 0,
        "failed": 0,
        "needs_review": 0,
        "not_applicable": 0,
    }
    for card in cards:
        status = card.get("status", "needs_review")
        counts[status] = counts.get(status, 0) + 1
    return {
        "card_count": len(cards),
        "status_counts": counts,
        "failed_card_ids": [card["id"] for card in cards if card.get("status") == "failed"],
        "needs_review_card_ids": [card["id"] for card in cards if card.get("status") == "needs_review"],
    }
