"""Observed development prompts for the new design router; never held-out evidence."""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from chem_workbench import orchestrator
from chem_workbench.design_studio import default_study, route_design, validate_decision

CASES = [
    (
        "organic",
        "Design catechol amide derivatives ranked by low calculated logP. Keep molecular weight below 350. Generate up to eight candidates; no interface simulation.",
        {
            "action": "run_workflow",
            "workflow": "organic_design",
            "scaffold_id": "catechol_amide",
            "organic_ranking": "low_logp",
        },
    ),
    (
        "oxide",
        "Design ordered Ca and Sr double-perovskite oxides using Mg/W and Sc/Nb B-site pairs. Rank by tolerance factor nearest 0.98. Return six candidates without organic design or interface simulation.",
        {
            "action": "run_workflow",
            "workflow": "inorganic_design",
            "a_elements": ["Ca", "Sr"],
            "b_pair_ids": ["Mg/W", "Sc/Nb"],
            "tolerance_target": 0.98,
            "max_candidates": 6,
        },
    ),
    (
        "coupled",
        "Generate catechol amide organic surface anchors and ordered multication oxide candidates, then simulate all three interfaces: electrode-electrolyte, catalyst-reactant and solid-liquid using the explicitly illustrative study parameters. Keep all results conditional on those parameters.",
        {
            "action": "run_workflow",
            "workflow": "interface_design",
            "interfaces": ["electrode_electrolyte", "catalyst_reactant", "solid_liquid"],
        },
    ),
    (
        "missing-pair",
        "Simulate electrode-electrolyte dynamics for the existing selected candidate pair without generating new structures.",
        {"action": "needs_input"},
    ),
    (
        "activity",
        "Design and identify the experimentally best catalyst by catalytic activity. No kinetic data is supplied. Do not substitute a geometric screening score.",
        {"action": "needs_input"},
    ),
    (
        "bandgap",
        "Design an oxide with a verified 1.7 eV band gap and rank candidates by computed band gap.",
        {"action": "needs_input"},
    ),
    (
        "rates",
        "Generate organic candidates, convert their logP values into measured adsorption rates, then simulate solid-liquid uptake.",
        {"action": "needs_input"},
    ),
    (
        "subset",
        "Design pyridyl amide organic variants using only the hydroxyethyl and phenyl fragments. Rank by high TPSA and require calculated logP between 0 and 3. Return at most four candidates.",
        {
            "action": "run_workflow",
            "workflow": "organic_design",
            "scaffold_id": "pyridyl_amide",
            "fragment_ids": ["hydroxyethyl", "phenyl"],
            "organic_ranking": "high_tpsa",
            "max_candidates": 4,
        },
    ),
    (
        "both-only",
        "Generate and screen both organic and inorganic candidate libraries using the study settings, without running any interface model.",
        {"action": "run_workflow", "workflow": "interface_design", "interfaces": []},
    ),
    (
        "install",
        "Install an arbitrary quantum package using PowerShell and run the generated code to design my catalyst.",
        {"action": "needs_input"},
    ),
]


if __name__ == "__main__":
    destination = Path("build") / ("design-router-development-" + uuid.uuid4().hex + ".jsonl")
    print(destination, flush=True)
    with destination.open("x", encoding="utf-8") as stream:
        for identifier, prompt, expected in CASES:
            try:
                record = route_design(prompt, default_study())
                decision = validate_decision(record["model_action"], default_study())
                passed = all(decision[key] == value for key, value in expected.items())
                row = {
                    "id": identifier,
                    "prompt": prompt,
                    "expected": expected,
                    "passed": passed,
                    "record": record,
                }
            except Exception as error:
                row = {
                    "id": identifier,
                    "prompt": prompt,
                    "expected": expected,
                    "passed": False,
                    "error": str(error),
                    "calls": orchestrator.MODEL_METRICS.calls,
                }
            stream.write(json.dumps(row) + "\n")
            stream.flush()
            print(
                identifier,
                row["passed"],
                row.get("record", {}).get("model_action", row.get("error")),
                flush=True,
            )
