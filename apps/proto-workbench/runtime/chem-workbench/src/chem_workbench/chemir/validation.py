"""Fail-closed validation for the compiler-emitted ChemIR alpha subset."""

from __future__ import annotations

from typing import Any

from chem_workbench.chemir.constraints import (
    COMPARISON_KINDS,
    CONDITION_PHASES,
    ELEMENT_SYMBOLS,
    LENGTH_UNIT,
    MAX_ADSORBATE_HEIGHT_ANGSTROM,
    MAX_COMPARISON_SUBJECTS,
    MAX_OBJECTS,
    MAX_PRESSURE_BAR,
    MAX_PROPERTIES,
    MAX_REFERENCE_ITEMS,
    MAX_REPRESENTATION_BYTES,
    MAX_SHORT_STRING_LENGTH,
    MAX_SLAB_LAYERS,
    MAX_SLAB_VACUUM_ANGSTROM,
    MAX_TEMPERATURE_KELVIN,
    MOLECULAR_FORMATS,
    PRESSURE_UNIT,
    STABILITY_KINDS,
    SUPPORTED_PROPERTIES,
    SUPPORTED_TASKS,
    SURFACE_METHOD_NAMES,
    SURFACE_PROFILE_ELEMENTS,
    SURFACE_SITE_LABELS,
    SURFACE_SLAB_CONSTRUCTIONS,
    SURFACE_SLAB_MILLER_INDICES,
    TEMPERATURE_UNIT,
    is_canonical_decimal,
    is_chemir_identifier,
    is_namespaced_extension,
    is_nfc,
    is_portable_relative_path,
    source_reference_digest,
)
from chem_workbench.chemir.profile import (
    CANONICALIZATION_ALGORITHM,
    CHEMIR_SCHEMA_VERSION,
    CONFORMANCE_PROFILE,
    NORMALIZATION_PROFILE,
)
from chem_workbench.chemir.schema_validation import SchemaValidationError, validate_chemir_schema

_TOP_LEVEL_FIELDS = {
    "schema_version",
    "profile",
    "canonicalization",
    "normalization_profile",
    "objects",
}
_ENVELOPE_FIELDS = {
    "schema_version",
    "id",
    "kind",
    "payload",
    "source_references",
    "provenance_references",
    "review_requirement_references",
    "extensions",
}
_SUPPORTED_PAYLOADS: dict[str, tuple[set[str], set[str]]] = {
    "Molecule": (
        {"representations", "normalization_policy", "ambiguities"},
        {"representations", "normalization_policy", "ambiguities"},
    ),
    "ElectronicState": (
        {"target_reference", "model", "charge", "multiplicity"},
        {"target_reference", "model", "charge", "multiplicity"},
    ),
    "PeriodicStructure": (
        {"semantics", "representations"},
        {"semantics", "representations", "lattice", "coordinate_system", "sites"},
    ),
    "SurfaceSlab": (
        {"parent_structure_reference", "construction"},
        {"parent_structure_reference", "construction"},
    ),
    "AdsorptionComplex": (
        {"slab_reference", "adsorbate_elements", "site", "height"},
        {"slab_reference", "adsorbate_elements", "site", "height"},
    ),
    "InterfaceReactionStep": (
        {"reactant_references", "product_references", "claim_scope"},
        {"reactant_references", "product_references", "claim_scope"},
    ),
    "ConditionSet": (
        {"phase"},
        {
            "phase",
            "target_reference",
            "temperature",
            "pressure",
            "solvent",
            "total_charge",
            "spin_multiplicity",
            "spin_polarized",
        },
    ),
    "ComparisonSpec": (
        {
            "kind",
            "stability_kind",
            "subject_references",
            "conditions_reference",
            "reference_state",
            "method",
        },
        {
            "kind",
            "stability_kind",
            "subject_references",
            "conditions_reference",
            "reference_state",
            "method",
        },
    ),
    "CalculationSpec": (
        {"target_reference", "task", "properties", "method", "conditions_reference"},
        {
            "target_reference",
            "electronic_state_reference",
            "conditions_reference",
            "task",
            "properties",
            "method",
            "basis",
        },
    ),
}


def validate_chemir_document(
    value: object,
    *,
    max_objects: int = MAX_OBJECTS,
    max_reference_items: int = MAX_REFERENCE_ITEMS,
    max_representation_bytes: int = MAX_REPRESENTATION_BYTES,
    max_short_string_length: int = MAX_SHORT_STRING_LENGTH,
    max_properties: int = MAX_PROPERTIES,
) -> dict[str, Any]:
    """Return a validated current-profile ChemIR document or raise ``ValueError``.

    JSON Schema validation is necessary but not sufficient here. This validator
    also closes the document to the object and payload shapes that the current
    compiler emits and that ``chem inspect`` knows how to reason about.
    """
    if not isinstance(value, dict):
        raise ValueError("ChemIR artifact must be a JSON object")
    try:
        validate_chemir_schema(value)
    except SchemaValidationError as error:
        raise ValueError(str(error)) from error

    extra = set(value) - _TOP_LEVEL_FIELDS
    missing = _TOP_LEVEL_FIELDS - set(value)
    if missing:
        raise ValueError(f"ChemIR artifact is missing fields: {', '.join(sorted(missing))}")
    if extra:
        raise ValueError(f"Unknown top-level ChemIR fields: {', '.join(sorted(extra))}")
    if value.get("schema_version") != CHEMIR_SCHEMA_VERSION:
        raise ValueError(f"Unsupported ChemIR schema version {value.get('schema_version')!r}")
    if value.get("profile") != CONFORMANCE_PROFILE:
        raise ValueError(f"Unsupported conformance profile {value.get('profile')!r}")
    if value.get("canonicalization") != CANONICALIZATION_ALGORITHM:
        raise ValueError(f"Unsupported canonicalization {value.get('canonicalization')!r}")
    if value.get("normalization_profile") != NORMALIZATION_PROFILE:
        raise ValueError(
            f"Unsupported normalization profile {value.get('normalization_profile')!r}"
        )

    objects = value.get("objects")
    if not isinstance(objects, list):
        raise ValueError("ChemIR objects must be an array")
    if not objects:
        raise ValueError("ChemIR must contain at least one object")
    if len(objects) > max_objects:
        raise ValueError(f"ChemIR objects exceed the alpha limit of {max_objects}")

    identifiers: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(objects):
        if not isinstance(item, dict):
            raise ValueError(f"ChemIR object {index} is not an object")
        item_extra = set(item) - _ENVELOPE_FIELDS
        item_missing = _ENVELOPE_FIELDS - set(item)
        if item_missing:
            raise ValueError(
                f"ChemIR object {index} is missing fields: {', '.join(sorted(item_missing))}"
            )
        if item_extra:
            raise ValueError(
                f"ChemIR object {index} has unknown fields: {', '.join(sorted(item_extra))}"
            )
        if item.get("schema_version") != CHEMIR_SCHEMA_VERSION:
            raise ValueError(f"ChemIR object {index} has an unsupported schema version")
        if not is_chemir_identifier(item.get("id")):
            raise ValueError(f"ChemIR object {index} has an invalid ChemIR id")
        identifier = item["id"]
        if identifier in identifiers:
            raise ValueError(f"ChemIR contains duplicate object id {identifier!r}")
        identifiers[identifier] = item

        kind = item.get("kind")
        if kind not in _SUPPORTED_PAYLOADS:
            raise ValueError(
                f"ChemIR object {index} kind {kind!r} is outside the inspectable alpha subset"
            )
        payload = item.get("payload")
        if not isinstance(payload, dict):
            raise ValueError(f"ChemIR object {index} payload must be an object")
        required_payload, allowed_payload = _SUPPORTED_PAYLOADS[kind]
        payload_missing = required_payload - set(payload)
        payload_extra = set(payload) - allowed_payload
        if payload_missing:
            raise ValueError(
                f"ChemIR object {index} payload is missing fields: "
                f"{', '.join(sorted(payload_missing))}"
            )
        if payload_extra:
            raise ValueError(
                f"ChemIR object {index} payload has unknown fields: "
                f"{', '.join(sorted(payload_extra))}"
            )
        _validate_current_payload(
            index,
            kind,
            payload,
            max_representation_bytes=max_representation_bytes,
            max_short_string_length=max_short_string_length,
            max_properties=max_properties,
        )
        _validate_envelope_references(
            index,
            item,
            max_reference_items=max_reference_items,
        )

        extensions = item.get("extensions")
        if not isinstance(extensions, dict):
            raise ValueError(f"ChemIR object {index} extensions must be an object")
        if len(extensions) > 128:
            raise ValueError(f"ChemIR object {index} has too many extensions")
        for extension_name in extensions:
            if not is_namespaced_extension(extension_name):
                raise ValueError(
                    f"ChemIR object {index} has non-namespaced extension {extension_name!r}"
                )

    _validate_reference_closure(identifiers)
    return value


def source_hashes(document: dict[str, Any]) -> list[str]:
    """Return the sorted unique source digests from an already validated document."""
    hashes: set[str] = set()
    for item in document["objects"]:
        references = item.get("source_references")
        if not isinstance(references, list):
            raise ValueError("ChemIR source references must be an array")
        for reference in references:
            digest = source_reference_digest(reference)
            if digest is None:
                raise ValueError(f"Malformed source content reference {reference!r}")
            hashes.add(f"sha256:{digest}")
    return sorted(hashes)


def _validate_envelope_references(
    index: int,
    item: dict[str, Any],
    *,
    max_reference_items: int,
) -> None:
    for reference_field in (
        "source_references",
        "provenance_references",
        "review_requirement_references",
    ):
        references = item.get(reference_field)
        if not isinstance(references, list) or not all(
            is_chemir_identifier(reference) for reference in references
        ):
            raise ValueError(
                f"ChemIR object {index} {reference_field} must be an array of references"
            )
        if len(references) > max_reference_items or len(set(references)) != len(references):
            raise ValueError(
                f"ChemIR object {index} {reference_field} exceeds limits or has duplicates"
            )
        if reference_field == "source_references" and any(
            source_reference_digest(reference) is None for reference in references
        ):
            raise ValueError(f"ChemIR object {index} has a malformed source content reference")
        if reference_field == "source_references" and not references:
            raise ValueError(f"ChemIR object {index} has no source content reference")
        if reference_field != "source_references" and references:
            raise ValueError(
                f"ChemIR object {index} {reference_field} is outside the inspectable alpha subset"
            )


def _validate_reference_closure(identifiers: dict[str, dict[str, Any]]) -> None:
    for identifier, item in identifiers.items():
        payload = item["payload"]
        kind = item["kind"]
        target = payload.get("target_reference")
        if kind in {"ElectronicState", "CalculationSpec"} and (
            not isinstance(target, str) or target not in identifiers
        ):
            raise ValueError(f"ChemIR object {identifier!r} has dangling target {target!r}")
        if kind == "ElectronicState" and identifiers[target]["kind"] != "Molecule":
            raise ValueError(
                f"Finite ElectronicState {identifier!r} must target an inspected Molecule"
            )
        if kind == "SurfaceSlab":
            parent = payload.get("parent_structure_reference")
            if not isinstance(parent, str) or parent not in identifiers:
                raise ValueError(f"SurfaceSlab {identifier!r} has dangling parent {parent!r}")
            if identifiers[parent]["kind"] != "PeriodicStructure":
                raise ValueError(f"SurfaceSlab {identifier!r} must derive from a PeriodicStructure")
        if kind == "AdsorptionComplex":
            slab = payload.get("slab_reference")
            if not isinstance(slab, str) or slab not in identifiers:
                raise ValueError(f"AdsorptionComplex {identifier!r} has dangling slab {slab!r}")
            if identifiers[slab]["kind"] != "SurfaceSlab":
                raise ValueError(f"AdsorptionComplex {identifier!r} must reference a SurfaceSlab")
        if kind == "InterfaceReactionStep":
            _validate_reaction_step_closure(identifier, payload, identifiers)
        if kind == "CalculationSpec" and identifiers[target]["kind"] not in {
            "Molecule",
            "PeriodicStructure",
            "SurfaceSlab",
            "AdsorptionComplex",
        }:
            raise ValueError(f"CalculationSpec {identifier!r} targets an unsupported object kind")
        state_reference = payload.get("electronic_state_reference")
        if state_reference is not None:
            state = identifiers.get(state_reference)
            if state is None or state["kind"] != "ElectronicState":
                raise ValueError(
                    f"CalculationSpec {identifier!r} has dangling electronic state "
                    f"{state_reference!r}"
                )
            if state["payload"]["target_reference"] != target:
                raise ValueError(
                    f"CalculationSpec {identifier!r} and its electronic state target differ"
                )
        if (
            kind == "CalculationSpec"
            and identifiers[target]["kind"] == "Molecule"
            and state_reference is None
        ):
            raise ValueError(f"Molecular CalculationSpec {identifier!r} lacks an electronic state")
        if (
            kind == "CalculationSpec"
            and identifiers[target]["kind"] in {"PeriodicStructure", "SurfaceSlab"}
            and state_reference is not None
        ):
            raise ValueError(
                f"Periodic CalculationSpec {identifier!r} cannot use a finite electronic state"
            )
        if kind == "CalculationSpec" and identifiers[target]["kind"] == "AdsorptionComplex":
            method = payload.get("method")
            if not isinstance(method, dict) or method.get("name") not in SURFACE_METHOD_NAMES:
                raise ValueError(
                    f"Adsorption-complex CalculationSpec {identifier!r} uses a method outside "
                    "the admitted surface profile"
                )
            adsorbate = identifiers[target]["payload"].get("adsorbate_elements")
            outside = (
                set(adsorbate) - SURFACE_PROFILE_ELEMENTS if isinstance(adsorbate, list) else None
            )
            if outside is None or outside:
                raise ValueError(
                    f"Adsorption-complex CalculationSpec {identifier!r} targets adsorbate "
                    "elements outside the copper-only surface profile"
                )
            if state_reference is not None:
                raise ValueError(
                    f"Adsorption-complex CalculationSpec {identifier!r} cannot use a finite "
                    "electronic state"
                )
        if kind == "ConditionSet":
            condition_target = payload.get("target_reference")
            if condition_target is not None and (
                not isinstance(condition_target, str) or condition_target not in identifiers
            ):
                raise ValueError(
                    f"ConditionSet {identifier!r} has dangling target {condition_target!r}"
                )
        if kind == "ComparisonSpec":
            _validate_comparison_closure(identifier, payload, identifiers)
        if kind == "CalculationSpec":
            conditions_reference = payload.get("conditions_reference")
            if not isinstance(conditions_reference, str) or conditions_reference not in identifiers:
                raise ValueError(
                    f"CalculationSpec {identifier!r} lacks a resolvable conditions reference"
                )
            condition = identifiers[conditions_reference]
            if condition["kind"] != "ConditionSet":
                raise ValueError(
                    f"CalculationSpec {identifier!r} references a non-conditions object"
                )
            _admit_conditions(
                f"CalculationSpec {identifier!r}",
                condition,
                identifiers[target]["kind"],
                target,
            )


def _is_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


_CONDITION_PHASES_BY_KIND = {
    "Molecule": "gas",
    "PeriodicStructure": "solid",
    "SurfaceSlab": "solid",
    "AdsorptionComplex": "gas_solid_interface",
}
_FORBIDDEN_CONDITION_FIELDS = (
    "pressure",
    "solvent",
    "total_charge",
    "spin_multiplicity",
    "spin_polarized",
)


def _admit_conditions(
    consumer: str,
    condition: dict[str, Any],
    target_kind: str,
    expected_target: str,
) -> None:
    """Artifact-level admission mirroring the RFC-0007 zero-kelvin profiles."""
    payload = condition["payload"]
    expected_phase = _CONDITION_PHASES_BY_KIND.get(target_kind, "solid")
    if payload.get("phase") != expected_phase:
        raise ValueError(
            f"{consumer} conditions phase {payload.get('phase')!r} is outside the "
            f"admitted profile ({expected_phase!r})"
        )
    temperature = payload.get("temperature")
    if not isinstance(temperature, dict) or temperature.get("value") != 0:
        raise ValueError(f"{consumer} lacks explicit zero-kelvin conditions")
    if temperature.get("unit") != TEMPERATURE_UNIT or set(temperature) != {"value", "unit"}:
        raise ValueError(f"{consumer} temperature conditions are malformed")
    for field in _FORBIDDEN_CONDITION_FIELDS:
        if field in payload:
            raise ValueError(
                f"{consumer} conditions declare {field!r}, which the admitted profile forbids"
            )
    if payload.get("target_reference") != expected_target:
        raise ValueError(
            f"{consumer} conditions target {payload.get('target_reference')!r} does not "
            f"match the subject {expected_target!r}"
        )


def _validate_comparison_closure(
    identifier: str,
    payload: dict[str, Any],
    identifiers: dict[str, dict[str, Any]],
) -> None:
    subjects = payload.get("subject_references")
    if not isinstance(subjects, list) or len(subjects) < 2:
        raise ValueError(f"ComparisonSpec {identifier!r} has invalid subjects")
    resolved: list[dict[str, Any]] = []
    for name in subjects:
        item = identifiers.get(name) if isinstance(name, str) else None
        if item is None:
            raise ValueError(f"ComparisonSpec {identifier!r} has dangling subjects")
        resolved.append(item)
    method = payload.get("method")
    if not isinstance(method, dict) or method.get("name") not in SURFACE_METHOD_NAMES:
        raise ValueError(f"ComparisonSpec {identifier!r} uses an unadmitted method")
    stability_kind = payload.get("stability_kind")
    condition_ref = payload.get("conditions_reference")
    condition = identifiers.get(condition_ref) if isinstance(condition_ref, str) else None
    if condition is None or condition["kind"] != "ConditionSet":
        raise ValueError(f"ComparisonSpec {identifier!r} has an unresolvable conditions reference")
    if stability_kind == "adsorption_site_preference":
        if any(item["kind"] != "AdsorptionComplex" for item in resolved):
            raise ValueError(f"ComparisonSpec {identifier!r} subjects are not adsorption complexes")
        slabs = {item["payload"].get("slab_reference") for item in resolved}
        if len(slabs) != 1 or not isinstance(next(iter(slabs)), str):
            raise ValueError(f"ComparisonSpec {identifier!r} compares sites across different slabs")
        _admit_conditions(
            f"ComparisonSpec {identifier!r}",
            condition,
            "AdsorptionComplex",
            next(iter(slabs)),
        )
    elif stability_kind == "energy_ordering_under_profile":
        if any(item["kind"] != "PeriodicStructure" for item in resolved):
            raise ValueError(f"ComparisonSpec {identifier!r} subjects are not crystals")
        if (
            payload.get("conditions_reference")
            and condition["payload"].get("target_reference") not in subjects
        ):
            raise ValueError(
                f"ComparisonSpec {identifier!r} conditions target is not one of the subjects"
            )
        _admit_conditions(
            f"ComparisonSpec {identifier!r}",
            condition,
            "PeriodicStructure",
            condition["payload"]["target_reference"],
        )
    else:
        raise ValueError(f"ComparisonSpec {identifier!r} has an unsupported stability kind")


def _validate_reaction_step_closure(
    identifier: str,
    payload: dict[str, Any],
    identifiers: dict[str, dict[str, Any]],
) -> None:
    slabs: set[object] = set()
    for role in ("reactant_references", "product_references"):
        references = payload.get(role)
        if not isinstance(references, list) or not references:
            raise ValueError(f"InterfaceReactionStep {identifier!r} has invalid {role}")
        for reference in references:
            referenced = identifiers.get(reference) if isinstance(reference, str) else None
            if referenced is None:
                raise ValueError(
                    f"InterfaceReactionStep {identifier!r} has dangling reference {reference!r}"
                )
            if referenced["kind"] != "AdsorptionComplex":
                raise ValueError(
                    f"InterfaceReactionStep {identifier!r} binds {reference!r}, "
                    "which is not an AdsorptionComplex"
                )
            slabs.add(referenced["payload"].get("slab_reference"))
    if set(payload.get("reactant_references", [])) & set(payload.get("product_references", [])):
        raise ValueError(
            f"InterfaceReactionStep {identifier!r} consumes and produces the same subject"
        )
    if len(slabs) > 1:
        raise ValueError(
            f"InterfaceReactionStep {identifier!r} mixes endpoints from different slabs; "
            "cross-slab energy differences are incomparable in this profile"
        )


def _validate_current_payload(
    index: int,
    kind: str,
    payload: dict[str, Any],
    *,
    max_representation_bytes: int,
    max_short_string_length: int,
    max_properties: int,
) -> None:
    if kind == "Molecule":
        representations = payload["representations"]
        if not isinstance(representations, list) or not representations:
            raise ValueError(f"ChemIR object {index} needs at least one representation")
        for representation in representations:
            if not isinstance(representation, dict):
                raise ValueError(f"ChemIR object {index} has an invalid representation")
            if set(representation) != {"format", "role", "value"}:
                raise ValueError(
                    f"ChemIR object {index} has unsupported molecular representation fields"
                )
            if representation["format"] not in MOLECULAR_FORMATS:
                raise ValueError(f"ChemIR object {index} has an unsupported molecular format")
            representation_value = representation["value"]
            if (
                representation["role"] != "original"
                or not isinstance(representation_value, str)
                or not representation_value
                or len(representation_value.encode("utf-8")) > max_representation_bytes
            ):
                raise ValueError(f"ChemIR object {index} has an invalid representation")
        policy = payload.get("normalization_policy")
        if policy != {"name": "source-preserving", "version": "v1alpha1"}:
            raise ValueError(f"ChemIR object {index} has an invalid normalization policy")
        if payload.get("ambiguities") != []:
            raise ValueError(
                f"ChemIR object {index} ambiguities are outside the compiler-emitted subset"
            )
    elif kind == "ElectronicState":
        if payload["model"] != "finite":
            raise ValueError(f"ChemIR object {index} is outside the finite-state alpha subset")
        if not isinstance(payload["target_reference"], str):
            raise ValueError(f"ChemIR object {index} target must be a reference")
        charge = payload["charge"]
        multiplicity = payload["multiplicity"]
        if not isinstance(charge, int) or isinstance(charge, bool):
            raise ValueError(f"ChemIR object {index} charge must be an integer")
        if not -128 <= charge <= 128:
            raise ValueError(f"ChemIR object {index} charge is outside schema bounds")
        if (
            not isinstance(multiplicity, int)
            or isinstance(multiplicity, bool)
            or not 1 <= multiplicity <= 128
        ):
            raise ValueError(f"ChemIR object {index} multiplicity must be positive")
    elif kind == "PeriodicStructure":
        if payload["semantics"] != "explicit_configuration":
            raise ValueError(f"ChemIR object {index} is not an explicit configuration")
        representations = payload["representations"]
        if not isinstance(representations, list) or not representations:
            raise ValueError(f"ChemIR object {index} needs a CIF representation")
        for representation in representations:
            if not isinstance(representation, dict) or representation.get("format") != "cif":
                raise ValueError(f"ChemIR object {index} has an invalid CIF reference")
            if set(representation) == {"format", "role", "path"}:
                if representation.get("role") != "original" or not is_portable_relative_path(
                    representation.get("path")
                ):
                    raise ValueError(f"ChemIR object {index} has an invalid CIF reference")
            elif set(representation) == {"format", "role", "value"}:
                value = representation.get("value")
                if (
                    representation.get("role") != "original"
                    or not isinstance(value, str)
                    or not value
                    or len(value.encode("utf-8")) > max_representation_bytes
                ):
                    raise ValueError(f"ChemIR object {index} has an invalid CIF representation")
            else:
                raise ValueError(f"ChemIR object {index} has unsupported representation fields")
        geometry_fields = {"lattice", "coordinate_system", "sites"} & set(payload)
        if geometry_fields and geometry_fields != {"lattice", "coordinate_system", "sites"}:
            raise ValueError(
                f"ChemIR object {index} has partial geometry fields; lattice, "
                "coordinate_system, and sites must appear together"
            )
        if geometry_fields:
            if payload["coordinate_system"] != "fractional":
                raise ValueError(f"ChemIR object {index} is outside the fractional imported subset")
            lattice = payload["lattice"]
            if not isinstance(lattice, dict) or set(lattice) != {
                "vectors",
                "unit",
                "periodic_boundary_conditions",
            }:
                raise ValueError(f"ChemIR object {index} has an invalid lattice")
            vectors = lattice["vectors"]
            if (
                not isinstance(vectors, list)
                or len(vectors) != 3
                or not all(
                    isinstance(row, list)
                    and len(row) == 3
                    and all(is_canonical_decimal(item) for item in row)
                    for row in vectors
                )
            ):
                raise ValueError(f"ChemIR object {index} has non-canonical lattice vectors")
            if lattice["unit"] != "angstrom" or lattice["periodic_boundary_conditions"] != [
                True,
                True,
                True,
            ]:
                raise ValueError(f"ChemIR object {index} has unsupported lattice boundary fields")
            sites = payload["sites"]
            if not isinstance(sites, list) or not sites or len(sites) > MAX_OBJECTS:
                raise ValueError(f"ChemIR object {index} has invalid sites")
            for site in sites:
                if (
                    not isinstance(site, dict)
                    or not {"id", "element", "coordinates", "occupancy"} <= set(site)
                    or set(site) - {"id", "element", "coordinates", "occupancy", "label"}
                ):
                    raise ValueError(f"ChemIR object {index} has an invalid site")
                label = site.get("label")
                if label is not None and (
                    not isinstance(label, str)
                    or not label
                    or len(label) > max_short_string_length
                    or not is_nfc(label)
                ):
                    raise ValueError(f"ChemIR object {index} has an invalid site label")
                coordinates = site["coordinates"]
                if (
                    not is_chemir_identifier(site["id"])
                    or site["element"] not in ELEMENT_SYMBOLS
                    or not isinstance(coordinates, list)
                    or len(coordinates) != 3
                    or not all(is_canonical_decimal(item) for item in coordinates)
                    or site["occupancy"] != 1
                ):
                    raise ValueError(f"ChemIR object {index} has an invalid site")
    elif kind == "CalculationSpec":
        if not isinstance(payload["target_reference"], str):
            raise ValueError(f"ChemIR object {index} target must be a reference")
        if payload["task"] not in SUPPORTED_TASKS:
            raise ValueError(f"ChemIR object {index} has an unsupported task")
        properties = payload["properties"]
        if (
            not isinstance(properties, list)
            or not properties
            or not all(isinstance(value, str) for value in properties)
        ):
            raise ValueError(f"ChemIR object {index} has invalid properties")
        if (
            len(properties) > max_properties
            or len(set(properties)) != len(properties)
            or set(properties) - SUPPORTED_PROPERTIES
        ):
            raise ValueError(f"ChemIR object {index} properties violate schema constraints")
        for identity_name in ("method", "basis"):
            identity = payload.get(identity_name)
            if identity is not None and (
                not isinstance(identity, dict)
                or set(identity) != {"name"}
                or not isinstance(identity.get("name"), str)
                or not identity["name"]
                or len(identity["name"]) > max_short_string_length
                or not is_nfc(identity["name"])
            ):
                raise ValueError(f"ChemIR object {index} has invalid {identity_name} identity")
    elif kind == "SurfaceSlab":
        construction = payload["construction"]
        if not isinstance(construction, dict):
            raise ValueError(f"ChemIR object {index} construction must be an object")
        if construction.get("algorithm") not in SURFACE_SLAB_CONSTRUCTIONS:
            raise ValueError(f"ChemIR object {index} has an unadmitted slab construction")
        if construction.get("algorithm_version") != "v1alpha1":
            raise ValueError(f"ChemIR object {index} has an unsupported construction version")
        if not isinstance(payload["parent_structure_reference"], str):
            raise ValueError(f"ChemIR object {index} parent must be a reference")
        miller = construction.get("miller")
        if (
            not isinstance(miller, list)
            or len(miller) != 3
            or not all(_is_integer(item) and -9 <= item <= 9 for item in miller)
            or tuple(miller) not in SURFACE_SLAB_MILLER_INDICES
        ):
            raise ValueError(f"ChemIR object {index} has Miller indices outside the surface alpha")
        termination = construction.get("termination")
        if (
            not isinstance(termination, str)
            or not termination
            or len(termination) > max_short_string_length
            or not is_nfc(termination)
        ):
            raise ValueError(f"ChemIR object {index} has an invalid termination label")
        layers = construction.get("layers")
        if (
            not isinstance(layers, int)
            or isinstance(layers, bool)
            or not 1 <= layers <= MAX_SLAB_LAYERS
        ):
            raise ValueError(f"ChemIR object {index} has a slab layer count outside alpha bounds")
        vacuum = construction.get("vacuum")
        if (
            not isinstance(vacuum, dict)
            or set(vacuum) != {"value", "unit"}
            or not _is_integer(vacuum.get("value"))
            or not 1 <= vacuum["value"] <= MAX_SLAB_VACUUM_ANGSTROM
            or vacuum.get("unit") != LENGTH_UNIT
        ):
            raise ValueError(f"ChemIR object {index} has an invalid vacuum extent")
    elif kind == "AdsorptionComplex":
        if not isinstance(payload["slab_reference"], str):
            raise ValueError(f"ChemIR object {index} slab reference must be a reference")
        adsorbate = payload["adsorbate_elements"]
        if (
            not isinstance(adsorbate, list)
            or not adsorbate
            or not all(isinstance(item, str) for item in adsorbate)
            or len(set(adsorbate)) != len(adsorbate)
            or set(adsorbate) - ELEMENT_SYMBOLS
        ):
            raise ValueError(f"ChemIR object {index} has invalid adsorbate elements")
        if payload["site"] not in SURFACE_SITE_LABELS:
            raise ValueError(f"ChemIR object {index} has an unsupported adsorption site")
        height = payload["height"]
        if (
            not isinstance(height, dict)
            or set(height) != {"value", "unit"}
            or not _is_integer(height.get("value"))
            or not 1 <= height["value"] <= MAX_ADSORBATE_HEIGHT_ANGSTROM
            or height.get("unit") != LENGTH_UNIT
        ):
            raise ValueError(f"ChemIR object {index} has an invalid adsorbate height")
    elif kind == "InterfaceReactionStep":
        for role in ("reactant_references", "product_references"):
            references = payload[role]
            if (
                not isinstance(references, list)
                or not references
                or not all(isinstance(item, str) for item in references)
                or len(set(references)) != len(references)
            ):
                raise ValueError(f"ChemIR object {index} has invalid {role}")
        if payload["claim_scope"] != "computed_energy_difference_only":
            raise ValueError(
                f"ChemIR object {index} claims a scope outside computed energy differences"
            )
    elif kind == "ConditionSet":
        if payload["phase"] not in CONDITION_PHASES:
            raise ValueError(f"ChemIR object {index} has an undeclared phase")
        condition_target = payload.get("target_reference")
        if condition_target is not None and not isinstance(condition_target, str):
            raise ValueError(f"ChemIR object {index} target must be a reference")
        temperature = payload.get("temperature")
        if temperature is not None and (
            not isinstance(temperature, dict)
            or set(temperature) != {"value", "unit"}
            or not _is_integer(temperature.get("value"))
            or not 0 <= temperature["value"] <= MAX_TEMPERATURE_KELVIN
            or temperature.get("unit") != TEMPERATURE_UNIT
        ):
            raise ValueError(f"ChemIR object {index} has invalid temperature conditions")
        pressure = payload.get("pressure")
        if pressure is not None and (
            not isinstance(pressure, dict)
            or set(pressure) != {"value", "unit"}
            or not _is_integer(pressure.get("value"))
            or not 0 <= pressure["value"] <= MAX_PRESSURE_BAR
            or pressure.get("unit") != PRESSURE_UNIT
        ):
            raise ValueError(f"ChemIR object {index} has invalid pressure conditions")
        solvent = payload.get("solvent")
        if solvent is not None and (
            not isinstance(solvent, str)
            or not solvent
            or len(solvent) > max_short_string_length
            or not is_nfc(solvent)
        ):
            raise ValueError(f"ChemIR object {index} has an invalid solvent")
        total_charge = payload.get("total_charge")
        if total_charge is not None and (
            not _is_integer(total_charge) or not -128 <= total_charge <= 128
        ):
            raise ValueError(f"ChemIR object {index} has an invalid total charge")
        spin_multiplicity = payload.get("spin_multiplicity")
        if spin_multiplicity is not None and (
            not _is_integer(spin_multiplicity) or not 1 <= spin_multiplicity <= 128
        ):
            raise ValueError(f"ChemIR object {index} has an invalid spin multiplicity")
        spin_polarized = payload.get("spin_polarized")
        if spin_polarized is not None and not isinstance(spin_polarized, bool):
            raise ValueError(f"ChemIR object {index} has an invalid spin polarization")
    elif kind == "ComparisonSpec":
        if payload["kind"] not in COMPARISON_KINDS:
            raise ValueError(f"ChemIR object {index} has an unsupported comparison kind")
        if payload["stability_kind"] not in STABILITY_KINDS:
            raise ValueError(f"ChemIR object {index} has an unsupported stability kind")
        subjects = payload["subject_references"]
        if (
            not isinstance(subjects, list)
            or not 2 <= len(subjects) <= MAX_COMPARISON_SUBJECTS
            or not all(isinstance(item, str) for item in subjects)
            or len(set(subjects)) != len(subjects)
        ):
            raise ValueError(f"ChemIR object {index} has invalid comparison subjects")
        if not isinstance(payload["conditions_reference"], str):
            raise ValueError(f"ChemIR object {index} conditions must be a reference")
        reference_state = payload["reference_state"]
        if (
            not isinstance(reference_state, str)
            or not reference_state
            or len(reference_state) > max_short_string_length
            or not is_nfc(reference_state)
        ):
            raise ValueError(f"ChemIR object {index} has an invalid reference state")
        method = payload["method"]
        if (
            not isinstance(method, dict)
            or set(method) != {"name"}
            or not isinstance(method.get("name"), str)
            or not method["name"]
        ):
            raise ValueError(f"ChemIR object {index} has an invalid comparison method")
