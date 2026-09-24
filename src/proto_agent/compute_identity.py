"""Read-only version/environment identities for reuse of fixed Compute results.

An identity is not an execution receipt, output-integrity check, binary
attestation, or promise of numerical reproducibility on another machine.
Numerical packages are never imported here.
"""
from __future__ import annotations

import hashlib
import importlib.metadata as package_metadata
import json
import os
import platform
import re
import sys
import types
from pathlib import Path
from typing import Any

SCHEMA = "proto-agent.compute-fingerprint.v1"
MAX_SOURCE_FILE = 4 * 1024 * 1024
MAX_SOURCE_TOTAL = 32 * 1024 * 1024
MAX_SOURCE_FILES = 512
MAX_DISTRIBUTIONS = 512
MAX_METADATA_BYTES = 16 * 1024 * 1024
MAX_DEPENDENCIES = 128
PACKAGE_NAMES = {"Bio": "biopython", "RNA": "viennarna", "cv2": "opencv-python-headless",
                 "libsbml": "python-libsbml", "skimage": "scikit-image", "sklearn": "scikit-learn"}
THREAD_ENVIRONMENT = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
                      "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS", "PYTHONHASHSEED")
# Complete registry classification: fixed data transforms are deterministic for
# this version/environment identity unless one of these inspected exceptions
# applies. Explicit/default seeds below are material, not assumed absent.
UNCACHEABLE_TOOLS = {
    "bayesian_finemapping_with_deep_vi": "GLOBAL_TORCH_RANDOM_STATE_NOT_ISOLATED",
    "decode_behavior_from_neural_trajectories": "PCA_SOLVER_RANDOM_STATE_NOT_EXPLICIT",
}
FIXED_SEEDS = {"quantify_and_cluster_cell_motility": 0, "optimize_anaerobic_digestion_process": 0}
# Explicit coverage of the reviewed 127-tool registry. New registry entries do
# not inherit a cache policy until their randomness and external inputs are read.
REVIEWED_TOOLS = frozenset("""
adjust_pvalues align_sequences analyze_abr_waveform_p1_metrics
analyze_accelerated_stability_of_pharmaceutical_formulations analyze_aortic_diameter_and_geometry
analyze_arsenic_speciation_hplc_icpms analyze_atp_luminescence_assay analyze_bacterial_growth_curve
analyze_bacterial_growth_rate analyze_barcode_sequencing_data analyze_bifurcation_diagram
analyze_bone_microct_morphometry analyze_calcium_imaging_data analyze_cas9_mutation_outcomes
analyze_cell_migration_metrics analyze_cell_morphology_and_cytoskeleton analyze_cell_senescence_and_apoptosis
analyze_cfse_cell_proliferation analyze_chromatin_interactions analyze_ciliary_beat_frequency
analyze_circular_dichroism_spectra analyze_cns_lesion_histology analyze_crispr_genome_editing
analyze_cytokine_production_in_cd4_tcells analyze_ddr_network_in_cancer analyze_ebv_antibody_titers
analyze_ecological_diversity analyze_endolysosomal_calcium_dynamics analyze_fatty_acid_composition_by_gc
analyze_flow_cytometry_immunophenotyping analyze_genomic_region_overlap analyze_hemodynamic_data
analyze_immunohistochemistry_image analyze_in_vitro_drug_release_kinetics analyze_intracellular_calcium_with_rhod2
analyze_itc_binding_thermodynamics analyze_mitochondrial_morphology_and_potential analyze_myofiber_morphology
analyze_pixel_distribution analyze_protein_colocalization analyze_protein_comparison analyze_protein_conservation
analyze_protein_phylogeny analyze_protein_physicochemistry analyze_qpcr_relative_expression
analyze_radiolabeled_antibody_biodistribution analyze_rna_secondary_structure_features analyze_rnaseq_study
analyze_sequence_composition analyze_thrombus_histology analyze_tissue_deformation_flow analyze_western_blot
analyze_xenograft_tumor_growth_inhibition annotate_open_reading_frames batch_register_images
bayesian_finemapping_with_deep_vi calculate_brain_adc_map calculate_physicochemical_properties
calculate_similarity_metrics compare_protein_structures compare_two_groups contingency_test correlation
count_bacterial_colonies create_biochemical_network_sbml_model create_segmentation_visualization
decode_behavior_from_neural_trajectories descriptive_statistics design_golden_gate_oligos design_primer
design_sgrna_spacers design_verification_primers digest_sequence enumerate_bacterial_cfu_by_serial_dilution
estimate_alpha_particle_radiotherapy_dosimetry estimate_cell_cycle_phase_durations find_n_glycosylation_motifs
find_restriction_enzymes find_restriction_sites find_roi_from_image find_sequence_mutations fit_genomic_prediction_model
fit_michaelis_menten gene_set_enrichment_analysis golden_gate_assembly grade_adverse_events_using_vcog_ctcae
import_colabfold_result liftover_coordinates linear_regression model_bacterial_growth_dynamics
model_protein_dimerization_network normalize_gene_expression_counts one_way_anova optimize_anaerobic_digestion_process
optimize_codons_for_heterologous_expression pcr_simple perform_cosinor_analysis perform_flux_balance_analysis
perform_gene_expression_nmf_analysis perform_mwas_cyp2c19_metabolizer_status predict_o_glycosylation_hotspots
predict_rna_secondary_structure prepare_input_for_nnunet preprocess_image principal_component_analysis
quantify_amyloid_beta_plaques quantify_and_cluster_cell_motility quantify_biofilm_biomass_crystal_violet
quantify_cell_cycle_phases_from_microscopy quantify_corneal_nerve_fibers quick_affine_registration
quick_deformable_registration quick_rigid_registration reconstruct_3d_face_from_mri segment_and_analyze_microbial_cells
segment_and_quantify_cells_in_multiplexed_images simulate_demographic_history simulate_gene_circuit_with_growth_feedback
simulate_generalized_lotka_volterra_dynamics simulate_metabolic_network_perturbation simulate_microbial_population_dynamics
simulate_protein_signaling_network simulate_renin_angiotensin_system_dynamics simulate_thyroid_hormone_pharmacokinetics
simulate_whole_cell_ode_model split_modalities track_immune_cells_under_flow
""".split())
_SOURCE_BASELINE: dict[str, str] | None = None
_STATE_BASELINE: dict[str, str] = {}
_INITIAL_CODE_REASONS: list[str] = []
_PACKAGE_BASELINE: dict[str, str] | None = None


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def _sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _source_tree() -> dict[str, bytes]:
    root = Path(__file__).resolve().parent
    paths = sorted(root.glob("*.py"))
    if not {"compute.py", "compute_identity.py"} <= {path.name for path in paths}:
        raise ValueError("Application source identity is unavailable in this distribution.")
    if len(paths) > MAX_SOURCE_FILES:
        raise ValueError("Implementation source inventory exceeds its bound.")
    result, total = {}, 0
    for path in paths:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_SOURCE_FILE:
            raise ValueError("Implementation source cannot be bounded as a regular file.")
        content = path.read_bytes()
        total += len(content)
        if len(content) > MAX_SOURCE_FILE or total > MAX_SOURCE_TOTAL:
            raise ValueError("Implementation source inventory exceeds its byte bound.")
        result[path.name] = content
    if [path.name for path in sorted(root.glob("*.py"))] != list(result):
        raise ValueError("Implementation source inventory changed while reading.")
    return result


def _code_digest(code: types.CodeType) -> str:
    def normalize(item):
        if isinstance(item, types.CodeType):
            return {"code": item.co_code.hex(), "constants": [normalize(value) for value in item.co_consts],
                    "names": item.co_names, "variables": item.co_varnames, "free": item.co_freevars, "cells": item.co_cellvars,
                    "flags": item.co_flags, "args": item.co_argcount, "posonly": item.co_posonlyargcount,
                    "kwonly": item.co_kwonlyargcount, "locals": item.co_nlocals, "stack": item.co_stacksize,
                    "exceptions": getattr(item, "co_exceptiontable", b"").hex()}
        if isinstance(item, (tuple, frozenset)):
            children = [normalize(value) for value in item]
            return {"type": type(item).__name__, "items": sorted(children, key=lambda value: _canonical(value)) if isinstance(item, frozenset) else children}
        return {"type": type(item).__name__, "value": item.hex() if isinstance(item, bytes) else repr(item)}
    return _sha(_canonical(normalize(code)))


def _loaded_code_reasons(tree: dict[str, bytes]) -> list[str]:
    """Compare live Python functions with compiled current source, without exec."""
    reasons = []
    for name, module in list(sys.modules.items()):
        if not name.startswith("proto_agent.") or not isinstance(module, types.ModuleType):
            continue
        filename = getattr(module, "__file__", None)
        if not filename or Path(filename).name not in tree:
            continue
        functions = []
        def members(owner):
            for value in vars(owner).values():
                if isinstance(value, (staticmethod, classmethod)):
                    value = value.__func__
                if isinstance(value, types.FunctionType) and value.__module__ == name and value.__code__.co_filename == filename:
                    functions.append(value)
                elif isinstance(value, type) and value.__module__ == name:
                    members(value)
                elif isinstance(value, property):
                    functions.extend(function for function in (value.fget, value.fset, value.fdel)
                                     if function is not None and function.__module__ == name and function.__code__.co_filename == filename)
        members(module)
        if not functions:
            continue
        try:
            compiled = compile(tree[Path(filename).name], filename, "exec", dont_inherit=True, optimize=sys.flags.optimize)
        except (ValueError, SyntaxError, UnicodeError):
            reasons.append("IMPLEMENTATION_SOURCE_NOT_COMPILABLE:" + name)
            continue
        available = set()
        def collect(code):
            available.add(_code_digest(code))
            for child in code.co_consts:
                if isinstance(child, types.CodeType):
                    collect(child)
        collect(compiled)
        if any(_code_digest(function.__code__) not in available for function in functions):
            reasons.append("LOADED_IMPLEMENTATION_DIFFERS_FROM_DISK:" + name)
    return reasons


def _state_identity(module) -> str:
    """Bind registry/constants without process IDs, imports, caches or objects."""
    state = {}
    for name, value in vars(module).items():
        if name.startswith("__") or name in {"HANDLERS"} or not name.isupper():
            continue
        try:
            _canonical(value)
        except (TypeError, ValueError, RecursionError):
            continue
        state[name] = value
    return _sha(_canonical(state))


def _normal_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def _installed_inventory() -> dict[str, dict]:
    inventory, total = {}, 0
    for distribution in package_metadata.distributions():
        name = distribution.metadata.get("Name")
        if not name:
            raise ValueError("Installed distribution has no package identity.")
        key = _normal_name(name)
        if key == "proto-agent":
            continue  # Editable/frozen application is covered by source identity.
        if key in inventory:
            raise ValueError("Ambiguous installed distribution identity: " + key)
        pieces = {}
        for file in ("METADATA", "WHEEL", "RECORD", "direct_url.json"):
            content = distribution.read_text(file)
            if content is not None:
                encoded = content.encode("utf-8")
                total += len(encoded)
                if total > MAX_METADATA_BYTES:
                    raise ValueError("Installed environment metadata exceeds its bound.")
                pieces[file] = _sha(encoded)
        inventory[key] = {"name": key, "version": distribution.version,
                          "metadata_sha256": _sha(_canonical(pieces)),
                          "requires": sorted(distribution.requires or [])}
        if len(inventory) > MAX_DISTRIBUTIONS:
            raise ValueError("Installed environment inventory exceeds its bound.")
    return inventory


def register_loaded_compute() -> None:
    """Called once at the end of Compute import, before numerical warm-up."""
    global _SOURCE_BASELINE, _PACKAGE_BASELINE, _INITIAL_CODE_REASONS
    if _SOURCE_BASELINE is not None:
        return
    try:
        tree = _source_tree()
        _SOURCE_BASELINE = {name: _sha(data) for name, data in tree.items()}
        _INITIAL_CODE_REASONS = _loaded_code_reasons(tree)
        for name, module in list(sys.modules.items()):
            if name == "proto_agent.compute" or name.startswith("proto_agent.compute_") and name != __name__ or name == "proto_agent.rnaseq_data":
                _STATE_BASELINE[name] = _state_identity(module)
        inventory = _installed_inventory()
        _PACKAGE_BASELINE = {name: item["metadata_sha256"] for name, item in inventory.items()}
    except (OSError, ValueError, TypeError) as exc:
        _SOURCE_BASELINE = _SOURCE_BASELINE or {}
        _INITIAL_CODE_REASONS.append("STARTUP_IDENTITY_UNAVAILABLE:" + type(exc).__name__)


def _implementation(tool, metadata, handler):
    reasons = list(_INITIAL_CODE_REASONS)
    try:
        tree = _source_tree()
        current = {name: _sha(data) for name, data in tree.items()}
        if current != _SOURCE_BASELINE:
            reasons.append("IMPLEMENTATION_CHANGED_SINCE_PROCESS_START")
        reasons.extend(_loaded_code_reasons(tree))
        for name, baseline in _STATE_BASELINE.items():
            module = sys.modules.get(name)
            if module is None or _state_identity(module) != baseline:
                reasons.append("LOADED_IMPLEMENTATION_STATE_CHANGED:" + name)
        if not isinstance(handler, types.FunctionType) or not handler.__module__.startswith("proto_agent.compute_"):
            reasons.append("HANDLER_IDENTITY_NOT_ESTABLISHED")
        material = {"tool": tool, "registry_sha256": _sha(_canonical(metadata)),
                    "source_tree_sha256": _sha(_canonical(current)), "source_files": len(current),
                    "loaded_code_matches_disk": not reasons,
                    "handler": {"module": getattr(handler, "__module__", None), "name": getattr(handler, "__qualname__", None),
                                "code_sha256": _code_digest(handler.__code__) if isinstance(handler, types.FunctionType) else None}}
    except (OSError, ValueError, TypeError, RecursionError) as exc:
        reasons.append("IMPLEMENTATION_IDENTITY_UNAVAILABLE:" + type(exc).__name__)
        material = {"tool": tool, "loaded_code_matches_disk": False}
    return material, reasons


def _dependency_closure(declared, inventory):
    pending = [(_normal_name(PACKAGE_NAMES.get(name, name)), frozenset()) for name in declared]
    found, processed, reasons = {}, set(), []
    # Requirement markers are parsed by the standard packaging library; absence
    # disables caching rather than importing scientific packages or guessing.
    try:
        from packaging.requirements import Requirement
    except ImportError:
        if pending:
            return [], ["DEPENDENCY_MARKER_PARSER_UNAVAILABLE"]
        return [], []
    if pending:
        pending.append(("packaging", frozenset()))
    while pending:
        name, extras = pending.pop()
        if (name, extras) in processed:
            continue
        processed.add((name, extras))
        if len(processed) > MAX_DEPENDENCIES * 4:
            return [], ["DEPENDENCY_CLOSURE_EXCEEDS_BOUND"]
        item = inventory.get(name)
        if item is None:
            reasons.append("RUNTIME_DEPENDENCY_UNAVAILABLE:" + name)
            found[name] = {"name": name, "available": False}
            continue
        found[name] = {key: item[key] for key in ("name", "version", "metadata_sha256")}
        if len(found) > MAX_DEPENDENCIES:
            return [], ["DEPENDENCY_CLOSURE_EXCEEDS_BOUND"]
        for raw in item["requires"]:
            try:
                requirement = Requirement(raw)
                if requirement.marker is not None and not any(requirement.marker.evaluate({"extra": extra}) for extra in extras | {""}):
                    continue
                dependency = _normal_name(requirement.name)
                installed = inventory.get(dependency)
                if installed is not None and requirement.specifier and not requirement.specifier.contains(installed["version"], prereleases=True):
                    reasons.append("RUNTIME_DEPENDENCY_VERSION_MISMATCH:" + dependency)
                pending.append((dependency, frozenset(requirement.extras)))
            except (ValueError, TypeError):
                reasons.append("DEPENDENCY_REQUIREMENT_NOT_UNDERSTOOD:" + name)
    return sorted(found.values(), key=lambda item: item["name"]), reasons


def _external_r_identity():
    from .bioinformatics import _configuration, _worker_command
    import subprocess
    configuration = _configuration()
    try:
        process = subprocess.run(_worker_command(["identity", "--engine", "deseq2"], configuration),
            capture_output=True, timeout=45, encoding="utf-8", errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if process.returncode or len(process.stdout.encode("utf-8")) > 1024 * 1024:
            return {"configuration": configuration, "checked": True, "available": False}, ["EXTERNAL_R_IDENTITY_UNAVAILABLE"]
        value = json.loads(process.stdout)
        if value.get("available") is not True or not isinstance(value.get("identity"), dict):
            return {"configuration": configuration, "checked": True, "available": False}, ["EXTERNAL_R_IDENTITY_UNAVAILABLE"]
        identity = value["identity"]
        return {"configuration": configuration, "checked": True, "available": True,
                "kind": "R-version-and-installed-package-environment", **identity}, []
    except (OSError, ValueError, subprocess.SubprocessError):
        return {"configuration": configuration, "checked": True, "available": False}, ["EXTERNAL_R_IDENTITY_UNAVAILABLE"]


def _runtime(metadata, tool, arguments):
    reasons = []
    material = {"kind": "versions-and-environment-metadata-not-binary-attestation",
                "python": {"version": platform.python_version(), "implementation": platform.python_implementation(),
                           "cache_tag": sys.implementation.cache_tag, "platform": platform.platform(), "machine": platform.machine(),
                           "compiler": platform.python_compiler()},
                "environment": {name: os.environ.get(name) for name in THREAD_ENVIRONMENT}}
    try:
        inventory = _installed_inventory()
        packages, dependency_reasons = _dependency_closure(metadata.get("dependency", []), inventory)
        reasons.extend(dependency_reasons)
        material["packages"] = packages
        material["dependency_closure_sha256"] = _sha(_canonical(packages))
        for item in packages:
            name = item["name"]
            if _PACKAGE_BASELINE is None or _PACKAGE_BASELINE.get(name) != item.get("metadata_sha256"):
                reasons.append("PACKAGE_ENVIRONMENT_CHANGED_SINCE_PROCESS_START:" + name)
            roots = [root for root, package in PACKAGE_NAMES.items() if package == name]
            roots.append(name.replace("-", "_"))
            for root in roots:
                module = sys.modules.get(root)
                loaded_version = vars(module).get("__version__") if isinstance(module, types.ModuleType) else None
                if isinstance(loaded_version, str) and "version" in item:
                    try:
                        from packaging.version import Version
                        matches = Version(loaded_version) == Version(item["version"])
                    except (ImportError, ValueError):
                        matches = loaded_version == item["version"]
                    if not matches:
                        reasons.append("LOADED_PACKAGE_VERSION_DIFFERS_FROM_INSTALLED:" + name)
    except (OSError, ValueError, TypeError) as exc:
        reasons.append("RUNTIME_IDENTITY_UNAVAILABLE:" + type(exc).__name__)
    if tool == "analyze_rnaseq_study" and arguments.get("analysis_mode", "fit") == "fit":
        external, external_reasons = _external_r_identity()
        material["external"] = external
        reasons.extend(external_reasons)
    return material, reasons


def _effective_arguments(value, schema):
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        result = {key: _effective_arguments(child, properties.get(key, {})) for key, child in value.items()}
        for key, definition in properties.items():
            if key not in result and "default" in definition:
                result[key] = definition["default"]
        return result
    if isinstance(value, list):
        return [_effective_arguments(child, schema.get("items", {})) for child in value]
    return value


def fingerprint_prepared(prepared):
    from .compute import HANDLERS
    paths, source, raw, request, metadata, _files, provenance, _dataset_context = prepared
    tool = request["tool"]
    arguments = _effective_arguments(request["arguments"], metadata["input_schema"])
    implementation, reasons = _implementation(tool, metadata, HANDLERS[tool])
    runtime, runtime_reasons = _runtime(metadata, tool, arguments)
    reasons.extend(runtime_reasons)
    determinism = {"classification": "fixed-reviewed-data-transform", "effective_seeds": {key: arguments[key] for key in ("seed", "random_seed") if key in arguments}}
    if tool in FIXED_SEEDS:
        determinism["implementation_seed"] = FIXED_SEEDS[tool]
    if tool in UNCACHEABLE_TOOLS:
        reasons.append(UNCACHEABLE_TOOLS[tool])
        determinism["classification"] = "not-established"
    if tool not in REVIEWED_TOOLS:
        reasons.append("TOOL_CACHE_POLICY_NOT_REVIEWED")
        determinism["classification"] = "not-established"
    implementation["determinism"] = determinism
    descriptors = []
    for field, entries in sorted(provenance.items()):
        listed = entries if isinstance(entries, list) else [entries]
        for index, (path, data) in enumerate(listed):
            descriptors.append({"field": field, "index": index, "path": path, "sha256": _sha(data), "bytes": len(data)})
    canonical_request = {"tool": tool, "arguments": arguments}
    if request.get("quantity_bindings") is not None:
        canonical_request["quantity_bindings"] = request["quantity_bindings"]
    materials = {"request": {"path": source.relative_to(paths.workspace).as_posix(), "sha256": _sha(raw), "bytes": len(raw),
                              "tool": tool, "canonical_sha256": _sha(_canonical(canonical_request))},
                 "files": descriptors, "implementation": implementation, "runtime": runtime}
    # Request filenames, whitespace, field ordering and timestamps are evidence,
    # not cache-key ingredients. Input file paths and their bytes remain bound.
    bound = {**materials, "request": {"tool": tool, "canonical_sha256": materials["request"]["canonical_sha256"]}}
    return {"ok": True, "schema_version": SCHEMA, "fingerprint_sha256": _sha(_canonical(bound)),
            "cacheable": not reasons, "reasons": sorted(set(reasons)), "materials": materials}


def compute_fingerprint(path: str, *, workspace_root: str | Path = ".") -> dict:
    from .compute import _load_compute_request
    return fingerprint_prepared(_load_compute_request(path, workspace_root=workspace_root))


def bind_execution_fingerprint(before, path, workspace_root):
    reasons = list(before["reasons"])
    verified = False
    try:
        after = compute_fingerprint(path, workspace_root=workspace_root)
        verified = before["fingerprint_sha256"] == after["fingerprint_sha256"] and before["materials"] == after["materials"]
        reasons.extend(after["reasons"])
        if not verified:
            reasons.append("EXECUTION_IDENTITY_CHANGED")
    except (OSError, ValueError, TypeError) as exc:
        reasons.append("EXECUTION_IDENTITY_RECHECK_FAILED:" + type(exc).__name__)
    return {"fingerprint_sha256": before["fingerprint_sha256"], "cacheable": before["cacheable"] and verified and not reasons,
            "verified_unchanged": verified, "materials": before["materials"], "reasons": sorted(set(reasons))}
