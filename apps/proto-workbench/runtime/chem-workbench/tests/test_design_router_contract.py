"""Grammar scope, typed scenario failures and explicit screening budget contracts."""

from __future__ import annotations

import copy
import itertools
import json

import pytest
from jsonschema import Draft202012Validator, ValidationError

from chem_workbench import design_studio as design
from chem_workbench import orchestrator
from chem_workbench.design_candidates import inorganic_candidates, organic_candidates
from chem_workbench.interface_simulation import illustrative_interface_spec
from chem_workbench.visualization import content_hash


def request(decision=None, mode="model"):
    return {
        "prompt": "Explicit controller contract fixture",
        "study": design.default_study(),
        "mode": mode,
        "decision": decision,
    }


def available(monkeypatch):
    monkeypatch.setattr(
        orchestrator,
        "model_status",
        lambda: {
            "available": True,
            "model_id": "contract-fixture",
            "key": "mock-only",
        },
    )


def requirements(workflow="organic_design"):
    return {
        "requested_workflow": workflow,
        "requested_properties": [],
        "missing_inputs": [],
        "unsupported_requests": [],
        "disposition": "admitted",
        "message": "Synthetic complete requirements fixture; no model inference.",
    }


def test_every_workflow_and_abstention_has_one_reachable_grammar_branch():
    schema = design.model_router_schema()
    validator = Draft202012Validator(schema)
    assert len(schema["oneOf"]) == len(design.WORKFLOWS) + 1
    assert all(next(iter(branch["properties"])) == "message" for branch in schema["oneOf"])
    for workflow in [*design.WORKFLOWS, ""]:
        decision = design.empty_decision(workflow or "organic_design")
        if not workflow:
            decision.update(action="needs_input", workflow="", missing_inputs=["Exact kinetics"])
        if workflow in {"organic_design", "interface_design"}:
            decision.update(
                scaffold_id="custom",
                organic_ranking="high_tpsa",
                fragment_ids=["phenyl", "hydroxyethyl"],
                organic_filters={
                    "mw_max": 375.25,
                    "logp_min": -1.75,
                    "logp_max": 2.875,
                    "tpsa_min": 40.5,
                    "tpsa_max": 125.75,
                },
            )
        if workflow in {"inorganic_design", "interface_design"}:
            decision.update(
                a_elements=["Sr", "Ba"], b_pair_ids=["Sc/Nb", "Y/Ta"], tolerance_target=0.937
            )
        if workflow == "interface_screening":
            decision["interfaces"] = ["solid_liquid"]
        original = copy.deepcopy(decision)
        validator.validate(decision)
        assert (
            sum(Draft202012Validator(branch).is_valid(decision) for branch in schema["oneOf"]) == 1
        )
        assert decision == original
        extracted = requirements(workflow or "unsupported")
        if not workflow:
            extracted["disposition"] = "needs_input"
        Draft202012Validator(design.requirements_schema()).validate(extracted)


def test_illegal_cross_workflow_arguments_are_rejected_without_removing_valid_chemistry():
    validator = Draft202012Validator(design.model_router_schema())
    for workflow, changed in [
        ("organic_design", {"a_elements": ["Ba"]}),
        ("organic_design", {"tolerance_target": 0.937}),
        ("inorganic_design", {"scaffold_id": "catechol_amide"}),
        ("inorganic_design", {"fragment_ids": ["phenyl"]}),
        ("interface_simulation", {"organic_ranking": "high_tpsa"}),
        ("interface_simulation", {"b_pair_ids": ["Y/Ta"]}),
        ("interface_screening", {"a_elements": ["Sr"]}),
        ("interface_screening", {"interfaces": ["solid_liquid", "catalyst_reactant"]}),
    ]:
        decision = design.empty_decision(workflow)
        if workflow == "interface_screening":
            decision["interfaces"] = ["solid_liquid"]
        decision.update(changed)
        with pytest.raises(ValidationError):
            validator.validate(decision)
    for scaffold in design.SCAFFOLDS:
        decision = design.empty_decision("organic_design")
        decision["scaffold_id"] = scaffold
        validator.validate(decision)


def test_invalid_scientific_bounds_are_retained_and_rejected_without_clamping(
    tmp_path, monkeypatch
):
    available(monkeypatch)
    decision = design.empty_decision("organic_design")
    decision["organic_filters"].update(logp_min=4.25, logp_max=1.125)
    raw = json.dumps(decision)
    requests = []

    def response(path, body=None, timeout=12):
        requests.append(body)
        content = (
            json.dumps(requirements())
            if orchestrator.MODEL_METRICS.stage == "requirements"
            else raw
        )
        return {"choices": [{"finish_reason": "stop", "message": {"content": content}}]}

    monkeypatch.setattr(orchestrator, "local_request", response)
    studio = design.DesignStudio(tmp_path)
    with pytest.raises(design.DesignRunError, match="minimum exceeds maximum") as failure:
        studio.run(request())
    record = failure.value.record
    assert record["sampled_decision"] == decision == record["decision"]
    assert record["plan"]["organic"]["filters"] == {"logp_min": 4.25, "logp_max": 1.125}
    assert record["orchestration"]["provider_calls"][-1]["response_text"] == raw
    assert len(requests) == 2 and record["orchestration"]["repairs"] == 0
    assert requests[0]["response_format"]["json_schema"]["schema"] == design.requirements_schema()
    assert requests[1]["response_format"]["json_schema"]["schema"] == design.model_router_schema()
    assert record["state"] == "failed" and record["error"]["phase"] == "workflow"
    assert record["organic"] is None and record["trace"][0]["status"] == "failed"
    assert studio.read(record["record_hash"]) == record


def test_host_scope_validation_is_independent_of_sampling_grammar(tmp_path, monkeypatch):
    available(monkeypatch)
    decision = design.empty_decision("organic_design")
    decision["a_elements"] = ["Ba"]

    def parser_bypass(*args):
        value = requirements() if orchestrator.MODEL_METRICS.stage == "requirements" else decision
        orchestrator.MODEL_METRICS.calls.append(
            {
                "fault_injected": "parser_bypass",
                "stage": orchestrator.MODEL_METRICS.stage,
                "proposed_action": copy.deepcopy(value),
                "response_text": json.dumps(value),
            }
        )
        return copy.deepcopy(value)

    monkeypatch.setattr(orchestrator, "request_action", parser_bypass)
    studio = design.DesignStudio(tmp_path)
    with pytest.raises(
        design.DesignRunError, match="INORGANIC_CONSTRAINT_WITHOUT_MODULE"
    ) as failure:
        studio.run(request())
    record = failure.value.record
    assert record["state"] == "rejected" and record["error"]["phase"] == "host_validation"
    assert record["sampled_decision"] == decision
    assert record["orchestration"]["model_action"] == decision
    assert record["decision"] is None and not record["trace"]
    assert studio.read(record["record_hash"]) == record


def test_sampled_requirements_abstention_stops_before_action_without_synthetic_raw_credit(
    tmp_path, monkeypatch
):
    available(monkeypatch)
    extracted = requirements("unsupported")
    extracted.update(
        disposition="needs_input",
        requested_properties=["verified band gap"],
        unsupported_requests=["Verified band-gap calculation is unavailable."],
    )
    calls = []

    def response(path, body=None, timeout=12):
        calls.append(orchestrator.MODEL_METRICS.stage)
        return {
            "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(extracted)}}]
        }

    monkeypatch.setattr(orchestrator, "local_request", response)
    result = design.DesignStudio(tmp_path).run(request())
    route = result["orchestration"]
    assert calls == ["requirements"]
    assert route["decision_source"] == "requirements" and route["requirements"] == extracted
    assert route["provider_calls"][0]["proposed_action"] == extracted
    assert "action" not in route["provider_calls"][0]["proposed_action"]
    assert result["state"] == "needs_input" and not result["trace"]
    assert result["decision"]["action"] == "needs_input"
    assert result["decision"]["unsupported_requests"] == extracted["unsupported_requests"]


def test_requirements_action_conflict_preserves_both_samples_and_runs_no_module(
    tmp_path, monkeypatch
):
    available(monkeypatch)
    extracted = requirements("organic_design")
    wrong = design.empty_decision("inorganic_design")

    def response(path, body=None, timeout=12):
        value = extracted if orchestrator.MODEL_METRICS.stage == "requirements" else wrong
        return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(value)}}]}

    monkeypatch.setattr(orchestrator, "local_request", response)
    studio = design.DesignStudio(tmp_path)
    with pytest.raises(design.DesignRunError, match="REQUIREMENTS_ACTION_CONFLICT") as failure:
        studio.run(request())
    result = failure.value.record
    route = result["orchestration"]
    assert result["state"] == "failed" and not result["trace"]
    assert route["requirements"] == extracted and route["model_action"] == wrong
    assert route["decision_source"] == "action"
    assert [call["proposed_action"] for call in route["provider_calls"]] == [extracted, wrong]
    assert studio.read(result["record_hash"]) == result


def test_one_shared_mechanical_repair_cannot_expand_to_one_per_stage(tmp_path, monkeypatch):
    available(monkeypatch)
    stages = []

    def response(path, body=None, timeout=12):
        stage = orchestrator.MODEL_METRICS.stage
        stages.append(stage)
        content = json.dumps(requirements()) if len(stages) == 2 else "{invalid"
        return {"choices": [{"finish_reason": "stop", "message": {"content": content}}]}

    monkeypatch.setattr(orchestrator, "local_request", response)
    with pytest.raises(design.DesignRunError, match="INVALID_MODEL_OUTPUT") as failure:
        design.DesignStudio(tmp_path).run(request())
    route = failure.value.record["orchestration"]
    assert stages == ["requirements", "requirements", "action"]
    assert route["repairs"] == 1 and len(route["provider_calls"]) == 3
    assert route["provider_calls"][0]["response_text"] == "{invalid"
    assert route["provider_calls"][2]["response_text"] == "{invalid"
    assert route["model_action"] is None
    assert not failure.value.record["trace"]


@pytest.mark.parametrize(
    "scenario",
    [
        {"profile": "solid_liquid", "parameters": None},
        {"profile": "solid_liquid", "parameters": {"k_des_s": 0.2}},
        {"profile": "solid_liquid", "initial_conditions": []},
        {"profile": "solid_liquid", "time_grid": None},
        {"profile": "solid_liquid", "time_grid": {"values": None}},
        "malformed scenario",
    ],
)
def test_malformed_scenario_containers_fail_typed_before_sampling_and_retain_source(
    tmp_path, monkeypatch, scenario
):
    available(monkeypatch)
    calls = []

    def unexpected(*args):
        calls.append(args)
        raise AssertionError("Malformed scenario must fail before model sampling")

    monkeypatch.setattr(orchestrator, "request_action", unexpected)
    supplied = request()
    supplied["study"]["interface_parameters"] = {"mode": "supplied", "specifications": [scenario]}
    original = copy.deepcopy(supplied)
    studio = design.DesignStudio(tmp_path)
    with pytest.raises(design.DesignRunError) as failure:
        studio.run(supplied)
    record = failure.value.record
    assert not calls
    assert record["orchestration"]["error"]["type"] == "ValueError"
    assert record["error"]["phase"] == "routing"
    assert "SCENARIO" in record["error"]["message"]
    assert len(record["error"]["message"]) <= 300
    assert record["request"] == original == supplied
    assert record["study_hash"] == content_hash(original["study"])
    assert record["orchestration"]["provider_calls"] == []
    assert not record["trace"] and studio.read(record["record_hash"]) == record


@pytest.mark.parametrize("finish_time, admitted", [(80.0, True), (91.0, False)])
def test_stages_share_total_deadline_and_late_responses_cannot_dispatch(
    tmp_path, monkeypatch, finish_time, admitted
):
    available(monkeypatch)
    clock, limits = [0.0], []
    monkeypatch.setattr(design.time, "monotonic", lambda: clock[0])

    def response(path, body=None, timeout=12):
        limits.append(timeout)
        first = orchestrator.MODEL_METRICS.stage == "requirements"
        clock[0] = 50.0 if first else finish_time
        action = requirements() if first else design.empty_decision("organic_design")
        return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(action)}}]}

    monkeypatch.setattr(orchestrator, "local_request", response)
    studio = design.DesignStudio(tmp_path)
    if admitted:
        record = studio.run(request())
        assert record["state"] == "completed" and record["organic"]["candidates"]
    else:
        with pytest.raises(design.DesignRunError, match="BUDGET_EXCEEDED") as failure:
            studio.run(request())
        record = failure.value.record
        assert record["state"] == "failed" and not record["trace"]
        assert record["organic"] is None and record["decision"] is None
        assert studio.read(record["record_hash"]) == record
    assert limits == [90.0, 40.0]
    assert len(record["orchestration"]["provider_calls"]) == 2
    assert (
        record["orchestration"]["provider_calls"][1]["proposed_action"]["action"] == "run_workflow"
    )


def test_four_pair_screening_requires_explicit_budget_and_legacy_study_cannot_gain_it(tmp_path):
    studio = design.DesignStudio(tmp_path)
    initial = request(design.empty_decision("interface_design"), "direct")
    initial["decision"].update(interfaces=[], max_candidates=2)
    initial["study"]["organic"]["fragment_ids"] = ["phenyl", "pyridyl"]
    initial["study"]["inorganic"].update(a_elements=["Sr"], b_pairs=[["Sc", "Nb"], ["Y", "Ta"]])
    base = studio.run(initial)
    organic = base["organic"]["candidates"]
    inorganic = base["inorganic"]["candidates"]
    explicit = request(design.empty_decision("interface_screening"), "direct")
    explicit["decision"]["interfaces"] = ["solid_liquid"]
    explicit["study"]["selected_candidates"] = {
        "run_ref": base["record_hash"],
        "organic_hash": organic[0]["candidate_hash"],
        "inorganic_hash": inorganic[0]["candidate_hash"],
    }
    explicit["study"]["interface_screening"] = {
        "profile": "solid_liquid",
        "objective": "max_adsorbed_coverage",
    }
    specs = [
        illustrative_interface_spec("solid_liquid", a, b)
        for a, b in itertools.product(organic, inorganic)
    ]
    for spec in specs:
        spec["time_grid"]["values"] = [0, 0.01, 0.1]
    explicit["study"]["interface_parameters"] = {"mode": "supplied", "specifications": specs}
    legacy = copy.deepcopy(explicit)
    del legacy["study"]["budget"]["max_interface_screening_runs"]
    assert design.validate_study(legacy["study"])["budget"] == legacy["study"]["budget"]
    with pytest.raises(design.DesignRunError, match="SCREENING_INPUTS_REQUIRED") as failure:
        studio.run(legacy)
    assert failure.value.record["error"]["phase"] == "host_validation"
    assert failure.value.record["trace"] == []
    assert failure.value.record["authorization"]["max_interface_runs"] == 3
    result = studio.run(explicit)
    assert result["state"] == "completed" and len(result["interfaces"]) == 4
    assert result["request"]["study"]["interface_parameters"]["mode"] == "supplied"
    assert all(item["parameter_status"] == "illustrative" for item in result["interfaces"])
    assert all(not item["scientifically_calibrated"] for item in result["interfaces"])
    assert all(not item["measured_data_claim"] for item in result["interfaces"])
    assert result["request"]["study"]["budget"]["max_interface_screening_runs"] == 4
    assert result["plan"]["budget"] == explicit["study"]["budget"]
    assert result["authorization"]["max_interface_runs"] == 4
    assert result["authorization"]["model_grants_authority"] is False
    excessive = copy.deepcopy(explicit["study"])
    excessive["budget"]["max_interface_screening_runs"] = 5
    with pytest.raises(ValueError, match="DESIGN_BUDGET"):
        design.validate_study(excessive)


@pytest.fixture
def provenance_scenario():
    organic = organic_candidates({"max_candidates": 1, "fragment_ids": ["methyl"]})["candidates"][0]
    inorganic = inorganic_candidates(
        {"max_candidates": 1, "a_elements": ["Sr"], "b_pairs": [["Mg", "W"]]}
    )["candidates"][0]
    return illustrative_interface_spec("catalyst_reactant", organic, inorganic)


@pytest.mark.parametrize(
    ("time_provenance", "expected"),
    [
        ({"kind": "illustrative", "source": "Explicit time-grid fixture"}, "illustrative"),
        (
            {"kind": "user_supplied", "source": "Claimed verified experimental observation"},
            "user_supplied_unverified",
        ),
        ({"kind": "user_supplied", "source": " "}, "missing_or_invalid_provenance"),
        (None, "missing_or_invalid_provenance"),
    ],
)
def test_parameter_status_includes_time_grid_and_never_authenticates_uploaded_source_claims(
    provenance_scenario, time_provenance, expected
):
    scenario = provenance_scenario
    for quantity in [*scenario["parameters"].values(), *scenario["initial_conditions"].values()]:
        quantity["provenance"] = {
            "kind": "user_supplied",
            "source": "Uploader claims this is verified measured data.",
        }
    scenario["time_grid"]["provenance"] = time_provenance
    original = copy.deepcopy(scenario)
    sources = {}
    brief = design._scenario_brief(scenario, sources)
    assert brief["parameter_status"] == expected
    assert brief["scientifically_calibrated"] is False
    assert brief["measured_data_verified"] is False
    assert scenario == original
    for name, quantity in scenario["parameters"].items():
        compact = brief["parameters"][name]
        assert (compact["value"], compact["unit"]) == (quantity["value"], quantity["unit"])
        assert compact["provenance"]["kind"] == "user_supplied"
        source_entry = sources[compact["provenance"]["source_ref"]]
        assert source_entry["source"] == quantity["provenance"]["source"]
        assert source_entry["source_hash"] == content_hash(quantity["provenance"]["source"])
    if time_provenance:
        time_source_ref = brief["time_grid"]["provenance"]["source_ref"]
        assert brief["time_grid"]["provenance"]["kind"] == time_provenance["kind"]
        assert sources[time_source_ref]["source_hash"] == content_hash(time_provenance["source"])


@pytest.mark.parametrize("scenario_count", [2, 4])
def test_model_context_preserves_provenance_and_full_source_hashes_under_budget(
    monkeypatch, provenance_scenario, scenario_count
):
    available(monkeypatch)
    study = design.default_study()
    scenarios = [copy.deepcopy(provenance_scenario) for _ in range(scenario_count)]
    for pair_index, scenario in enumerate(scenarios):
        scenario["candidate_hashes"]["organic"] = content_hash({"fixture_pair": pair_index})
        quantities = [
            *scenario["parameters"].values(),
            *scenario["initial_conditions"].values(),
            scenario["time_grid"],
        ]
        for quantity_index, quantity in enumerate(quantities):
            quantity["provenance"] = {
                "kind": "illustrative" if quantity_index == 0 else "user_supplied",
                "source": f"Quantity {quantity_index} claimed experimental source; " + "x" * 1900,
            }
    study["interface_parameters"] = {"mode": "supplied", "specifications": scenarios}
    original = copy.deepcopy(study)
    captured = []

    def sample(messages, *args):
        captured.append(json.loads(messages[1]["content"])["study"])
        if orchestrator.MODEL_METRICS.stage == "requirements":
            return requirements("interface_screening")
        action = design.empty_decision("interface_screening")
        action["interfaces"] = ["catalyst_reactant"]
        return action

    monkeypatch.setattr(orchestrator, "request_action", sample)
    design.route_design("Compare supplied candidate-pair kinetic responses.", study)
    assert len(captured) == 2
    assert len(json.dumps(captured[0])) <= 24000
    supplied = captured[0]["interface_parameters"]
    assert supplied["mode"] == "supplied"
    assert supplied["supplied_record_count"] == scenario_count
    assert len(supplied["provenance_sources"]) == 16
    for original_scenario, brief in zip(scenarios, supplied["supplied_scenarios"], strict=True):
        assert brief["candidate_hashes"] == original_scenario["candidate_hashes"]
        assert brief["parameter_status"] == "illustrative"
        assert not brief["scientifically_calibrated"] and not brief["measured_data_verified"]
        for field in ("parameters", "initial_conditions", "time_grid"):
            pairs = (
                [(original_scenario[field], brief[field])]
                if field == "time_grid"
                else [
                    (value, brief[field][name]) for name, value in original_scenario[field].items()
                ]
            )
            for quantity, compact in pairs:
                source = quantity["provenance"]["source"]
                assert compact["provenance"]["kind"] == quantity["provenance"]["kind"]
                assert set(compact["provenance"]) == {"kind", "source_ref"}
                source_ref = compact["provenance"]["source_ref"]
                assert len(source_ref) <= 3
                source_entry = supplied["provenance_sources"][source_ref]
                assert source_entry["source_hash"] == content_hash(source)
                assert 20 <= len(source_entry["source"]) <= 200
                assert source_entry["source"] == source[: len(source_entry["source"])]
                assert source_entry["source_truncated"] is True
                if field != "time_grid":
                    assert compact["value"] == quantity["value"]
                    assert compact["unit"] == quantity["unit"]
    action_supplied = captured[1]["interface_parameters"]
    assert action_supplied["mode"] == "supplied"
    assert action_supplied["supplied_record_count"] == scenario_count
    assert "provenance_sources" not in action_supplied
    assert action_supplied["supplied_scenarios"] == [
        {
            key: scenario[key]
            for key in (
                "profile",
                "candidate_hashes",
                "parameter_status",
                "scientifically_calibrated",
                "measured_data_verified",
            )
        }
        for scenario in supplied["supplied_scenarios"]
    ]
    assert all("parameters" not in scenario for scenario in action_supplied["supplied_scenarios"])
    assert len(json.dumps(captured[1])) < len(json.dumps(captured[0]))
    for key in study.keys() - {"interface_parameters"}:
        assert captured[1][key] == captured[0][key]
    assert study == original
