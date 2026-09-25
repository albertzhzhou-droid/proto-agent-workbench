"""Synthetic pure-record display tests; no chemistry, renderer or browser launch."""

import copy
from decimal import Decimal

import pytest
from test_molecular_refinement import _body, _evaluation_series, _geometry, _spec

from chem_workbench import molecular_refinement as refinement
from chem_workbench.refinement_visualization import (
    build_refinement_view,
    validate_refinement_view,
)
from chem_workbench.visualization import content_hash


def fixture_result(*, gradient="0", attribution=True):
    spec = _spec()
    result = refinement.seal_refinement_result(spec, _body(spec, gradient, attribution))
    return spec, result


def rehash_view(view):
    view["view_hash"] = content_hash({k: v for k, v in view.items() if k != "view_hash"})
    return view


def test_exact_evaluated_frames_drive_numeric_scenes_and_charts():
    spec, result = fixture_result()
    view = build_refinement_view(spec, result)
    assert view["version"] == "molecular-refinement-view/v1"
    assert view["evidence_origin"] == "synthetic_validation"
    assert len(view["frames"]) == len(result["trajectory"]) == 2
    assert view["state"] == "succeeded"
    assert view["convergence"]["geometry_status"] == "satisfied"
    assert view["convergence"]["minimum_status"] == "not_evaluated"
    assert view["scope"]["minimum_certified"] is False
    for actual, shown, point in zip(
        result["trajectory"], view["frames"], view["trajectory_chart"]["points"], strict=True
    ):
        assert shown["frame_hash"] == actual["frame_hash"] == point["frame_hash"]
        assert shown["evaluated_geometry_hash"] == actual["geometry"]["geometry_hash"]
        assert shown["energy_hartree"] == actual["energy_hartree"] == point["energy_hartree"]
        assert shown["scene"]["provenance"] == "evaluated_geometry"
        assert shown["scene"]["bonds"] == [] and shown["scene"]["cell"] is None
        assert shown["scene"]["units"] == "angstrom"
        for atom, displayed, row in zip(
            actual["geometry"]["atoms"],
            shown["scene"]["atoms"],
            shown["coordinate_table"],
            strict=True,
        ):
            assert atom["id"] == displayed["id"] == row["id"]
            assert displayed["position"] == list(map(float, atom["position"]))
            assert row["position_angstrom"] == atom["position"]
            assert (
                row["gradient_hartree_per_bohr"]
                == actual["gradient_hartree_per_bohr"][row["index"]]
            )
    assert validate_refinement_view(spec, result, view) == view


def test_full_precision_table_survives_lossy_renderer_projection():
    geometry = _geometry("0.1234567890123456789012345")
    spec = _spec(geometry)
    result = refinement.seal_refinement_result(spec, _body(spec, attribution=False))
    shown = build_refinement_view(spec, result)["frames"][0]
    exact = geometry["atoms"][0]["position"][0]
    assert shown["coordinate_table"][0]["position_angstrom"][0] == exact
    assert str(shown["scene"]["atoms"][0]["position"][0]) != exact
    projection = shown["scene"]["projection"]
    assert projection["rounding_present"] is True
    assert Decimal(projection["maximum_absolute_coordinate_error_angstrom"]) > 0
    assert projection["exact_coordinate_table_hash"] == content_hash(shown["coordinate_table"])


def test_unknown_optimizer_attribution_does_not_become_physical_time_or_success():
    spec, result = fixture_result(gradient="0.01", attribution=False)
    view = build_refinement_view(spec, result)
    assert view["state"] == "incomplete"
    assert view["convergence"]["geometry_status"] == "not_checked"
    assert view["playback"]["clock"] == "evaluation_index"
    assert view["playback"]["interpolation"] is None
    for row in view["trajectory_chart"]["points"]:
        assert row["optimizer_iteration"] is None
        assert row["step_status"] == "unknown"
        assert row["physical_time_s"] is None
    assert view["trajectory_chart"]["available_x"] == ["evaluation_index", "elapsed_wall_seconds"]
    summary = view["frames"][-1]["gradient_summary"]
    assert summary["maximum_absolute_component"] == "0.01"
    assert Decimal(summary["rms_component"]) > 0
    assert summary["component_count"] == 24


def test_partial_failure_preserves_last_actual_frame_and_failure():
    spec, result = fixture_result(attribution=False)
    body = {k: copy.deepcopy(v) for k, v in result.items() if k != "result_hash"}
    body["state"] = "failed"
    body["failure"] = {
        "phase": "gradient",
        "code": "SCF_FAILED",
        "message": "Synthetic failed attempt after two evaluations",
        "last_evaluated_frame_hash": result["final_frame_hash"],
        "artifact_id": "failure",
    }
    body["raw_artifacts"].append(
        {
            "artifact_id": "failure",
            "role": "failure",
            "path": "fixture/failure.json",
            "sha256": "a" * 64,
        }
    )
    result = refinement.seal_refinement_result(spec, body)
    view = build_refinement_view(spec, result)
    assert view["failure"] == result["failure"]
    assert len(view["frames"]) == 2
    assert view["final_frame_hash"] == view["frames"][-1]["frame_hash"]
    assert view["state"] == "failed" and view["scope"]["minimum_certified"] is False


def test_zero_evaluations_never_fabricates_initial_frame():
    spec, result = fixture_result(attribution=False)
    body = {k: copy.deepcopy(v) for k, v in result.items() if k != "result_hash"}
    body["trajectory"] = []
    body["final_frame_hash"] = None
    body["raw_artifacts"] = []
    body["timing"]["backend_attempts_observed"] = 0
    result = refinement.seal_refinement_result(spec, body)
    view = build_refinement_view(spec, result)
    assert view["frames"] == view["scene"]["structures"] == view["trajectory_chart"]["points"] == []
    assert view["final_frame_hash"] is None and view["playback"]["sample_count"] == 0


def test_rejected_trial_and_anchor_reevaluation_stay_in_actual_event_order():
    spec = _spec()
    body = _evaluation_series(
        spec,
        [
            ("0", "0", 0, "initial", None),
            ("0.1", "0", 1, "accepted", None),
            ("0.2", "0.1", 2, "rejected", None),
            ("0.1", "0", 1, "reevaluation", 1),
        ],
        "not_satisfied",
    )
    result = refinement.seal_refinement_result(spec, body)
    view = build_refinement_view(spec, result)
    points = view["trajectory_chart"]["points"]
    assert [p["evaluation_index"] for p in points] == [0, 1, 2, 3]
    assert [p["optimizer_iteration"] for p in points] == [0, 1, 2, 1]
    assert [p["elapsed_wall_seconds"] for p in points] == ["1", "2", "3", "4"]
    assert points[2]["step_status"] == "rejected" and points[3]["step_status"] == "reevaluation"
    assert view["frames"][-1]["reevaluates_frame_hash"] == view["frames"][1]["frame_hash"]
    assert view["convergence"]["geometry_status"] == "not_satisfied"


@pytest.mark.parametrize(
    "location", ["scene", "scene_bool", "exact_table", "chart", "frame_hash", "clock"]
)
def test_rehashed_display_tampering_is_rejected(location):
    spec, result = fixture_result()
    view = build_refinement_view(spec, result)
    if location == "scene":
        view["frames"][0]["scene"]["atoms"][0]["position"][0] = 42.0
    elif location == "scene_bool":
        view["frames"][0]["scene"]["atoms"][0]["position"][0] = False
    elif location == "exact_table":
        view["frames"][0]["coordinate_table"][0]["position_angstrom"][0] = "42"
    elif location == "chart":
        view["trajectory_chart"]["points"][0]["energy_hartree"] = "-999"
    elif location == "frame_hash":
        view["frames"][0]["frame_hash"] = "sha256:" + "b" * 64
    else:
        view["playback"]["clock"] = "physical_time_s"
    with pytest.raises(ValueError, match="display differs"):
        validate_refinement_view(spec, result, rehash_view(view))


def test_forged_result_energy_rejected_even_if_result_hash_resealed():
    spec, result = fixture_result()
    result["trajectory"][0]["energy_hartree"] = "-999"
    frame = result["trajectory"][0]
    frame["frame_hash"] = content_hash({k: v for k, v in frame.items() if k != "frame_hash"})
    result["result_hash"] = content_hash({k: v for k, v in result.items() if k != "result_hash"})
    with pytest.raises(ValueError, match="energy differs"):
        build_refinement_view(spec, result)


def test_view_mutation_does_not_modify_source_result_or_future_views():
    spec, result = fixture_result()
    originals = copy.deepcopy((spec, result))
    view = build_refinement_view(spec, result)
    view["frames"][0]["coordinate_table"][0]["position_angstrom"][0] = "123"
    view["raw_artifacts"][0]["sha256"] = "c" * 64
    assert (spec, result) == originals
    assert (
        build_refinement_view(spec, result)["frames"][0]["coordinate_table"][0][
            "position_angstrom"
        ][0]
        == "0"
    )
