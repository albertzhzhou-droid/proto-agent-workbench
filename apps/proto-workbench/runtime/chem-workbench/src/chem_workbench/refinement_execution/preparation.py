"""Prepare a new Design refinement from retained, host-selected observations.

No native import or calculation occurs here. The observation directory is a
trusted host configuration, not a user path. Its receipt pins retained bytes;
neither those pins nor this preparation grant execution authority or establish
that the installed runtime is still unchanged. Worker preflight must do that.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import stat
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, cast

from chem_workbench.method_profiles import D3BJ_PROFILE_ID, get_method_profile
from chem_workbench.molecular_refinement import (
    MASS_BOUND_SPEC_VERSION,
    MAX_RECORD_BYTES,
    _json_object,
    _raw_geometry,
    seal_refinement_spec,
    validate_refinement_spec,
)
from chem_workbench.refinement_execution.disk_budget import DiskBudget, OwnedRunDirectory
from chem_workbench.refinement_execution.execution_contract import (
    build_worker_request,
    seal_execution_contract,
)
from chem_workbench.refinement_execution.optimizer_loop import verify_bound_optimizer_artifact
from chem_workbench.refinement_execution.refinement_plan import LIMITS
from chem_workbench.refinement_execution.refinement_subject import (
    prepare_design_candidate_subject,
    verify_design_subject_for_spec,
)
from chem_workbench.refinement_execution.worker_subject_replay import artifact_ref, load_json
from chem_workbench.refinement_isotopes import seal_isotope_binding
from chem_workbench.visualization import content_hash

Record = dict[str, Any]
_OBSERVATION_FILES = {
    "basis-observation.json",
    "declared-native-options.json",
    "derivative-preflight.json",
    "dispersion-preflight.json",
    "effective-native-options.json",
    "input.json",
    "isotope-defaults-observed.json",
    "isotope-observation.json",
    "preflight-atomic-input.json",
    "runtime-manifest.json",
}
_SCOPE = (
    "Prepared retained Design candidate and inherited runtime observations only; "
    "no computation authority, current runtime admission, evaluated candidate, "
    "optimization convergence, minimum or scientific accuracy claim"
)


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError("REFINEMENT_PREPARATION: " + message)


def _same(actual: object, expected: object, label: str) -> None:
    _require(content_hash(actual) == content_hash(expected), label + " differs")


def _json(value: object) -> bytes:
    raw = json.dumps(value, sort_keys=True, allow_nan=False, indent=2).encode("utf-8")
    _require(len(raw) <= MAX_RECORD_BYTES, "record exceeds 20 MiB")
    return raw


def _identity(info: os.stat_result, *, allow_hardlinks: bool = False) -> tuple[int, int]:
    _require(
        stat.S_ISREG(info.st_mode)
        and (info.st_nlink >= 1 if allow_hardlinks else info.st_nlink == 1)
        and info.st_ino != 0
        and not getattr(info, "st_file_attributes", 0) & 0x400,
        "regular single-link file required",
    )
    return info.st_dev, info.st_ino


def _ancestors(path: Path) -> tuple[tuple[int, int], ...]:
    _require(path.is_absolute() and ".." not in path.parts, "absolute lexical root required")
    result = []
    for component in (*reversed(path.parents), path):
        info = component.lstat()
        _require(
            stat.S_ISDIR(info.st_mode)
            and info.st_ino != 0
            and not getattr(info, "st_file_attributes", 0) & 0x400,
            "linked or invalid directory component",
        )
        result.append((info.st_dev, info.st_ino))
    return tuple(result)


def _state(info: os.stat_result, *, allow_hardlinks: bool = False) -> tuple[int, ...]:
    # Reading may update atime. Compare ctime only within the same API: Windows
    # lstat/fstat can expose different ctime semantics for otherwise identical files.
    return (
        *_identity(info, allow_hardlinks=allow_hardlinks),
        info.st_mode,
        info.st_nlink,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
        getattr(info, "st_birthtime_ns", 0),
        getattr(info, "st_file_attributes", 0),
    )


def _read(
    root: Path, reference: object, *, unpinned: bool = False, allow_hardlinks: bool = False
) -> bytes:
    ref = artifact_ref(reference)
    path: Path = root / ref["path"]
    ancestors = _ancestors(path.parent)
    _require(path.is_relative_to(root), "artifact outside root")
    before = path.lstat()
    identity = _identity(before, allow_hardlinks=allow_hardlinks)
    with path.open("rb") as stream:
        handle_before = os.fstat(stream.fileno())
        _require(
            _identity(handle_before, allow_hardlinks=allow_hardlinks) == identity,
            "file replaced before read",
        )
        raw = stream.read(MAX_RECORD_BYTES + 1)
        handle_after = os.fstat(stream.fileno())
    after = path.lstat()
    _require(
        _identity(after, allow_hardlinks=allow_hardlinks) == identity
        and _state(handle_before, allow_hardlinks=allow_hardlinks)
        == _state(handle_after, allow_hardlinks=allow_hardlinks)
        and _state(before, allow_hardlinks=allow_hardlinks)
        == _state(after, allow_hardlinks=allow_hardlinks)
        and _ancestors(path.parent) == ancestors,
        "file changed while read",
    )
    _require(len(raw) <= MAX_RECORD_BYTES, "artifact exceeds 20 MiB")
    if not unpinned:
        _require(hashlib.sha256(raw).hexdigest() == ref["sha256"], "artifact bytes changed")
    return raw


def _ref(path: str, raw: bytes) -> Record:
    return artifact_ref({"path": path, "sha256": hashlib.sha256(raw).hexdigest()})


def _write(owned: OwnedRunDirectory, name: str, raw: bytes) -> Record:
    _require(len(raw) <= MAX_RECORD_BYTES, "artifact exceeds 20 MiB")
    owned.verify()
    reference = _ref(owned.relative_path + "/" + name, raw)
    path = owned.repository_root / reference["path"]
    with path.open("x+b") as stream:
        identity = _identity(os.fstat(stream.fileno()))
        _require(_identity(path.lstat()) == identity, "output replaced before write")
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
        _require(_identity(path.lstat()) == identity, "output replaced during write")
    owned.verify()
    _require(_read(owned.repository_root, reference) == raw, "retained output differs")
    return reference


@dataclass(frozen=True, kw_only=True)
class RefinementResources:
    """Five explicit governed ceilings; backend zero-retry policy is separate."""

    wall_seconds: int
    memory_bytes: int
    cpu_seconds: int
    threads: int
    max_output_bytes: int

    def validate(self) -> None:
        for name, ceiling in LIMITS.items():
            value = getattr(self, name)
            _require(type(value) is int and 1 <= value <= ceiling, "resource bound: " + name)


@dataclass(frozen=True, kw_only=True)
class TrustedPreparationObservations:
    """Host-selected retained directory, pinned when loaded; no authority token.

    Construct with ``load_trusted_preparation_observations``. All bytes are read
    and validated again at preparation, including the original receipt pin.
    """

    root: Path
    observation_directory: str
    receipt_path: str
    receipt_sha256: str
    _source_optimizer_settings_json: bytes

    @property
    def source_optimizer_settings(self) -> Record:
        """Detached historical declaration; this is not an optimizer observation."""
        return load_json(self._source_optimizer_settings_json)

    @property
    def receipt_ref(self) -> Record:
        return {"path": self.receipt_path, "sha256": self.receipt_sha256}


def _read_observations(root: Path, directory: str, receipt_ref: Record) -> Record:
    receipt_raw = _read(root, receipt_ref)
    receipt = load_json(receipt_raw)
    _require(receipt_ref["path"] == directory + "/preparation.json", "receipt directory")
    _require(
        receipt.get("version") == "refinement-d3bj-preparation/v1"
        and receipt.get("preparation_complete") is True
        and receipt.get("scientific_accuracy_validated") is False
        and "error" not in receipt,
        "complete retained D3BJ preparation required",
    )
    for key in ("electronic_evaluations", "dispersion_evaluations", "model_requests"):
        _same(receipt.get(key), 0, "historical " + key)
    files = receipt.get("files")
    _require(type(files) is dict and set(files) == _OBSERVATION_FILES, "observation inventory")
    files = cast(Record, files)
    references = {
        name: artifact_ref({"path": directory + "/" + name, "sha256": digest})
        for name, digest in files.items()
    }
    raw = {name: _read(root, ref) for name, ref in references.items()}
    records = {name: load_json(value) for name, value in raw.items()}
    request = records["input.json"]
    _require(
        set(request) == {"version", "mode", "spec"}
        and request["version"] == "refinement-worker-request/v1"
        and request["mode"] == "gradient",
        "retained observation request format",
    )
    spec = validate_refinement_spec(request["spec"])
    # This validates its method and dispatch, without reading the old subject or
    # borrowing its geometry for the new request.
    seal_execution_contract(spec, "gradient")
    _same(spec["spec_hash"], receipt.get("spec_hash"), "observation spec hash")
    _same(spec["runtime_binding"]["files"], [references["runtime-manifest.json"]], "manifest ref")
    _same(
        spec["electronic_settings"]["effective_options_artifact"],
        references["declared-native-options.json"],
        "native declaration ref",
    )
    _same(
        spec["isotope_binding"]["artifact"], references["isotope-observation.json"], "isotope ref"
    )
    manifest = records["runtime-manifest.json"]
    _require(
        manifest.get("version") == "refinement-runtime-content/v1"
        and manifest.get("profile_id") == D3BJ_PROFILE_ID
        and type(manifest.get("entries")) is dict,
        "runtime manifest format",
    )
    _same(manifest.get("manifest_hash"), content_hash(manifest["entries"]), "runtime entries")
    _same(manifest.get("files"), len(manifest["entries"]), "runtime file count")
    _same(receipt.get("runtime_files"), manifest["files"], "receipt runtime file count")
    basis_files = manifest.get("basis_files")
    _require(type(basis_files) is dict and bool(basis_files), "observed basis file inventory")
    basis_files = cast(Record, basis_files)
    for path, digest in manifest["entries"].items():
        artifact_ref({"path": path, "sha256": digest})
    for path, digest in basis_files.items():
        _same(manifest["entries"].get(path), digest, "basis in runtime manifest")
    for ref in spec["basis_binding"]["files"]:
        _require(ref["sha256"] in basis_files.values(), "bound basis absent from runtime")
        # Conda installs may hardlink immutable package data. Only these
        # independently manifest-pinned basis bytes permit multiple links;
        # observation records, Design files and new outputs remain single-link.
        _read(root, ref, allow_hardlinks=True)
    declaration = records["declared-native-options.json"]
    _require(
        declaration.get("version") == "refinement-native-options-declaration/v1",
        "declaration format",
    )
    keywords = spec["electronic_settings"]["native_keywords"]
    _same(declaration.get("native_keywords"), keywords, "declared native keywords")
    functional_hash = content_hash(declaration.get("functional_definition"))
    _same(functional_hash, declaration.get("functional_definition_hash"), "functional definition")
    _same(
        functional_hash,
        spec["electronic_settings"]["functional_definition_hash"],
        "spec functional",
    )
    effective = records["effective-native-options.json"]
    _require(set(effective) == set(keywords) - {"function_kwargs"}, "effective options inventory")
    for key, actual in effective.items():
        wanted = keywords[key]
        if type(wanted) is str:
            _require(
                type(actual) is str and actual.casefold() == wanted.casefold(),
                "effective option " + key,
            )
        elif type(wanted) is bool:
            _require(
                type(actual) is int and actual == int(wanted), "effective boolean option " + key
            )
        else:
            _same(actual, wanted, "effective option " + key)
    isotope = spec["isotope_binding"]
    isotope_body = {
        "version": "refinement-isotope-observation/v1",
        "policy": isotope["policy"],
        "geometry_hash": isotope["geometry_hash"],
        "runtime_binding_hash": isotope["runtime_binding_hash"],
        "atoms": isotope["atoms"],
    }
    _same(
        records["isotope-observation.json"],
        {**isotope_body, "observation_hash": content_hash(isotope_body)},
        "bound isotope observation",
    )
    _same(
        records["isotope-defaults-observed.json"],
        {
            "binding_hash": isotope["binding_hash"],
            "atoms": isotope["atoms"],
            "matches_bound_defaults": True,
            "backend_dispatches": 0,
        },
        "actual isotope defaults",
    )
    defaults: Record = {}
    for atom in isotope["atoms"]:
        row = {key: value for key, value in atom.items() if key != "atom_id"}
        if atom["element"] in defaults:
            _same(row, defaults[atom["element"]], "same-element observed defaults")
        defaults[atom["element"]] = row
    derivative = records["derivative-preflight.json"]
    _same(
        derivative,
        {
            "version": "refinement-derivative-preflight/v1",
            "spec_hash": spec["spec_hash"],
            "driver": "gradient",
            "method": spec["profile"]["method"],
            "required_derivative_order": 1,
            "observed_strategy": [1, 1],
            "analytic_gradient_available": True,
            "backend_dispatches": 0,
        },
        "analytic derivative observation",
    )
    dispersion = records["dispersion-preflight.json"]
    expected_dispersion = spec["profile"]["dispersion"]
    for key, expected in {
        "version": "refinement-dispersion-preflight/v1",
        "spec_hash": spec["spec_hash"],
        "engine": expected_dispersion["engine"],
        "level": expected_dispersion["type"],
        "needs_vv10": False,
        "program_available": True,
        "backend_dispatches": 0,
        "nested_program": "s-dftd3",
        "nested_attempts_observed": None,
        "parameters": {
            key: value for key, value in expected_dispersion["parameters"].items() if key != "s9"
        },
    }.items():
        _same(dispersion.get(key), expected, "dispersion " + key)
    _require(
        type(dispersion.get("library_api_version")) is str
        and bool(dispersion["library_api_version"]),
        "dispersion API version",
    )
    _require(
        type(dispersion.get("functional_name")) is str
        and dispersion["functional_name"].casefold() == spec["profile"]["method"],
        "dispersion functional name",
    )
    basis = records["basis-observation.json"]
    _require(
        type(basis.get("name")) is str
        and basis["name"].casefold() == spec["profile"]["basis"]
        and basis.get("puream") is True
        and type(basis.get("basis_functions")) is int
        and basis["basis_functions"] > 0
        and basis.get("integrals_evaluated") is False,
        "historical basis observation",
    )
    _same(basis.get("atoms"), len(spec["geometry"]["atoms"]), "historical basis atom count")
    _same(receipt.get("atom_count"), basis["atoms"], "receipt atom count")
    _same(receipt.get("basis_functions"), basis["basis_functions"], "receipt basis count")
    atomic = records["preflight-atomic-input.json"]
    _same(atomic.get("driver"), "gradient", "preflight driver")
    _same(
        atomic.get("model"),
        {"method": spec["profile"]["method"], "basis": spec["profile"]["basis"]},
        "preflight model",
    )
    _same(atomic.get("keywords"), keywords, "preflight keywords")
    _raw_geometry(
        _json_object(raw["preflight-atomic-input.json"].decode("utf-8"))["molecule"],
        spec["geometry"],
        isotope,
    )
    for name, ref in references.items():
        _require(_read(root, ref) == raw[name], "observation changed during verification")
    _require(_read(root, receipt_ref) == receipt_raw, "receipt changed during verification")
    return {
        "spec": spec,
        "defaults": defaults,
        "references": {"receipt": receipt_ref, **references},
        "basis_observation": basis,
    }


def load_trusted_preparation_observations(
    *, root: Path, observation_directory: str, expected_receipt_ref: object | None = None
) -> TrustedPreparationObservations:
    """Read the retained D3BJ component format, pin and cross-check every source.

    The caller selects this directory from host configuration. An optional prior
    receipt pin binds an already retained host identity. Otherwise the loader
    captures a stable pin now; it does not authenticate a user-provided directory.
    """
    _ancestors(root)
    reference = artifact_ref(
        {"path": observation_directory + "/preparation.json", "sha256": "0" * 64}
    )
    if expected_receipt_ref is None:
        reference = _ref(reference["path"], _read(root, reference, unpinned=True))
    else:
        supplied = artifact_ref(expected_receipt_ref)
        _same(supplied["path"], reference["path"], "expected receipt path")
        reference = supplied
    data = _read_observations(root, observation_directory, reference)
    return TrustedPreparationObservations(
        root=root,
        observation_directory=observation_directory,
        receipt_path=reference["path"],
        receipt_sha256=reference["sha256"],
        _source_optimizer_settings_json=_json(data["spec"]["optimizer_settings"]),
    )


def prepare_design_refinement(
    *,
    root: Path,
    preparation_directory: str,
    record_ref: object,
    selection: Record,
    electronic_state: Record,
    observations: TrustedPreparationObservations,
    optimizer_settings: Record,
    resources: RefinementResources,
    disk_budget: DiskBudget,
    mode: str,
    optimizer_binding: Record | None = None,
) -> Record:
    """Build new spec/subject/request artifacts; retain partial preparation on failure.

    The original record reference remains the subject's authoritative Design
    store reference; a byte-for-byte backup is also retained. New isotope rows
    are explicitly derived from consistent observed element defaults. A new
    candidate's basis size is never copied from the historical observation.
    """
    _require(type(resources) is RefinementResources, "typed explicit resources required")
    _require(type(disk_budget) is DiskBudget, "typed explicit disk budget required")
    resources.validate()
    disk_budget.validate()
    _require(type(mode) is str and mode in {"gradient", "optimization"}, "execution mode")
    if mode == "optimization" and optimizer_binding is None:
        raise ValueError(
            "OPTIMIZER_NOT_PREPARED: retained bound native optimizer observation required"
        )
    _require(mode != "gradient" or optimizer_binding is None, "gradient cannot bind an optimizer")
    _require(
        type(observations) is TrustedPreparationObservations and root == observations.root,
        "host observation root",
    )
    data = _read_observations(root, observations.observation_directory, observations.receipt_ref)
    _same(
        observations.source_optimizer_settings,
        data["spec"]["optimizer_settings"],
        "retained optimizer declaration",
    )
    original_ref = artifact_ref(record_ref)
    original_raw = _read(root, original_ref)
    record = load_json(original_raw)
    _require(
        type(selection) is dict and set(selection) == {"run_ref", "candidate_hash"},
        "selection fields",
    )
    _same(record.get("record_hash"), selection["run_ref"], "selected Design record")
    candidates = record.get("organic", {}).get("candidates", [])
    matches = [
        candidate
        for candidate in candidates
        if candidate.get("candidate_hash") == selection["candidate_hash"]
    ]
    _require(
        len(matches) == 1 and type(matches[0].get("source")) is str,
        "unique retained candidate source",
    )
    source_raw = matches[0]["source"].encode("utf-8")
    target_ref = artifact_ref(
        {"path": preparation_directory + "/preparation.json", "sha256": "0" * 64}
    )
    target = root / Path(target_ref["path"]).parent
    ancestors = _ancestors(target.parent)
    target.mkdir(exist_ok=False)
    _require(_ancestors(target.parent) == ancestors, "preparation parent replaced")
    owned = OwnedRunDirectory.capture(root, preparation_directory)
    outputs: Record = {}
    receipt: Record = {
        "version": "refinement-design-preparation/v1",
        "preparation_complete": False,
        "selection": copy.deepcopy(selection),
        "mode": mode,
        "original_design_record": original_ref,
        "observation_sources": data["references"],
        "basis_artifacts": copy.deepcopy(data["spec"]["basis_binding"]["files"]),
        "resources": asdict(resources),
        "disk_budget": asdict(disk_budget),
        "electronic_evaluations": 0,
        "dispersion_evaluations": 0,
        "model_requests": 0,
        "computation_authorized": False,
        "execution_authorized": False,
        "scientific_accuracy_validated": False,
        "scope": _SCOPE,
        "outputs": outputs,
    }
    try:
        outputs["design_record_backup"] = _write(owned, "design-record.original.json", original_raw)
        outputs["source"] = _write(owned, "candidate-source.original.chem", source_raw)
        subject = prepare_design_candidate_subject(
            record,
            selection,
            root=root,
            record_artifact=original_ref,
            source_artifact=outputs["source"],
            electronic_state=electronic_state,
        )
        outputs["subject"] = _write(owned, "subject.json", _json(subject))
        old = data["spec"]
        geometry = subject["geometry"]
        atoms = []
        for atom in geometry["atoms"]:
            _require(
                atom["element"] in data["defaults"],
                "no observed isotope default for element " + atom["element"],
            )
            atoms.append({"atom_id": atom["id"], **data["defaults"][atom["element"]]})
        isotope_body = {
            "version": "refinement-isotope-observation/v1",
            "policy": "runtime_default_isotopes",
            "geometry_hash": geometry["geometry_hash"],
            "runtime_binding_hash": old["runtime_binding"]["binding_hash"],
            "atoms": atoms,
        }
        outputs["derived_isotopes"] = _write(
            owned,
            "derived-isotope-binding-input.json",
            _json({**isotope_body, "observation_hash": content_hash(isotope_body)}),
        )
        isotope = seal_isotope_binding(
            {
                **isotope_body,
                "version": "refinement-isotope-binding/v1",
                "artifact": outputs["derived_isotopes"],
            },
            geometry,
            old["runtime_binding"],
        )
        spec = seal_refinement_spec(
            {
                "version": MASS_BOUND_SPEC_VERSION,
                "profile": get_method_profile(D3BJ_PROFILE_ID),
                "source_binding": {
                    "kind": "candidate_geometry",
                    "source_hash": subject["source_snapshot"]["source_text_hash"],
                    "candidate_hash": subject["candidate"]["candidate_hash"],
                    "atom_identity_hash": subject["atom_identity_hash"],
                    "geometry_hash": geometry["geometry_hash"],
                    "artifact": outputs["subject"],
                },
                "geometry": geometry,
                "electronic_settings": copy.deepcopy(old["electronic_settings"]),
                "optimizer_settings": copy.deepcopy(optimizer_settings),
                "environment": {
                    "boundary": "isolated",
                    "phase": "gas",
                    "solvent": None,
                    "physical_temperature_kelvin": None,
                },
                "runtime_binding": copy.deepcopy(old["runtime_binding"]),
                "basis_binding": copy.deepcopy(old["basis_binding"]),
                "isotope_binding": isotope,
                "resources": {
                    **asdict(resources),
                    "backend_retry_policy": {
                        "requested_retries": 0,
                        "effective_retries": 0,
                        "accounting": "observe_every_backend_attempt",
                    },
                },
            }
        )
        if optimizer_binding is not None:
            _read(root, optimizer_binding["observation_artifact"])
            optimizer_binding = verify_bound_optimizer_artifact(spec, optimizer_binding, root)
            receipt["optimizer_observation"] = copy.deepcopy(
                optimizer_binding["observation_artifact"]
            )
        contract = seal_execution_contract(spec, mode, optimizer_binding)
        request = build_worker_request(spec, contract)
        outputs["spec"] = _write(owned, "spec.json", _json(spec))
        outputs["execution_contract"] = _write(owned, "execution-contract.json", _json(contract))
        outputs["request"] = _write(owned, "worker-request.json", _json(request))
        verify_design_subject_for_spec(spec, root)
        receipt["isotope_derivation"] = {
            "kind": "derived_from_observed_element_defaults",
            "observed_source": data["references"]["isotope-defaults-observed.json"],
            "source_geometry_hash": old["geometry"]["geometry_hash"],
            "target_geometry_hash": geometry["geometry_hash"],
            "runtime_binding_hash": old["runtime_binding"]["binding_hash"],
            "used_elements": sorted({atom["element"] for atom in atoms}),
            "new_candidate_native_observation": False,
        }
        receipt["candidate_basis_functions"] = None
        receipt["candidate_runtime_preflight_required"] = True
        _read_observations(root, observations.observation_directory, observations.receipt_ref)
        _require(_read(root, original_ref) == original_raw, "original Design bytes changed")
        if optimizer_binding is not None:
            verify_bound_optimizer_artifact(spec, optimizer_binding, root)
        for reference in outputs.values():
            _read(root, reference)
        receipt["preparation_complete"] = True
        preparation_ref = _write(owned, "preparation.json", _json(receipt))
        return load_json(
            _json(
                {
                    "spec_ref": outputs["spec"],
                    "subject_ref": outputs["subject"],
                    "execution_contract_ref": outputs["execution_contract"],
                    "request_ref": outputs["request"],
                    "mode": mode,
                    "disk_budget": asdict(disk_budget),
                    "selection": selection,
                    "preparation_ref": preparation_ref,
                }
            )
        )
    except BaseException as error:
        receipt["preparation_complete"] = False
        receipt["error"] = {"type": type(error).__name__, "message": str(error)[:4096]}
        try:
            _write(owned, "preparation-failure.json", _json(receipt))
        except BaseException as retention_error:
            error.add_note("Preparation failure retention also failed: " + str(retention_error))
        raise
