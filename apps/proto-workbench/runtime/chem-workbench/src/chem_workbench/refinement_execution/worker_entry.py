"""First-party v2 worker wiring; authorization comes through the host sideband."""

from __future__ import annotations

import importlib
import os
from pathlib import Path
from typing import Any

from chem_workbench.molecular_refinement import validate_refinement_spec
from chem_workbench.paths import psi4_prefix
from chem_workbench.refinement_execution.launch_context import (
    HostLaunchContext,
    load_launch_context,
    verify_launch_context,
)
from chem_workbench.refinement_execution.runtime_preflight import make_runtime_verifier
from chem_workbench.refinement_execution.worker_lifecycle import (
    HostLaunchContext as LifecycleContext,
)
from chem_workbench.refinement_execution.worker_lifecycle import run_worker_lifecycle
from chem_workbench.refinement_execution.worker_subject_replay import replay_host_admitted_subject

Record = dict[str, Any]


def verify_subject(spec: Record, context: HostLaunchContext) -> None:
    """Replay the actual host-admitted Design closure without importing RDKit."""
    replay_host_admitted_subject(
        root=context.root,
        trusted_admission_ref=context.trusted_subject_admission_ref,
        expected_spec_ref=context.plan_context["artifact_refs"]["spec"],
        request_spec=spec,
        validate_spec=validate_refinement_spec,
    )


def run_v2(request: Record, *, input_path: Path, output_path: Path, root: Path) -> Record:
    """Consume one controlled launch before any native imports or calculations.

    The current packaged launcher uses its resource root for both code and run
    artifacts. Separate workspace roots require a corresponding launcher contract.
    """

    def admission(value: Record, context: HostLaunchContext) -> None:
        verify_subject(value["spec"], context)

    context = load_launch_context(
        root=root,
        code_root=root,
        runtime_root=psi4_prefix(root).resolve(),
        input_path=input_path,
        output_path=output_path,
        request=request,
        environment=os.environ,
        verify_host_admission=admission,
    )
    loaded: dict[str, Any] = {}

    def native(name: str) -> Any:
        if name not in loaded:
            loaded[name] = importlib.import_module(name)
        return loaded[name]

    runtime = make_runtime_verifier(import_module=native)

    def fixed_context(value: LifecycleContext) -> None:
        if value is not context:
            raise ValueError("HOST_LAUNCH_REJECTED: lifecycle context was replaced")

    def verify_host(value: Record, supplied: LifecycleContext) -> None:
        fixed_context(supplied)
        verify_launch_context(value, context)

    def verify_source(value: Record, supplied: LifecycleContext) -> None:
        fixed_context(supplied)
        verify_subject(value, context)

    def verify_runtime(value: Record, supplied: LifecycleContext) -> None:
        fixed_context(supplied)
        runtime(value, context)

    return run_worker_lifecycle(
        request,
        context=context,
        verify_host_admission=verify_host,
        verify_subject=verify_source,
        verify_runtime=verify_runtime,
        import_module=native,
    )
