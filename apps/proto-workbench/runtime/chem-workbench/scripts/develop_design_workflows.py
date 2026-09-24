"""Observed end-to-end development cases; never held-out promotion evidence."""

from __future__ import annotations

import argparse
import copy
import json
import uuid
from pathlib import Path

from develop_design_router import CASES

from chem_workbench.design_studio import DesignRunError, DesignStudio, default_study, empty_decision
from chem_workbench.interface_screening import OBJECTIVES
from chem_workbench.interface_simulation import illustrative_interface_spec


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", action="append", default=[], help="Known development case ID")
    arguments = parser.parse_args()
    directory = Path("build") / ("design-development-" + uuid.uuid4().hex)
    directory.mkdir()
    studio = DesignStudio(directory / "workspace")
    cases = [(key, prompt, expected, default_study()) for key, prompt, expected in CASES]
    for scaffold in ("carboxylate_amide", "pyridyl_amide"):
        study = default_study()
        study["organic"]["scaffold_id"] = scaffold
        cases.append(
            (
                scaffold + "-no-interface",
                "Generate organic candidates using the current scaffold and study settings. "
                "Only rank the calculated descriptors; do not simulate any interface.",
                {"action": "run_workflow", "workflow": "organic_design"},
                study,
            )
        )
        cases.append(
            (
                scaffold + "-missing-mechanism",
                "Use the current scaffold unchanged and simulate its solid-liquid "
                "mechanism. No additional mechanism is supplied.",
                {"action": "needs_input"},
                study,
            )
        )
    study = default_study()
    study["organic"].update(fragment_ids=["methyl", "pyridyl"])
    study["inorganic"].update(a_elements=["Sr"], b_pairs=[["Sc", "Nb"], ["Y", "Ta"]])
    direct = empty_decision()
    direct["interfaces"] = []
    saved = studio.run(
        {"prompt": "Development library", "study": study, "mode": "direct", "decision": direct}
    )
    organic, inorganic = saved["organic"]["candidates"], saved["inorganic"]["candidates"]
    study["selected_candidates"] = {
        "run_ref": saved["record_hash"],
        "organic_hash": organic[0]["candidate_hash"],
        "inorganic_hash": inorganic[0]["candidate_hash"],
    }
    for profile, objective in OBJECTIVES.items():
        selected = copy.deepcopy(study)
        selected["interface_screening"] = {"profile": profile, "objective": objective}
        specs = [illustrative_interface_spec(profile, item, inorganic[0]) for item in organic]
        selected["interface_parameters"] = {"mode": "supplied", "specifications": specs}
        cases.append(
            (
                "compare-" + profile,
                f"Compare the supplied candidate-bound {profile} scenarios from the saved "
                f"library using the registered {objective} objective. Keep numerical ties. "
                "Do not generate new candidates or claim measured performance.",
                {
                    "action": "run_workflow",
                    "workflow": "interface_screening",
                    "interfaces": [profile],
                },
                selected,
            )
        )
    no_data = default_study()
    no_data["interface_parameters"] = {"mode": "none", "specifications": []}
    cases.append(
        (
            "no-kinetics",
            "Generate both candidate families and predict their "
            "electrode-electrolyte response without supplying any kinetic data.",
            {"action": "needs_input"},
            no_data,
        )
    )
    four_pairs = copy.deepcopy(study)
    four_pairs["interface_screening"] = {
        "profile": "catalyst_reactant",
        "objective": "max_product_pool",
    }
    four_pairs["interface_parameters"] = {
        "mode": "supplied",
        "specifications": [
            illustrative_interface_spec("catalyst_reactant", a, b)
            for a in organic
            for b in inorganic
        ],
    }
    cases.append(
        (
            "compare-four-catalyst",
            "Compare all four supplied catalyst-reactant candidate-pair scenarios using the "
            "study's final product pool objective. Retain ties and label the declared illustrative "
            "parameter scenario. Do not infer measured catalyst activity.",
            {
                "action": "run_workflow",
                "workflow": "interface_screening",
                "interfaces": ["catalyst_reactant"],
            },
            four_pairs,
        )
    )
    if arguments.case:
        requested = set(arguments.case)
        if requested - {item[0] for item in cases}:
            parser.error("Unknown development case ID")
        cases = [item for item in cases if item[0] in requested]
    passed = 0
    print(directory, flush=True)
    with (directory / "attempts.jsonl").open("x", encoding="utf-8") as stream:
        for key, prompt, expected, study in cases:
            request = {"prompt": prompt, "study": study, "mode": "model", "decision": None}
            try:
                record = studio.run(request)
                action = record["sampled_decision"]
                ok = all(action[field] == value for field, value in expected.items())
                ok = ok and record["state"] == (
                    "needs_input" if expected["action"] == "needs_input" else "completed"
                )
            except DesignRunError as error:
                record, ok = error.record, False
            row = {"id": key, "expected_subset": expected, "passed": ok, "record": record}
            stream.write(json.dumps(row) + "\n")
            stream.flush()
            passed += ok
            print(key, ok, record["state"], record.get("decision"), flush=True)
    print(f"Development outcome: {passed}/{len(cases)}", flush=True)


if __name__ == "__main__":
    main()
