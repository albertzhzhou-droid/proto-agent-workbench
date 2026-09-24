"""One-shot generator for the CIF, legacy compute and refinement registrations.

Run from the repository root after editing the adapter or its descriptors:
    .venv/Scripts/python.exe scripts/build_registry.py
The script recomputes every binding hash and rewrites builtin-registry.json.
Manifest package hashes pin their implementation bytes. Refinement includes the
complete package/resource closure while retaining separate legacy resource caps.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from chem_workbench.adapters.validation import (  # noqa: E402
    canonical_format_capability_hash,
    canonical_manifest_hash,
    validate_adapter_registry,
)
from chem_workbench.version import __version__  # noqa: E402

ADAPTER_MODULES = (
    "cif_probe.py",
    "cif_import.py",
)

ALLOWED_LOSS_CODES = sorted(
    [
        "CIF_DUPLICATE_ITEM",
        "CIF_LOOP_ROW_INCOMPLETE",
        "CIF_OCCUPANCY_DEFAULTED",
        "CIF_SYNTAX_ERROR",
        "MISSING_CELL_PARAMETER",
        "MISSING_FRACTIONAL_SITES",
        "MISSING_TYPE_SYMBOL",
        "MULTIPLE_DATA_BLOCKS",
        "NO_DATA_BLOCK",
        "NON_NUMERIC_SITE_VALUE",
        "PARTIAL_OCCUPANCY",
        "STANDARD_UNCERTAINTY_STRIPPED",
        "SYMMETRY_EXPANSION_REQUIRED",
        "UNKNOWN_ELEMENT",
        "UNKNOWN_SITE_VALUE",
        "UNMAPPED_CIF_ITEMS_PRESERVED",
    ]
)

IMPORT_ALLOWED_LOSS_CODES = sorted(
    [
        *ALLOWED_LOSS_CODES,
        "ATOM_SITE_LABELS_PRESERVED",
        "NON_ORTHOGONAL_CELL",
        "NON_POSITIVE_CELL_LENGTH",
    ]
)

SUPPORTED_FIELDS = sorted(
    [
        "/_atom_site_fract_x",
        "/_atom_site_fract_y",
        "/_atom_site_fract_z",
        "/_atom_site_label",
        "/_atom_site_occupancy",
        "/_atom_site_type_symbol",
        "/_cell_angle_alpha",
        "/_cell_angle_beta",
        "/_cell_angle_gamma",
        "/_cell_length_a",
        "/_cell_length_b",
        "/_cell_length_c",
        "/_space_group_IT_number",
        "/_space_group_name_H-M_alt",
        "/_space_group_symop_operation_xyz",
        "/_symmetry_equiv_pos_as_xyz",
        "/_symmetry_space_group_name_H-M",
    ]
)

IMPORT_SUPPORTED_FIELDS = sorted(
    [
        "/objects/*/payload/lattice/vectors",
        "/objects/*/payload/coordinate_system",
        "/objects/*/payload/sites/*/element",
        "/objects/*/payload/sites/*/coordinates",
        "/objects/*/payload/sites/*/label",
        "/objects/*/payload/sites/*/occupancy",
    ]
)


def main() -> int:
    package_material = b"".join(
        (ROOT / "src" / "chem_workbench" / "adapters" / name).read_bytes()
        for name in ADAPTER_MODULES
    )
    package_hash = hashlib.sha256(package_material).hexdigest()

    manifest = {
        "manifest_version": "adapter-capability/v1alpha1",
        "adapter_id": "chem.cif.probe",
        "adapter_version": "0.1.0",
        "adapter_type": "FormatAdapter",
        "permission_class": "local_pure",
        "package_hash": {
            "type": "adapter_package_hash",
            "algorithm": "sha256",
            "value": package_hash,
        },
        "schema_versions": ["chemir/v1alpha1", "loss/v1alpha1"],
        "operations": ["import_bytes"],
        "supported_profiles": ["cif-p1-explicit-typed-v1", "cif-p1-explicit-v1"],
        "required_backends": [],
        "network_policy": "deny",
        "environment_allowlist": [],
        "resource_ceilings": {
            "artifact_bytes": 16777216,
            "memory_bytes": 268435456,
            "stderr_bytes": 65536,
            "stdout_bytes": 16777216,
            "wall_time_seconds": 30,
        },
        "licenses": ["MIT"],
        "expected_loss_codes": IMPORT_ALLOWED_LOSS_CODES,
    }
    manifest_hash = canonical_manifest_hash(manifest)

    def capability(
        capability_id: str,
        classification: str,
        profile: str,
        supported_fields: list[str],
        allowed: list[str],
    ) -> dict:
        return {
            "capability_version": "format-capability/v1alpha1",
            "capability_id": capability_id,
            "adapter": {
                "id": "chem.cif.probe",
                "version": "0.1.0",
                "manifest_hash": manifest_hash,
            },
            "format": {
                "name": "cif",
                "dialect": "cif1.1-explicit-p1-subset",
                "media_type": "chemical/x-cif",
            },
            "direction": "import",
            "chemir_schema_version": "chemir/v1alpha1",
            "profile": profile,
            "operations": ["import_bytes"],
            "classification": classification,
            "normalization_profile": "source-preserving/v1alpha1",
            "aromaticity_policy": "not_applicable",
            "stereochemistry_policy": "not_applicable",
            "numeric_tolerance_policy": "exact_only",
            "supported_fields": supported_fields,
            "allowed_loss_codes": allowed,
            "loss_report_version": "loss/v1alpha1",
        }

    probe_capability = capability(
        "chem.cif.probe.cif-p1-explicit.import",
        "QUERY_ONLY",
        "cif-p1-explicit-v1",
        SUPPORTED_FIELDS,
        ALLOWED_LOSS_CODES,
    )
    import_capability = capability(
        "chem.cif.probe.cif-p1-explicit.structure-import",
        "SEMANTIC_EQUIVALENT_UNDER_PROFILE",
        "cif-p1-explicit-typed-v1",
        IMPORT_SUPPORTED_FIELDS,
        IMPORT_ALLOWED_LOSS_CODES,
    )

    registry = {
        "registry_version": "adapter-registry/v1alpha1",
        "product": {"name": "chem-workbench", "version": __version__},
        "discovery": {
            "mode": "static_only",
            "python_entry_points": False,
            "module_scan": False,
            "path_scan": False,
            "executable_path_probe": False,
            "network_probe": False,
        },
        "adapters": [
            {
                "manifest": manifest,
                "manifest_hash": manifest_hash,
                "format_capabilities": [
                    {
                        "capability": probe_capability,
                        "capability_hash": canonical_format_capability_hash(probe_capability),
                    },
                    {
                        "capability": import_capability,
                        "capability_hash": canonical_format_capability_hash(import_capability),
                    },
                ],
                "implementation_status": "installed_verified",
                "conformance_status": "experimental",
                "enabled": True,
            }
        ],
    }
    from chem_workbench.adapters.governed_compute import compute_registrations

    registry["adapters"].extend(compute_registrations())
    validate_adapter_registry(registry)
    destination = ROOT / "src" / "chem_workbench" / "adapters" / "builtin-registry.json"
    destination.write_text(
        json.dumps(registry, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {destination} ({destination.stat().st_size} bytes)")
    print(f"manifest_hash=sha256:{manifest_hash['value']}")
    print(
        "probe_capability_hash=sha256:"
        f"{canonical_format_capability_hash(probe_capability)['value']}"
    )
    print(
        "import_capability_hash=sha256:"
        f"{canonical_format_capability_hash(import_capability)['value']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
