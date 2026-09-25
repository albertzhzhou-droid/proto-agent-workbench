"""Real small ODE solves verify physical invariants and independently calculated limits."""

from __future__ import annotations

import copy
import math

import pytest

from chem_workbench import interface_simulation as interface
from chem_workbench.design_candidates import inorganic_candidates, organic_candidates
from chem_workbench.visualization import content_hash

ORGANIC = organic_candidates({"max_candidates": 1, "fragment_ids": ["methyl"]})["candidates"][0]
INORGANIC = inorganic_candidates(
    {"max_candidates": 1, "a_elements": ["Sr"], "b_pairs": [["Mg", "W"]]}
)["candidates"][0]


def fixture(profile):
    return interface.illustrative_interface_spec(profile, ORGANIC, INORGANIC)


def parameter(spec, name, value):
    spec["parameters"][name]["value"] = value


def initial(spec, name, value):
    spec["initial_conditions"][name]["value"] = value


@pytest.mark.parametrize("profile", interface.PROFILE_PARAMETERS)
def test_real_trajectory_conserves_sites_molecular_pool_and_applicable_charge(profile):
    result = interface.simulate_interface(fixture(profile), ORGANIC, INORGANIC)
    assert result["success"] and result["balances"]["passed"]
    assert result["solver"]["engine"] == "scipy.solve_ivp"
    assert 0 < result["solver"]["rhs_evaluations"] < interface.MAX_RHS_EVALUATIONS
    assert len(result["series"]) == 101
    assert all(0 <= row["vacant_fraction"] <= 1 for row in result["series"])
    assert set(result["units"]) == set(result["series"][0])
    assert result["series"][0] != result["series"][-1]
    assert max(result["balances"]["maximum_normalized_errors"].values()) < 1e-8
    assert result["parameter_status"] == "illustrative"
    assert not result["scientifically_calibrated"] and not result["measured_data_claim"]
    assert result["result_hash"] == content_hash(
        {k: v for k, v in result.items() if k != "result_hash"}
    )


def test_electrode_current_sign_and_integrated_one_electron_charge():
    spec = fixture("electrode_electrolyte")
    result = interface.simulate_interface(spec, ORGANIC, INORGANIC)
    gamma = spec["parameters"]["site_density_mol_m2"]["value"]
    assert result["series"][0]["current_density_A_m2"] < 0
    for row in result["series"]:
        assert row["external_charge_density_C_m2"] == pytest.approx(
            -interface.FARADAY_C_MOL * gamma * row["theta_reduced"], abs=1e-10
        )
    initial(spec, "theta_reduced", 0.5)
    parameter(spec, "eta_V", 0.05)
    assert (
        interface.simulate_interface(spec, ORGANIC, INORGANIC)["series"][0]["current_density_A_m2"]
        > 0
    )


def test_electrode_equilibrium_has_zero_net_current_and_constant_coverage():
    spec = fixture("electrode_electrolyte")
    parameter(spec, "eta_V", 0)
    initial(spec, "theta_reduced", 0.5)
    result = interface.simulate_interface(spec, ORGANIC, INORGANIC)
    for row in result["series"]:
        assert row["theta_reduced"] == pytest.approx(0.5, abs=1e-11)
        assert row["current_density_A_m2"] == pytest.approx(0, abs=1e-10)


def test_electrode_large_reservoir_limit_matches_analytic_langmuir_transient():
    spec = fixture("electrode_electrolyte")
    parameter(spec, "eta_V", 0)
    parameter(spec, "area_m2", 1e-12)
    parameter(spec, "liquid_volume_m3", 1)
    result = interface.simulate_interface(spec, ORGANIC, INORGANIC)
    # k0*c/Gamma = k0*c_ref/Gamma = 1/s; reservoir depletion is <1e-16 mol/m^3.
    for row in result["series"]:
        assert row["theta_reduced"] == pytest.approx(
            0.5 * (1 - math.exp(-2 * row["time_s"])), abs=2e-8
        )


@pytest.mark.parametrize("alpha", [0.2, 0.63, 0.9])
def test_finite_electrolyte_equilibrium_matches_mass_balance_and_nernst_ratio(alpha):
    spec = fixture("electrode_electrolyte")
    for name, value in {
        "eta_V": 0.05,
        "alpha": alpha,
        "site_density_mol_m2": 0.001,
        "area_m2": 0.01,
        "liquid_volume_m3": 0.00001,
        "k0_m_s": 0.001,
    }.items():
        parameter(spec, name, value)
    initial(spec, "concentration_oxidized_mol_m3", 0.2)
    result = interface.simulate_interface(spec, ORGANIC, INORGANIC)
    # Independently solve (M-rho*theta)*(1-theta) = c_ref*exp(F*eta/RT)*theta.
    # rho=1 mol/m^3. This quadratic includes appreciable finite-pool depletion;
    # the equilibrium ratio is independent of the transfer coefficient alpha.
    ratio = math.exp(96485.33212331001 * 0.05 / (8.31446261815324 * 298.15))
    coefficient = 0.2 + 1 + ratio
    theta = 0.4 / (coefficient + math.sqrt(coefficient**2 - 0.8))
    final = result["series"][-1]
    assert final["theta_reduced"] == pytest.approx(theta, abs=2e-9)
    assert final["concentration_oxidized_mol_m3"] == pytest.approx(0.2 - theta, abs=2e-9)
    assert final["current_density_A_m2"] == pytest.approx(0, abs=1e-6)


def test_catalytic_chain_detailed_balance_and_explicit_conditional_product():
    spec = fixture("catalyst_reactant")
    # At c_A=1 and c_P=50, all three reversible pairs balance at [theta_A,theta_P,*]=[5,25,1]/31.
    initial(spec, "theta_reactant", 5 / 31)
    initial(spec, "theta_product", 25 / 31)
    initial(spec, "concentration_product_pool_mol_m3", 50)
    result = interface.simulate_interface(spec, ORGANIC, INORGANIC)
    for row in result["series"]:
        assert row["theta_reactant"] == pytest.approx(5 / 31, abs=1e-10)
        assert row["theta_product"] == pytest.approx(25 / 31, abs=1e-10)
        assert row["net_surface_transition_mol_m2_s"] == pytest.approx(0, abs=1e-12)
    assert "ortho-quinone" in result["interpretation"]["species"]
    assert not result["scientifically_calibrated"]
    assert all(proof["passed"] for proof in result["mechanism"]["conservation_proofs"])


def test_solid_liquid_competitive_equilibrium_and_spectator_charge_balance():
    spec = fixture("solid_liquid")
    initial(spec, "theta_adsorbed", 10 / 21)
    initial(spec, "theta_protonated", 10 / 21)
    result = interface.simulate_interface(spec, ORGANIC, INORGANIC)
    for row in result["series"]:
        assert row["theta_adsorbed"] == pytest.approx(10 / 21, abs=1e-10)
        assert row["theta_protonated"] == pytest.approx(10 / 21, abs=1e-10)
        assert row["net_charge_C"] == pytest.approx(0, abs=1e-12)


def test_solid_liquid_large_reservoir_desorption_limit_is_exponential():
    spec = fixture("solid_liquid")
    parameter(spec, "area_m2", 1e-12)
    parameter(spec, "liquid_volume_m3", 1)
    initial(spec, "theta_adsorbed", 0.5)
    initial(spec, "concentration_adsorbate_mol_m3", 0)
    initial(spec, "concentration_proton_mol_m3", 0)
    result = interface.simulate_interface(spec, ORGANIC, INORGANIC)
    for row in result["series"]:
        assert row["theta_adsorbed"] == pytest.approx(
            0.5 * math.exp(-0.1 * row["time_s"]), abs=2e-8
        )


def test_finite_competing_adsorption_equilibrium_matches_independent_site_root():
    spec = fixture("solid_liquid")
    for name, value in {
        "site_density_mol_m2": 0.01,
        "area_m2": 0.1,
        "liquid_volume_m3": 0.001,
    }.items():
        parameter(spec, name, value)
    initial(spec, "concentration_adsorbate_mol_m3", 0.2)
    initial(spec, "concentration_proton_mol_m3", 0.1)
    spec["time_grid"]["values"] = [0, 1, 10, 300]
    result = interface.simulate_interface(spec, ORGANIC, INORGANIC)
    # Finite pools TA=0.2, TH=0.1, rho=1 and equilibrium constants KA=10,
    # KH=1000 give theta_i = Ki*Ti*v/(1+Ki*rho*v). Solve the shared vacant
    # fraction by bisection independently of the differential equations.
    left, right = 0.0, 1.0
    for _ in range(80):
        vacant = (left + right) / 2
        total = vacant + 2 * vacant / (1 + 10 * vacant)
        total += 100 * vacant / (1 + 1000 * vacant)
        if total < 1:
            left = vacant
        else:
            right = vacant
    vacant = (left + right) / 2
    adsorbed = 2 * vacant / (1 + 10 * vacant)
    protonated = 100 * vacant / (1 + 1000 * vacant)
    final = result["series"][-1]
    assert final["vacant_fraction"] == pytest.approx(vacant, abs=2e-9)
    assert final["theta_adsorbed"] == pytest.approx(adsorbed, abs=2e-9)
    assert final["theta_protonated"] == pytest.approx(protonated, abs=2e-9)
    assert final["concentration_adsorbate_mol_m3"] == pytest.approx(0.2 - adsorbed, abs=2e-9)
    assert final["concentration_proton_mol_m3"] == pytest.approx(0.1 - protonated, abs=2e-9)


def test_candidate_rebinding_and_parameter_change_are_explicit():
    spec = fixture("solid_liquid")
    before = interface.simulate_interface(spec, ORGANIC, INORGANIC)
    changed = {**ORGANIC, "label": "other"}
    changed["candidate_hash"] = content_hash(
        {k: v for k, v in changed.items() if k != "candidate_hash"}
    )
    with pytest.raises(ValueError, match="CANDIDATE_BINDING"):
        interface.simulate_interface(spec, changed, INORGANIC)
    parameter(spec, "k_ads_m3_mol_s", 2)
    after = interface.simulate_interface(spec, ORGANIC, INORGANIC)
    assert before["input_hash"] != after["input_hash"]
    assert before["series"][-1]["theta_adsorbed"] != after["series"][-1]["theta_adsorbed"]


@pytest.mark.parametrize(
    "mutation,match",
    [
        (lambda spec: spec["parameters"]["k0_m_s"].pop("provenance"), "QUANTITY_REQUIRED"),
        (lambda spec: spec["parameters"]["k0_m_s"].update(unit="1/s"), "UNIT_MISMATCH"),
        (lambda spec: parameter(spec, "k0_m_s", -1), "INVALID_INTERFACE_NUMBER"),
        (lambda spec: parameter(spec, "n_electrons", 2), "INVALID_INTERFACE_NUMBER"),
        (lambda spec: parameter(spec, "alpha", True), "INVALID_INTERFACE_NUMBER"),
        (lambda spec: spec["time_grid"].update(values=[0, 0]), "TIME_GRID"),
        (lambda spec: spec["time_grid"].update(values=[0, 3601]), "INVALID_INTERFACE_NUMBER"),
        (lambda spec: spec["time_grid"].update(values=list(range(202))), "TIME_GRID"),
    ],
)
def test_missing_provenance_units_and_invalid_budgets_fail_before_solving(mutation, match):
    spec = fixture("electrode_electrolyte")
    mutation(spec)
    with pytest.raises(ValueError, match=match):
        interface.simulate_interface(spec, ORGANIC, INORGANIC)


def test_overfilled_sites_and_invented_measurement_status_are_rejected():
    spec = fixture("solid_liquid")
    initial(spec, "theta_adsorbed", 0.8)
    initial(spec, "theta_protonated", 0.8)
    with pytest.raises(ValueError, match="SITE_BALANCE"):
        interface.simulate_interface(spec, ORGANIC, INORGANIC)
    spec = fixture("solid_liquid")
    spec["parameters"]["k_des_s"]["provenance"]["kind"] = "measured"
    with pytest.raises(ValueError, match="PROVENANCE_REQUIRED"):
        interface.simulate_interface(spec, ORGANIC, INORGANIC)


def test_solver_budget_stops_and_inputs_remain_unchanged(monkeypatch):
    spec = fixture("electrode_electrolyte")
    saved = copy.deepcopy(spec)
    monkeypatch.setattr(interface, "MAX_RHS_EVALUATIONS", 1)
    with pytest.raises(ValueError, match="SOLVER_BUDGET_EXCEEDED"):
        interface.simulate_interface(spec, ORGANIC, INORGANIC)
    assert spec == saved


def test_wrong_family_and_candidate_hash_forgery_are_rejected():
    spec = fixture("solid_liquid")
    with pytest.raises(ValueError, match="CANDIDATE_FAMILY_MISMATCH"):
        interface.simulate_interface(spec, INORGANIC, ORGANIC)
    with pytest.raises(ValueError, match="CANDIDATE_HASH_MISMATCH"):
        interface.simulate_interface(spec, {**ORGANIC, "smiles": "changed"}, INORGANIC)


def test_real_complex_generated_pair_integrates_all_profiles_and_rejects_geometry_tampering():
    organic, inorganic = ORGANIC, INORGANIC
    assert organic["complexity"]["heavy_atoms"] >= 8
    assert len(organic["complexity"]["structural_feature_classes"]) >= 2
    assert inorganic["validation"]["atom_count"] == 40
    for profile in interface.PROFILE_PARAMETERS:
        spec = interface.illustrative_interface_spec(profile, organic, inorganic)
        result = interface.simulate_interface(spec, organic, inorganic)
        assert result["success"] and result["balances"]["passed"]
        assert result["candidate_hashes"] == {
            "organic": content_hash(organic),
            "inorganic": content_hash(inorganic),
        }
    altered = copy.deepcopy(inorganic)
    altered["geometry"]["atoms"][0]["position"][0] += 0.1
    altered["candidate_hash"] = content_hash(
        {k: v for k, v in altered.items() if k != "candidate_hash"}
    )
    spec = interface.illustrative_interface_spec("solid_liquid", organic, altered)
    with pytest.raises(ValueError, match="GEOMETRY_HASH_MISMATCH"):
        interface.simulate_interface(spec, organic, altered)


def test_hydrogen_activity_applies_once_and_reverse_consumption_is_element_balanced():
    spec = fixture("catalyst_reactant")
    initial(spec, "theta_product", 0.5)
    initial(spec, "concentration_reactant_mol_m3", 0)
    one = interface.simulate_interface(spec, ORGANIC, INORGANIC)
    parameter(spec, "hydrogen_activity", 2)
    two = interface.simulate_interface(spec, ORGANIC, INORGANIC)
    assert one["series"][0]["net_surface_transition_mol_m2_s"] < 0
    assert two["series"][0]["net_surface_transition_mol_m2_s"] == pytest.approx(
        2 * one["series"][0]["net_surface_transition_mol_m2_s"]
    )
    for result in (one, two):
        assert result["series"][1]["hydrogen_chemostat_exchange_mol_m2"] < 0
        assert result["balances"]["maximum_normalized_element_errors"]["H"] < 1e-8
        assert result["balances"]["maximum_normalized_errors"]["hydrogen_chemostat_balance"] < 1e-8
        for row in result["series"]:
            assert row["hydrogen_chemostat_exchange_mol_m2"] == pytest.approx(
                row["cumulative_net_transitions_mol_m2"], abs=1e-12
            )


def test_catalytic_finite_pool_hydrogen_inventory_is_independent_of_balance_report():
    spec = fixture("catalyst_reactant")
    for name, value in {
        "site_density_mol_m2": 0.01,
        "area_m2": 0.1,
        "liquid_volume_m3": 0.001,
        "hydrogen_activity": 10,
    }.items():
        parameter(spec, name, value)
    for name, value in {
        "theta_reactant": 0.05,
        "theta_product": 0.5,
        "concentration_reactant_mol_m3": 0.2,
        "concentration_product_pool_mol_m3": 0.5,
    }.items():
        initial(spec, name, value)
    result = interface.simulate_interface(spec, ORGANIC, INORGANIC)
    # Selected methyl product is C10H13NO3; its quinone is C10H11NO3.
    # rho=1 converts coverage to mol/m^3; A/V=100 converts the recorded
    # signed mol H2/m^2 transfer. Check atom inventory from the raw series.
    hydrogen_initial = 13 * (0.2 + 0.05) + 11 * (0.5 + 0.5)
    for row in result["series"]:
        reactant = row["concentration_reactant_mol_m3"] + row["theta_reactant"]
        product = row["concentration_product_pool_mol_m3"] + row["theta_product"]
        hydrogen = 13 * reactant + 11 * product
        hydrogen += 2 * 100 * row["hydrogen_chemostat_exchange_mol_m2"]
        assert reactant + product == pytest.approx(1.25, abs=1e-10)
        assert hydrogen == pytest.approx(hydrogen_initial, abs=1e-9)
    assert result["series"][1]["hydrogen_chemostat_exchange_mol_m2"] < 0


def test_mechanism_mutation_cannot_be_authorized_by_rehashing_supplied_record():
    spec = fixture("catalyst_reactant")
    spec["mechanism"]["steps"][1]["products"]["hydrogen"] = 2
    spec["mechanism"]["mechanism_hash"] = content_hash(
        {k: v for k, v in spec["mechanism"].items() if k != "mechanism_hash"}
    )
    with pytest.raises(ValueError, match="MECHANISM_BINDING_MISMATCH"):
        interface.simulate_interface(spec, ORGANIC, INORGANIC)


def test_missing_mechanism_and_incompatible_molecular_scaffold_are_rejected():
    spec = fixture("catalyst_reactant")
    del spec["mechanism"]
    with pytest.raises(ValueError, match="INVALID_INTERFACE_SPEC"):
        interface.simulate_interface(spec, ORGANIC, INORGANIC)
    caffeine = {
        "id": "development-caffeine",
        "family": "organic",
        "canonical_smiles": "Cn1c(=O)c2c(ncn2C)n(C)c1=O",
    }
    caffeine["candidate_hash"] = content_hash(caffeine)
    with pytest.raises(ValueError, match="MECHANISM_REQUIRED"):
        interface.illustrative_interface_spec("catalyst_reactant", caffeine, INORGANIC)
