"""Admission preserves retained complex mechanisms without running an ODE solver."""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
from unittest.mock import Mock

import pytest

from chem_workbench import interface_simulation as interface
from chem_workbench.visualization import content_hash

FIXTURE = Path(__file__).parent / "fixtures/design-interface-export-retained.json"


@pytest.fixture(params=interface.PROFILE_PARAMETERS)
def retained_inputs(request):
    # Previously retained UI study, not a replacement model evaluation case.
    payload = FIXTURE.read_bytes()
    assert hashlib.sha256(payload).hexdigest() == (
        "febdbb98a5cd4fd10db8a351be1d118b55ae411cef87214ebcdfff92f91439af"
    )
    record = json.loads(payload)
    inputs = next(
        item["inputs"] for item in record["interfaces"] if item["profile"] == request.param
    )
    assert inputs["organic_candidate"]["complexity"]["heavy_atoms"] == 19
    assert inputs["inorganic_candidate"]["validation"]["atom_count"] == 40
    return inputs


def lose_bond_order_number_type(spec):
    original = copy.deepcopy(spec["mechanism"])
    bond = next(
        bond
        for species in spec["mechanism"]["species"]
        for bond in species["graph"]["bonds"]
        if type(bond["order"]) is float and bond["order"].is_integer()
    )
    bond["order"] = int(bond["order"])
    # This is precisely the equality gap caused by JSON.parse / JSON.stringify.
    assert spec["mechanism"] == original
    assert content_hash(spec["mechanism"]) != content_hash(original)


def test_retained_original_mechanism_is_admitted_without_mutating_inputs(retained_inputs):
    before = content_hash(retained_inputs)
    spec = retained_inputs["spec"]
    profile, _, initial, times = interface._validate(
        spec, retained_inputs["organic_candidate"], retained_inputs["inorganic_candidate"]
    )
    assert profile == spec["profile"]
    assert len(initial) == len(interface.INITIAL_FIELDS[profile])
    assert times == spec["time_grid"]["values"]
    assert content_hash(retained_inputs) == before


@pytest.mark.parametrize("rehash", [False, True], ids=["stale-hash", "rehashed-tampering"])
def test_number_type_loss_is_rejected_before_solver(retained_inputs, rehash, monkeypatch):
    spec = retained_inputs["spec"]
    lose_bond_order_number_type(spec)
    mechanism = spec["mechanism"]
    if rehash:
        mechanism["mechanism_hash"] = content_hash(
            {key: value for key, value in mechanism.items() if key != "mechanism_hash"}
        )
    before = content_hash(retained_inputs)
    solver = Mock(side_effect=AssertionError("Rejected input must never reach the solver"))
    monkeypatch.setattr("scipy.integrate.solve_ivp", solver)
    message = "MECHANISM_BINDING_MISMATCH" if rehash else "MECHANISM_HASH_MISMATCH"
    with pytest.raises(ValueError, match=message):
        interface.simulate_interface(
            spec, retained_inputs["organic_candidate"], retained_inputs["inorganic_candidate"]
        )
    solver.assert_not_called()
    assert content_hash(retained_inputs) == before
