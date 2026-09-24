"""Host-owned policy for the Design selection preparation endpoint.

The browser supplies only a saved selection and mode. Observation paths, native
settings and budgets come from the local host. Preparation grants no execution
authority and never starts native science or a model.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from chem_workbench.execution_validation import digest_id
from chem_workbench.refinement_execution.disk_budget import DiskBudget
from chem_workbench.refinement_execution.host_evidence import ContainedReader
from chem_workbench.refinement_execution.preparation import (
    RefinementResources,
    load_trusted_preparation_observations,
    prepare_design_refinement,
)
from chem_workbench.refinement_execution.worker_subject_replay import closed, load_json

if TYPE_CHECKING:
    from chem_workbench.workflows import WorkflowService


@dataclass(frozen=True, kw_only=True)
class WorkbenchPreparationPolicy:
    """Local configuration; not an HTTP request schema or an approval."""

    observation_directory: str
    optimizer_binding_path: str | None = None

    @classmethod
    def from_environment(cls) -> WorkbenchPreparationPolicy:
        return cls(
            observation_directory=os.environ.get(
                "CHEM_REFINEMENT_OBSERVATIONS",
                "build/refinement-d3bj-complex-gradient-20260913",
            ),
            optimizer_binding_path=os.environ.get("CHEM_REFINEMENT_OPTIMIZER_BINDING"),
        )


def prepare_selection(
    workflows: WorkflowService,
    request: object,
    *,
    policy: WorkbenchPreparationPolicy | None = None,
) -> dict[str, Any]:
    """Freeze the selected Design bytes, then resolve the registered host plan."""
    data = closed(request, {"selection", "mode"}, "Design refinement request")
    selection = closed(data["selection"], {"run_ref", "candidate_hash"}, "Design selection")
    record_id = digest_id(selection["run_ref"])
    digest_id(selection["candidate_hash"])
    if type(data["mode"]) is not str or data["mode"] not in {"gradient", "optimization"}:
        raise ValueError("INVALID_ARGUMENT: refinement mode")
    policy = policy if policy is not None else WorkbenchPreparationPolicy.from_environment()
    if data["mode"] == "optimization" and policy.optimizer_binding_path is None:
        raise ValueError("OPTIMIZER_NOT_PREPARED: a host-observed optimizer binding is required")

    root = workflows.store.artifact_root
    reader = ContainedReader(root)
    original = workflows.store.root / "designs" / (record_id + ".json")
    record_ref = reader.ref(original.relative_to(root).as_posix())
    observations = load_trusted_preparation_observations(
        root=root, observation_directory=policy.observation_directory
    )
    optimizer_binding = None
    if data["mode"] == "optimization" and policy.optimizer_binding_path is not None:
        optimizer_binding = load_json(reader.raw(policy.optimizer_binding_path))

    parent = workflows.store.root / "refinement-preparations"
    parent.mkdir(exist_ok=True)
    reader.path(parent.relative_to(root).as_posix())
    directory = (parent / uuid.uuid4().hex).relative_to(root).as_posix()
    prepared = prepare_design_refinement(
        root=root,
        preparation_directory=directory,
        record_ref=record_ref,
        selection=dict(selection),
        electronic_state={"charge": 0, "multiplicity": 1},
        observations=observations,
        optimizer_settings=observations.source_optimizer_settings,
        resources=RefinementResources(
            wall_seconds=21600,
            memory_bytes=16 * 1024**3,
            cpu_seconds=86400,
            threads=8,
            max_output_bytes=20 * 1024**2,
        ),
        disk_budget=DiskBudget(
            max_run_bytes=32 * 1024**3,
            max_entries=20000,
            minimum_free_bytes=8 * 1024**3,
            scan_timeout_seconds=5.0,
            interval_seconds=2.0,
        ),
        mode=data["mode"],
        optimizer_binding=optimizer_binding,
    )
    # The receipt stays beside the immutable preparation. The workflow schema
    # receives precisely its declared refs, not additional request authority.
    return workflows.prepare_refinement(
        {
            key: prepared[key]
            for key in (
                "spec_ref",
                "subject_ref",
                "execution_contract_ref",
                "mode",
                "disk_budget",
                "selection",
            )
        }
    )
