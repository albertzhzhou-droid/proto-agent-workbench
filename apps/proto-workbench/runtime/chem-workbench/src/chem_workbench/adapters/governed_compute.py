"""First-party compute descriptor and lowering facade; execution stays in the host runner."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from chem_workbench.method_profiles import D3BJ_PROFILE_ID
from chem_workbench.paths import resource_root

IMPLEMENTATION_FILES = (
    "execution.py",
    "execution_validation.py",
    "worker_supervision.py",
    "runtime_identity.py",
    "molecular_compute.py",
    "readiness.py",
    "paths.py",
    "adapters/governed_compute.py",
)


LEGACY_PROFILES = (
    "ase.emt.cu.scan.v1",
    "qcengine.psi4.hf_sto3g.organic.v1",
    "qcengine.psi4.hf_sto3g.smoke.v1",
)
LEGACY_RESOURCE_CEILINGS = {
    "artifact_bytes": 10000000,
    "memory_bytes": 3221225472,
    "stderr_bytes": 10000000,
    "stdout_bytes": 10000000,
    "wall_time_seconds": 600,
}


def _package_root() -> Path:
    return Path(__file__).resolve().parents[1]


def refinement_implementation_files() -> dict[str, str]:
    """Hash the complete shipped source/data closure with portable logical paths.

    Package Python and JSON files are included. Exactly
    ``adapters/builtin-registry.json`` is excluded to avoid a self-referential
    manifest hash. ``__pycache__`` is excluded, and packaged ``runtime/`` is
    inventoried through resource_root instead so source and wheel layouts agree.
    Shipped scripts/examples/third_party/evaluations include .py/.json/.ps1;
    uv.lock and all shipped schema JSON are also bound. No adapter is discovered
    or imported by this filesystem inventory.
    """
    package = _package_root()
    resources = resource_root()
    result: dict[str, str] = {}

    def inventory(root: Path, logical: str, *, package_tree: bool = False) -> None:
        if not root.is_dir():
            return
        for directory, children, filenames in os.walk(root, followlinks=False):
            parent = Path(directory)
            for name in children + filenames:
                path = parent / name
                if path.is_symlink() or getattr(path.lstat(), "st_file_attributes", 0) & 0x400:
                    raise ValueError("COMPUTE_REGISTRATION_STALE: linked implementation content")
            children[:] = sorted(
                name
                for name in children
                if name != "__pycache__"
                and not (package_tree and parent == root and name == "runtime")
            )
            for name in sorted(filenames):
                path = parent / name
                relative = path.relative_to(root).as_posix()
                if path.suffix not in {".py", ".json", ".ps1"}:
                    continue
                if package_tree and relative == "adapters/builtin-registry.json":
                    continue
                result[logical + "/" + relative] = hashlib.sha256(path.read_bytes()).hexdigest()

    inventory(package, "package", package_tree=True)
    for name in ("scripts", "examples", "third_party", "evaluations"):
        inventory(resources / name, "package/runtime/" + name)
    if not (package / "schemas").is_dir():
        inventory(resources / "schemas", "package/schemas")
    result["package/runtime/uv.lock"] = hashlib.sha256(
        (resources / "uv.lock").read_bytes()
    ).hexdigest()
    required = {
        "package/refinement_execution/worker_entry.py",
        "package/refinement_execution/runtime_preflight.py",
        "package/refinement_execution/worker_lifecycle.py",
        "package/refinement_execution/governed_plan.py",
        "package/runtime/scripts/worker_refinement_psi4.py",
        "package/runtime/scripts/run_psi4_python.ps1",
        "package/runtime/scripts/build_registry.py",
    }
    if not required.issubset(result):
        raise ValueError("COMPUTE_REGISTRATION_STALE: incomplete refinement implementation")
    return dict(sorted(result.items()))


def implementation_hash(profile: str | None = None) -> str:
    if profile == D3BJ_PROFILE_ID:
        value = {
            "version": "governed-refinement-implementation/v1",
            "files": refinement_implementation_files(),
        }
        return hashlib.sha256(
            json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    if profile is not None and profile not in LEGACY_PROFILES:
        raise ValueError("UNSUPPORTED_PROFILE: no registered implementation for this profile")
    # Keep the original legacy profile hash algorithm and resource declarations.
    package = _package_root()
    digest = hashlib.sha256()
    for name in IMPLEMENTATION_FILES:
        digest.update(name.encode())
        digest.update((package / name).read_bytes())
    for name in (
        "worker_mock.py",
        "worker_ase_emt.py",
        "worker_water_psi4.py",
        "worker_molecular_psi4.py",
        "run_psi4_python.ps1",
    ):
        digest.update(name.encode())
        digest.update((resource_root() / "scripts" / name).read_bytes())
    return digest.hexdigest()


def resolve(
    profile: str,
    value: dict[str, Any],
    *,
    root: Path | None = None,
    observed_worker_identity: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if profile == D3BJ_PROFILE_ID:
        require_registration(profile)
        if root is None or observed_worker_identity is None:
            raise ValueError(
                "HOST_CONTEXT_REQUIRED: artifact root and independently observed worker"
            )
        expected = {"spec_ref", "subject_ref", "execution_contract_ref", "mode", "disk_budget"}
        if set(value) != expected:
            raise ValueError("INVALID_ARGUMENT: exact refinement lowering references required")
        from chem_workbench.refinement_execution.governed_plan import prepare

        return prepare(
            root=root,
            spec_ref=value["spec_ref"],
            subject_ref=value["subject_ref"],
            execution_contract_ref=value["execution_contract_ref"],
            mode=value["mode"],
            disk_budget=value["disk_budget"],
            observed_worker_identity=observed_worker_identity,
        )
    from chem_workbench.execution import (
        build_cu_resolved_plan,
        build_molecular_resolved_plan,
        build_water_resolved_plan,
    )

    if profile == "ase.emt.cu.scan.v1":
        return build_cu_resolved_plan(value)
    if profile == "qcengine.psi4.hf_sto3g.smoke.v1":
        return build_water_resolved_plan(value)
    if profile == "qcengine.psi4.hf_sto3g.organic.v1":
        return build_molecular_resolved_plan(value)
    raise ValueError("UNSUPPORTED_PROFILE: no registered lowering for this profile")


def compute_registrations() -> list[dict[str, Any]]:
    """Construct static declarations for the registry generator without writing it.

    Descriptor registration supplies neither an approval token nor native/scientific
    acceptance. Refinement has a separate entry so legacy resource caps stay intact.
    Disk use remains bound to the explicit governed plan's disk_budget; the manifest
    does not falsely represent the capture byte ceiling as a total scratch limit.
    """
    from chem_workbench.adapters.validation import (
        canonical_manifest_hash,
        validate_adapter_manifest,
    )
    from chem_workbench.refinement_execution.refinement_plan import LIMITS

    registrations = []
    for identity, profiles, backends, ceilings, profile in (
        (
            "chem.compute.governed",
            list(LEGACY_PROFILES),
            ["ase.emt", "qcengine.psi4"],
            LEGACY_RESOURCE_CEILINGS,
            None,
        ),
        (
            "chem.compute.refinement",
            [D3BJ_PROFILE_ID],
            ["psi4.optking", "qcengine.psi4", "s-dftd3"],
            {
                "cpu_threads": LIMITS["threads"],
                "memory_bytes": LIMITS["memory_bytes"],
                "wall_time_seconds": LIMITS["wall_seconds"],
                "stdout_bytes": LIMITS["max_output_bytes"],
                "stderr_bytes": LIMITS["max_output_bytes"],
            },
            D3BJ_PROFILE_ID,
        ),
    ):
        manifest = validate_adapter_manifest(
            {
                "manifest_version": "adapter-capability/v1alpha1",
                "adapter_id": identity,
                "adapter_version": "0.1.0",
                "adapter_type": "ComputeAdapter",
                "permission_class": "compute_descriptor",
                "package_hash": {
                    "type": "adapter_package_hash",
                    "algorithm": "sha256",
                    "value": implementation_hash(profile),
                },
                "schema_versions": ["chemir/v1alpha1"],
                "operations": ["resolve", "validate"],
                "supported_profiles": profiles,
                "required_backends": backends,
                "network_policy": "deny",
                "environment_allowlist": [],
                "resource_ceilings": dict(ceilings),
                "licenses": ["MIT"],
                "expected_loss_codes": [],
            }
        )
        registrations.append(
            {
                "manifest": manifest,
                "manifest_hash": canonical_manifest_hash(manifest),
                "format_capabilities": [],
                "implementation_status": "installed_verified",
                "conformance_status": "experimental",
                "enabled": True,
            }
        )
    return registrations


def require_registration(profile: str) -> None:
    from chem_workbench.adapters.registry import load_bundled_registry

    if profile not in (*LEGACY_PROFILES, D3BJ_PROFILE_ID):
        raise ValueError("UNSUPPORTED_PROFILE: no registered lowering for this profile")
    adapter_id = (
        "chem.compute.refinement" if profile == D3BJ_PROFILE_ID else "chem.compute.governed"
    )
    registry = load_bundled_registry()
    entry = next(
        (r for r in registry.document["adapters"] if r["manifest"]["adapter_id"] == adapter_id),
        None,
    )
    if entry is None or not registry.resolve_manifest(entry["manifest"]).active:
        raise ValueError("COMPUTE_NOT_REGISTERED")
    manifest = entry["manifest"]
    if profile not in manifest["supported_profiles"] or manifest["package_hash"][
        "value"
    ] != implementation_hash(profile):
        raise ValueError("COMPUTE_REGISTRATION_STALE: implementation or profile differs")
