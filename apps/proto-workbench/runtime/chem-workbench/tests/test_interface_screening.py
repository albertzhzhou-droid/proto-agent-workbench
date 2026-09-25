"""Conditional candidate-response comparisons and exported data integrity."""

from __future__ import annotations

import copy
from pathlib import Path

import pytest

from chem_workbench.design_candidates import inorganic_candidates, organic_candidates
from chem_workbench.design_studio import DesignStudio, default_study, empty_decision
from chem_workbench.interface_screening import OBJECTIVES, screen_interfaces
from chem_workbench.interface_simulation import illustrative_interface_spec
from chem_workbench.visualization import content_hash


@pytest.fixture(scope="module")
def candidates():
    return (
        organic_candidates({"fragment_ids": ["methyl", "hydroxyethyl"]})["candidates"],
        inorganic_candidates({"a_elements": ["Sr"], "b_pairs": [["Sc", "Nb"]]})["candidates"],
    )


@pytest.mark.parametrize("profile", list(OBJECTIVES))
def test_equal_parameters_do_not_invent_a_chemical_winner(candidates, profile):
    organic, inorganic = candidates
    specs = [illustrative_interface_spec(profile, item, inorganic[0]) for item in organic]
    result = screen_interfaces(
        {"profile": profile, "objective": OBJECTIVES[profile]}, specs, organic, inorganic
    )
    assert result["winner"] is None
    assert all(row["tied_best"] for row in result["rows"])
    assert result["measured_performance_claim"] is False
    assert all(sim["balances"]["passed"] for sim in result["simulations"])


@pytest.mark.parametrize(
    "profile,rate",
    [
        ("electrode_electrolyte", "k0_m_s"),
        ("catalyst_reactant", "k_forward_s"),
        ("solid_liquid", "k_ads_m3_mol_s"),
    ],
)
def test_pair_specific_kinetics_change_conditional_response_not_descriptor_rank(
    candidates, profile, rate
):
    organic, inorganic = candidates
    specs = [illustrative_interface_spec(profile, item, inorganic[0]) for item in organic]
    # Short-time response before equilibrium; this tests the independently expected rate direction.
    for spec in specs:
        spec["time_grid"]["values"] = [0, 0.01, 0.1]
    specs[0]["parameters"][rate]["value"] *= 0.01
    result = screen_interfaces(
        {"profile": profile, "objective": OBJECTIVES[profile]}, specs, organic, inorganic
    )
    assert result["winner"]["organic"] == organic[1]["candidate_hash"]
    assert result["rows"][0]["value"] > result["rows"][1]["value"]
    assert result["scientifically_calibrated"] is False


@pytest.mark.parametrize("change", ["temperature", "initial", "time", "pair", "binding"])
def test_incomparable_or_unbound_screening_is_rejected(candidates, change):
    organic, inorganic = candidates
    specs = [illustrative_interface_spec("solid_liquid", item, inorganic[0]) for item in organic]
    if change == "temperature":
        specs[1]["parameters"]["temperature_K"]["value"] += 1
    elif change == "initial":
        specs[1]["initial_conditions"]["concentration_adsorbate_mol_m3"]["value"] *= 2
    elif change == "time":
        specs[1]["time_grid"]["values"][-1] += 1
    elif change == "pair":
        specs[1] = copy.deepcopy(specs[0])
    else:
        specs[1]["candidate_hashes"]["organic"] = "sha256:" + "0" * 64
    with pytest.raises(ValueError, match="INTERFACE_SCREENING_"):
        screen_interfaces(
            {"profile": "solid_liquid", "objective": OBJECTIVES["solid_liquid"]},
            specs,
            organic,
            inorganic,
        )


def test_studio_screening_uses_saved_libraries_and_export_import_is_data_only(tmp_path: Path):
    studio = DesignStudio(tmp_path / "original")
    study = default_study()
    study["organic"]["fragment_ids"] = ["methyl", "hydroxyethyl"]
    study["inorganic"].update(a_elements=["Sr"], b_pairs=[["Sc", "Nb"]])
    decision = empty_decision()
    decision["interfaces"] = []
    base = studio.run(
        {
            "prompt": "Generate both libraries",
            "study": study,
            "mode": "direct",
            "decision": decision,
        }
    )
    organic, inorganic = base["organic"]["candidates"], base["inorganic"]["candidates"]
    study["selected_candidates"] = {
        "run_ref": base["record_hash"],
        "organic_hash": organic[0]["candidate_hash"],
        "inorganic_hash": inorganic[0]["candidate_hash"],
    }
    study["interface_screening"] = {"profile": "solid_liquid", "objective": "max_adsorbed_coverage"}
    study["interface_parameters"] = {
        "mode": "supplied",
        "specifications": [
            illustrative_interface_spec("solid_liquid", item, inorganic[0]) for item in organic
        ],
    }
    decision = empty_decision("interface_screening")
    decision["interfaces"] = ["solid_liquid"]
    record = studio.run(
        {
            "prompt": "Compare conditional adsorption",
            "study": study,
            "mode": "direct",
            "decision": decision,
        }
    )
    assert record["state"] == "completed"
    assert record["trace"][0]["module"] == "interface_screening"
    assert record["interface_screening"]["winner"] is None
    assert record["organic"] == base["organic"]
    restored = DesignStudio(tmp_path / "restored")
    assert restored.import_record(record) == record
    assert restored.read(record["record_hash"]) == record
    # Rehashing the outer envelope must not hide altered nested scientific data.
    corrupt = copy.deepcopy(record)
    corrupt["organic"]["candidates"][0]["geometry"]["atoms"][0]["position"][0] += 1
    corrupt["record_hash"] = content_hash({k: v for k, v in corrupt.items() if k != "record_hash"})
    with pytest.raises(ValueError):
        restored.import_record(corrupt)


def test_completed_pair_evidence_survives_a_later_solver_failure(candidates, monkeypatch):
    from chem_workbench import interface_screening

    organic, inorganic = candidates
    specs = [illustrative_interface_spec("solid_liquid", item, inorganic[0]) for item in organic]
    actual = interface_screening.simulate_interface
    calls = []

    def fail_second(spec, molecule, support):
        calls.append(spec)
        if len(calls) == 2:
            raise ValueError("injected solver interruption")
        return actual(spec, molecule, support)

    monkeypatch.setattr(interface_screening, "simulate_interface", fail_second)
    with pytest.raises(interface_screening.InterfaceScreeningError) as failure:
        screen_interfaces(
            {"profile": "solid_liquid", "objective": "max_adsorbed_coverage"},
            specs,
            organic,
            inorganic,
        )
    assert len(calls) == 2
    assert len(failure.value.simulations) == 1
    assert failure.value.simulations[0]["inputs"]["spec"] == specs[0]
    assert failure.value.simulations[0]["balances"]["passed"] is True
