"""Deterministic alpha validators that do not infer unsupported chemistry."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from chem_workbench.chemir.constraints import (
    COMPARISON_KINDS,
    CONDITION_PHASES,
    ELEMENT_SYMBOLS,
    LENGTH_UNIT,
    MAX_ADSORBATE_ELEMENTS,
    MAX_ADSORBATE_HEIGHT_ANGSTROM,
    MAX_COMPARISON_SUBJECTS,
    MAX_OBJECTS,
    MAX_PRESSURE_BAR,
    MAX_PROPERTIES,
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
    is_chemir_identifier,
    is_nfc,
    is_portable_relative_path,
)
from chem_workbench.diagnostics import Diagnostic, Severity, SourceLocation
from chem_workbench.parser import Declaration

SUPPORTED_FIELDS: dict[str, frozenset[str]] = {
    "molecule": frozenset({"structure"}),
    "electronic_state": frozenset({"target", "model", "charge", "multiplicity"}),
    "crystal": frozenset({"structure", "semantics"}),
    "calculation": frozenset(
        {"target", "state", "conditions", "task", "properties", "method", "basis"}
    ),
    "conditions": frozenset(
        {
            "target",
            "phase",
            "temperature",
            "temperature_unit",
            "pressure",
            "pressure_unit",
            "solvent",
            "total_charge",
            "spin_multiplicity",
            "spin_polarized",
        }
    ),
    "comparison": frozenset(
        {"kind", "stability_kind", "subjects", "conditions", "reference_state", "method"}
    ),
    "surface_slab": frozenset(
        {"parent", "construction", "miller", "termination", "layers", "vacuum", "vacuum_unit"}
    ),
    "adsorption_complex": frozenset({"slab", "adsorbate", "site", "height", "height_unit"}),
    "interface_reaction_step": frozenset({"reactants", "products"}),
}


@dataclass(frozen=True, slots=True)
class ValidationResult:
    diagnostics: tuple[Diagnostic, ...]
    symbols: dict[str, Declaration]


def _location(declaration: Declaration, field: str | None = None) -> SourceLocation:
    span = declaration.field_spans.get(field) if field is not None else declaration.span
    assert span is not None
    return SourceLocation(span.file, span.line, span.column, span.end_line, span.end_column)


def _diagnostic(
    declaration: Declaration,
    severity: Severity,
    code: str,
    message: str,
    suggestion: str,
    field: str | None = None,
    chemir_path: str | None = None,
) -> Diagnostic:
    return Diagnostic(
        severity,
        code,
        message,
        _location(declaration, field),
        suggestion,
        chemir_path,
    )


def _require_fields(
    declaration: Declaration,
    names: tuple[str, ...],
    diagnostics: list[Diagnostic],
) -> None:
    for name in names:
        if name not in declaration.fields:
            diagnostics.append(
                _diagnostic(
                    declaration,
                    Severity.ERROR,
                    "CHM2002",
                    f"{declaration.kind} {declaration.identifier!r} requires field {name!r}.",
                    f"Add a {name!r} field to the declaration.",
                    chemir_path=f"/objects/{declaration.identifier}/payload/{name}",
                )
            )


def validate_declarations(
    declarations: tuple[Declaration, ...],
    *,
    resolved_crystals: frozenset[str] = frozenset(),
) -> ValidationResult:
    diagnostics: list[Diagnostic] = []
    symbols: dict[str, Declaration] = {}
    if len(declarations) > MAX_OBJECTS:
        location = _location(declarations[MAX_OBJECTS])
        diagnostics.append(
            Diagnostic(
                Severity.ERROR,
                "CHM2006",
                f"Document exceeds the alpha limit of {MAX_OBJECTS} objects.",
                location,
                "Split the source into bounded documents.",
            )
        )
    for declaration in declarations:
        if not is_chemir_identifier(declaration.identifier):
            diagnostics.append(
                _diagnostic(
                    declaration,
                    Severity.ERROR,
                    "CHM2007",
                    f"Object identifier {declaration.identifier!r} is not ChemIR-compatible.",
                    "Start with an ASCII letter or digit and use at most 256 safe characters.",
                )
            )
        if declaration.identifier in symbols:
            diagnostics.append(
                _diagnostic(
                    declaration,
                    Severity.ERROR,
                    "CHM2003",
                    f"Duplicate object identifier {declaration.identifier!r}.",
                    "Rename one declaration; identifiers are document-wide and immutable.",
                )
            )
        else:
            symbols[declaration.identifier] = declaration

        supported = SUPPORTED_FIELDS.get(declaration.kind)
        if supported is None:
            diagnostics.append(
                _diagnostic(
                    declaration,
                    Severity.ERROR,
                    "CHM2001",
                    f"Declaration kind {declaration.kind!r} is outside the "
                    "implemented alpha profile.",
                    "Use molecule, electronic_state, crystal, calculation, surface_slab, "
                    "adsorption_complex, or interface_reaction_step, "
                    "or wait for its profile.",
                )
            )
            continue
        for field in declaration.fields:
            if field not in supported:
                diagnostics.append(
                    _diagnostic(
                        declaration,
                        Severity.ERROR,
                        "CHM2004",
                        f"Field {field!r} is not defined for alpha {declaration.kind} objects.",
                        "Remove the field or use a future namespaced extension after "
                        "it is defined.",
                        field,
                    )
                )

    for declaration in declarations:
        if declaration.kind == "molecule":
            _validate_molecule(declaration, diagnostics)
        elif declaration.kind == "electronic_state":
            _validate_electronic_state(declaration, symbols, diagnostics)
        elif declaration.kind == "crystal":
            _validate_crystal(declaration, diagnostics, resolved_crystals)
        elif declaration.kind == "calculation":
            _validate_calculation(declaration, symbols, diagnostics)
        elif declaration.kind == "surface_slab":
            _validate_surface_slab(declaration, symbols, diagnostics)
        elif declaration.kind == "adsorption_complex":
            _validate_adsorption_complex(declaration, symbols, diagnostics)
        elif declaration.kind == "interface_reaction_step":
            _validate_interface_reaction_step(declaration, symbols, diagnostics)
        elif declaration.kind == "conditions":
            _validate_conditions(declaration, symbols, diagnostics)
        elif declaration.kind == "comparison":
            _validate_comparison(declaration, symbols, diagnostics)

    if not declarations:
        diagnostics.append(
            Diagnostic(
                Severity.ERROR,
                "CHM2005",
                "The document contains no chemical objects.",
                SourceLocation("<document>", 1, 1),
                "Add at least one declaration before compiling useful ChemIR.",
            )
        )
    return ValidationResult(tuple(diagnostics), symbols)


def _validate_molecule(declaration: Declaration, diagnostics: list[Diagnostic]) -> None:
    _require_fields(declaration, ("structure",), diagnostics)
    structure = declaration.fields.get("structure")
    if not isinstance(structure, dict):
        return
    format_name = structure.get("format")
    value = structure.get("value")
    if format_name not in MOLECULAR_FORMATS:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2101",
                f"Molecular format {format_name!r} is not in the alpha source profile.",
                "Use smiles, inchi, or sdf.",
                "structure",
            )
        )
    if not isinstance(value, str) or not value.strip():
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2102",
                "The molecular representation is empty.",
                "Provide a non-empty representation.",
                "structure",
            )
        )
    elif len(value.encode("utf-8")) > MAX_REPRESENTATION_BYTES:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2104",
                "The molecular representation exceeds the alpha size limit.",
                "Use an input smaller than 16 MiB.",
                "structure",
            )
        )
    else:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.REVIEW_REQUIRED,
                "CHM2103",
                "The representation is preserved but has not been chemistry-parsed in this alpha.",
                "Activate a versioned format adapter before asserting structure consistency.",
                "structure",
            )
        )


def _validate_electronic_state(
    declaration: Declaration,
    symbols: dict[str, Declaration],
    diagnostics: list[Diagnostic],
) -> None:
    _require_fields(declaration, ("target", "model", "charge", "multiplicity"), diagnostics)
    target = declaration.fields.get("target")
    if not isinstance(target, str) or target not in symbols:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2201",
                f"Electronic-state target {target!r} does not resolve.",
                "Reference a declared finite chemical entity.",
                "target" if "target" in declaration.fields else None,
            )
        )
    elif symbols[target].kind not in {"molecule", "coordination_complex"}:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2202",
                "A finite electronic state must target a finite entity.",
                "Use a molecule or a supported coordination complex.",
                "target",
            )
        )
    charge = declaration.fields.get("charge")
    multiplicity = declaration.fields.get("multiplicity")
    if not isinstance(charge, int) or isinstance(charge, bool):
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2203",
                "Finite charge must be an integer.",
                "Use an integer formal charge.",
                "charge" if "charge" in declaration.fields else None,
            )
        )
    elif not -128 <= charge <= 128:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2205",
                "Finite charge is outside the v1alpha1 schema bounds.",
                "Use an integer charge between -128 and 128.",
                "charge",
            )
        )
    if (
        not isinstance(multiplicity, int)
        or isinstance(multiplicity, bool)
        or not 1 <= multiplicity <= 128
    ):
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2204",
                "Finite multiplicity must be a positive integer.",
                "Use 1 for a singlet, 2 for a doublet, and so on.",
                "multiplicity" if "multiplicity" in declaration.fields else None,
            )
        )


def _validate_crystal(
    declaration: Declaration,
    diagnostics: list[Diagnostic],
    resolved_crystals: frozenset[str] = frozenset(),
) -> None:
    _require_fields(declaration, ("structure", "semantics"), diagnostics)
    structure = declaration.fields.get("structure")
    if isinstance(structure, dict) and structure.get("format") != "cif":
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2301",
                "The alpha crystal source profile accepts CIF references only.",
                "Use 'structure cif <path>'.",
                "structure",
            )
        )
    if isinstance(structure, dict):
        path_value = structure.get("value")
        if not isinstance(path_value, str) or not path_value:
            diagnostics.append(
                _diagnostic(
                    declaration,
                    Severity.ERROR,
                    "CHM2304",
                    "The CIF reference must be a non-empty relative path.",
                    "Use a path relative to the .chem source file.",
                    "structure",
                )
            )
        elif not is_portable_relative_path(path_value):
            diagnostics.append(
                _diagnostic(
                    declaration,
                    Severity.ERROR,
                    "CHM2305",
                    "The CIF reference escapes the portable source boundary.",
                    "Use a relative path without parent-directory traversal.",
                    "structure",
                )
            )
    if declaration.fields.get("semantics") != "explicit_configuration":
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2302",
                "Core alpha compilation accepts explicit configurations only.",
                "Use explicit_configuration or a future experimental disorder profile.",
                "semantics" if "semantics" in declaration.fields else None,
            )
        )
    if declaration.identifier not in resolved_crystals:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.REVIEW_REQUIRED,
                "CHM2303",
                "The CIF reference has not been imported into explicit lattice and site data.",
                "Run the versioned CIF import (chem convert or --resolve-imports) "
                "before asserting structure consistency.",
                "structure" if "structure" in declaration.fields else None,
            )
        )


def _validate_calculation(
    declaration: Declaration,
    symbols: dict[str, Declaration],
    diagnostics: list[Diagnostic],
) -> None:
    _require_fields(declaration, ("target", "task", "properties", "method"), diagnostics)
    target_name = declaration.fields.get("target")
    target = symbols.get(target_name) if isinstance(target_name, str) else None
    if target is None:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2401",
                f"Calculation target {target_name!r} does not resolve.",
                "Reference a declared molecule, coordination complex, or crystal.",
                "target" if "target" in declaration.fields else None,
            )
        )
    elif target.kind not in {"molecule", "crystal", "surface_slab", "adsorption_complex"}:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2407",
                f"Calculation target {target.identifier!r} has unsupported kind {target.kind!r}.",
                "Reference a molecule, an explicit crystal, a surface slab, "
                "or an adsorption complex in this alpha.",
                "target",
            )
        )
    elif target.kind == "molecule" and "state" not in declaration.fields:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2402",
                "A molecular calculation requires an explicit finite electronic state.",
                "Add a state field referencing an electronic_state declaration.",
            )
        )
    elif target.kind in {"surface_slab", "adsorption_complex"} and "state" in declaration.fields:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2530",
                "A classical surface calculation cannot use a finite electronic state.",
                "Remove the state field; quantum electronic-state profiles for "
                "periodic systems are outside this alpha.",
                "state",
            )
        )
    elif target.kind == "adsorption_complex":
        method = declaration.fields.get("method")
        if method not in SURFACE_METHOD_NAMES:
            diagnostics.append(
                _diagnostic(
                    declaration,
                    Severity.ERROR,
                    "CHM2531",
                    f"Method {method!r} is not admitted for adsorption-complex targets.",
                    "The surface alpha admits the classical 'emt' method profile only.",
                    "method" if "method" in declaration.fields else None,
                )
            )
        adsorbate = target.fields.get("adsorbate")
        outside = (
            {item for item in adsorbate if isinstance(item, str)} - SURFACE_PROFILE_ELEMENTS
            if isinstance(adsorbate, list)
            else set()
        )
        if outside:
            diagnostics.append(
                _diagnostic(
                    declaration,
                    Severity.ERROR,
                    "CHM2532",
                    "Adsorbate elements "
                    f"{', '.join(sorted(outside))} are outside the admitted "
                    "copper-only surface profile.",
                    "The alpha surface profile admits copper adsorbates only; "
                    "EMT's cautioned extended element set is not a workbench profile.",
                    "target",
                )
            )
    if target is not None:
        _validate_calculation_conditions(declaration, target, symbols, diagnostics)
    state_name = declaration.fields.get("state")
    if state_name is not None:
        state = symbols.get(state_name) if isinstance(state_name, str) else None
        if state is None or state.kind != "electronic_state":
            diagnostics.append(
                _diagnostic(
                    declaration,
                    Severity.ERROR,
                    "CHM2403",
                    f"Calculation state {state_name!r} does not resolve to an electronic state.",
                    "Reference an electronic_state declaration.",
                    "state",
                )
            )
        elif target is not None and state.fields.get("target") != target.identifier:
            diagnostics.append(
                _diagnostic(
                    declaration,
                    Severity.ERROR,
                    "CHM2404",
                    "The electronic state targets a different entity than the calculation.",
                    "Use a state whose target matches the calculation target.",
                    "state",
                )
            )
    properties = declaration.fields.get("properties")
    if (
        not isinstance(properties, list)
        or not properties
        or not all(isinstance(item, str) for item in properties)
    ):
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2405",
                "Calculation properties must be a non-empty list of names.",
                "Use a list such as [energy].",
                "properties" if "properties" in declaration.fields else None,
            )
        )
    elif len(set(properties)) != len(properties):
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2408",
                "Calculation properties must be unique.",
                "Remove duplicate property names.",
                "properties",
            )
        )
    elif len(properties) > MAX_PROPERTIES:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2412",
                "Calculation properties exceed the alpha item limit.",
                "Request no more than 64 unique properties.",
                "properties",
            )
        )
    elif unknown_properties := set(properties) - SUPPORTED_PROPERTIES:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2409",
                f"Unsupported calculation properties: {', '.join(sorted(unknown_properties))}.",
                "Use properties defined by the v1alpha1 CalculationSpec schema.",
                "properties",
            )
        )
    task = declaration.fields.get("task")
    if not isinstance(task, str) or task not in SUPPORTED_TASKS:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2410",
                f"Unsupported calculation task {task!r}.",
                "Use a task defined by the v1alpha1 CalculationSpec schema.",
                "task" if "task" in declaration.fields else None,
            )
        )
    for identity_field in ("method", "basis"):
        if identity_field in declaration.fields and (
            not isinstance(declaration.fields[identity_field], str)
            or not declaration.fields[identity_field]
            or len(declaration.fields[identity_field]) > MAX_SHORT_STRING_LENGTH
            or not is_nfc(declaration.fields[identity_field])
        ):
            diagnostics.append(
                _diagnostic(
                    declaration,
                    Severity.ERROR,
                    "CHM2411",
                    f"Calculation {identity_field} must be a non-empty registry name.",
                    f"Use a quoted or bare name for {identity_field}.",
                    identity_field,
                )
            )
    if declaration.fields.get("method") == "hf" and "basis" not in declaration.fields:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2406",
                "The HF method requires an explicit basis identity.",
                "Add a basis field; execution resolution will bind its exact version and digest.",
            )
        )


def _is_bounded_integer(value: object, minimum: int, maximum: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= maximum


def _validate_surface_slab(
    declaration: Declaration,
    symbols: dict[str, Declaration],
    diagnostics: list[Diagnostic],
) -> None:
    _require_fields(
        declaration,
        ("parent", "construction", "miller", "termination", "layers", "vacuum", "vacuum_unit"),
        diagnostics,
    )
    parent = declaration.fields.get("parent")
    parent_declaration = symbols.get(parent) if isinstance(parent, str) else None
    if parent_declaration is None:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2501",
                f"Surface-slab parent {parent!r} does not resolve.",
                "Reference a declared crystal declaration.",
                "parent" if "parent" in declaration.fields else None,
            )
        )
    elif parent_declaration.kind != "crystal":
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2502",
                "A surface slab must be derived from an explicit periodic structure.",
                "Reference a crystal declaration as the parent.",
                "parent",
            )
        )
    construction = declaration.fields.get("construction")
    if construction not in SURFACE_SLAB_CONSTRUCTIONS:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2503",
                f"Slab construction {construction!r} is outside the admitted surface alpha.",
                "The alpha admits the 'fcc-cubic-cell-cut' construction only.",
                "construction" if "construction" in declaration.fields else None,
            )
        )
    miller = declaration.fields.get("miller")
    if (
        not isinstance(miller, list)
        or len(miller) != 3
        or not all(_is_bounded_integer(item, -9, 9) for item in miller)
    ):
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2504",
                "Miller indices must be a list of three integers.",
                "Use a bounded triple such as [1, 1, 1].",
                "miller" if "miller" in declaration.fields else None,
            )
        )
    elif tuple(miller) not in SURFACE_SLAB_MILLER_INDICES:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2505",
                f"Miller indices {miller!r} are outside the admitted surface alpha.",
                "The fcc-cubic-cell-cut construction is defined for [1, 1, 1] only.",
                "miller",
            )
        )
    termination = declaration.fields.get("termination")
    if (
        not isinstance(termination, str)
        or not termination
        or len(termination) > MAX_SHORT_STRING_LENGTH
        or not is_nfc(termination)
    ):
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2506",
                "Slab termination must be a non-empty short string.",
                'Name the termination explicitly, for example "cu-111-a".',
                "termination" if "termination" in declaration.fields else None,
            )
        )
    layers = declaration.fields.get("layers")
    if not _is_bounded_integer(layers, 1, MAX_SLAB_LAYERS):
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2507",
                f"Slab layer count must be an integer from 1 to {MAX_SLAB_LAYERS}.",
                "Layer thickness is a declared slab parameter, not an inferred default.",
                "layers" if "layers" in declaration.fields else None,
            )
        )
    vacuum = declaration.fields.get("vacuum")
    if not _is_bounded_integer(vacuum, 1, MAX_SLAB_VACUUM_ANGSTROM):
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2508",
                "Slab vacuum extent must be an integer of whole angstroms "
                f"from 1 to {MAX_SLAB_VACUUM_ANGSTROM}.",
                "Decimal lengths are outside the exact-integer alpha canonicalization.",
                "vacuum" if "vacuum" in declaration.fields else None,
            )
        )
    if declaration.fields.get("vacuum_unit") != LENGTH_UNIT:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2509",
                f"Slab vacuum requires the explicit unit {LENGTH_UNIT!r}.",
                f"Add 'vacuum_unit {LENGTH_UNIT}'.",
                "vacuum_unit" if "vacuum_unit" in declaration.fields else None,
            )
        )
    diagnostics.append(
        _diagnostic(
            declaration,
            Severity.REVIEW_REQUIRED,
            "CHM2510",
            "The slab construction is declared with provenance but has not been executed.",
            "A versioned slab-construction adapter must run before the slab "
            "becomes a calculation-ready geometry.",
            "construction" if "construction" in declaration.fields else None,
        )
    )


def _validate_adsorption_complex(
    declaration: Declaration,
    symbols: dict[str, Declaration],
    diagnostics: list[Diagnostic],
) -> None:
    _require_fields(
        declaration, ("slab", "adsorbate", "site", "height", "height_unit"), diagnostics
    )
    slab = declaration.fields.get("slab")
    slab_declaration = symbols.get(slab) if isinstance(slab, str) else None
    if slab_declaration is None:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2511",
                f"Adsorption-complex slab {slab!r} does not resolve.",
                "Reference a declared surface_slab declaration.",
                "slab" if "slab" in declaration.fields else None,
            )
        )
    elif slab_declaration.kind != "surface_slab":
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2512",
                "An adsorption complex must reference a surface slab.",
                "Reference a surface_slab declaration.",
                "slab",
            )
        )
    adsorbate = declaration.fields.get("adsorbate")
    if (
        not isinstance(adsorbate, list)
        or not adsorbate
        or not all(isinstance(item, str) for item in adsorbate)
    ):
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2513",
                "Adsorbate identity must be a non-empty list of element symbols.",
                "Use an explicit list such as [Cu].",
                "adsorbate" if "adsorbate" in declaration.fields else None,
            )
        )
    elif len(adsorbate) > MAX_ADSORBATE_ELEMENTS or len(set(adsorbate)) != len(adsorbate):
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2514",
                "Adsorbate elements must be unique and bounded.",
                f"List at most {MAX_ADSORBATE_ELEMENTS} unique element symbols.",
                "adsorbate",
            )
        )
    elif set(adsorbate) - ELEMENT_SYMBOLS:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2515",
                "Adsorbate entries must be element symbols from the v1alpha1 schema.",
                "Use exact element symbols such as Cu, C, or O.",
                "adsorbate",
            )
        )
    site = declaration.fields.get("site")
    if site not in SURFACE_SITE_LABELS:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2516",
                f"Adsorption site {site!r} is outside the declared site vocabulary.",
                "Use top, bridge, fcc_hollow, or hcp_hollow.",
                "site" if "site" in declaration.fields else None,
            )
        )
    height = declaration.fields.get("height")
    if not _is_bounded_integer(height, 1, MAX_ADSORBATE_HEIGHT_ANGSTROM):
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2517",
                "Adsorbate height must be an integer of whole angstroms "
                f"from 1 to {MAX_ADSORBATE_HEIGHT_ANGSTROM}.",
                "Decimal lengths are outside the exact-integer alpha canonicalization.",
                "height" if "height" in declaration.fields else None,
            )
        )
    if declaration.fields.get("height_unit") != LENGTH_UNIT:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2518",
                f"Adsorbate height requires the explicit unit {LENGTH_UNIT!r}.",
                f"Add 'height_unit {LENGTH_UNIT}'.",
                "height_unit" if "height_unit" in declaration.fields else None,
            )
        )
    diagnostics.append(
        _diagnostic(
            declaration,
            Severity.REVIEW_REQUIRED,
            "CHM2519",
            "The adsorbate placement is declared but has not been constructed.",
            "A versioned placement adapter must run before the complex "
            "becomes a calculation-ready geometry.",
            "site" if "site" in declaration.fields else None,
        )
    )


def _validate_interface_reaction_step(
    declaration: Declaration,
    symbols: dict[str, Declaration],
    diagnostics: list[Diagnostic],
) -> None:
    _require_fields(declaration, ("reactants", "products"), diagnostics)
    endpoints: dict[str, list[str]] = {}
    for role in ("reactants", "products"):
        references = declaration.fields.get(role)
        if (
            not isinstance(references, list)
            or not references
            or not all(isinstance(item, str) for item in references)
        ):
            diagnostics.append(
                _diagnostic(
                    declaration,
                    Severity.ERROR,
                    "CHM2520",
                    f"Reaction-step {role} must be a non-empty list of references.",
                    "List the adsorption complexes consumed or produced by the step.",
                    role if role in declaration.fields else None,
                )
            )
            continue
        endpoints[role] = references
        for reference in references:
            referenced = symbols.get(reference)
            if referenced is None:
                diagnostics.append(
                    _diagnostic(
                        declaration,
                        Severity.ERROR,
                        "CHM2521",
                        f"Reaction-step reference {reference!r} does not resolve.",
                        "Reference declared adsorption complexes.",
                        role,
                    )
                )
            elif referenced.kind != "adsorption_complex":
                diagnostics.append(
                    _diagnostic(
                        declaration,
                        Severity.ERROR,
                        "CHM2522",
                        f"Reaction-step reference {reference!r} is not an adsorption complex.",
                        "The alpha reaction step binds adsorption-complex revisions only.",
                        role,
                    )
                )
    if "reactants" in endpoints and "products" in endpoints:
        shared = set(endpoints["reactants"]) & set(endpoints["products"])
        if shared:
            diagnostics.append(
                _diagnostic(
                    declaration,
                    Severity.ERROR,
                    "CHM2523",
                    "A reaction step cannot consume and produce the same subject.",
                    "Split the step or reference distinct subject revisions.",
                    "products",
                )
            )
        slabs = {
            symbols[reference].fields.get("slab")
            for reference in [*endpoints["reactants"], *endpoints["products"]]
            if reference in symbols and symbols[reference].kind == "adsorption_complex"
        }
        if len(slabs) > 1:
            diagnostics.append(
                _diagnostic(
                    declaration,
                    Severity.ERROR,
                    "CHM2524",
                    "Reaction-step endpoints come from more than one surface slab.",
                    "Cross-slab, cross-termination, and cross-thickness energy "
                    "differences are incomparable without a reviewed profile.",
                    "products",
                )
            )
    diagnostics.append(
        _diagnostic(
            declaration,
            Severity.REVIEW_REQUIRED,
            "CHM2525",
            "The reaction step is declared bookkeeping; no energy evaluation exists in this alpha.",
            "A computed energy difference requires reviewed executions; barriers, "
            "rates, and catalytic claims need separately reviewed profiles.",
            None,
        )
    )


_CONDITION_ENVIRONMENT_PHASES = {
    "molecule": "gas",
    "crystal": "solid",
    "surface_slab": "solid",
    "adsorption_complex": "gas_solid_interface",
}
_FORBIDDEN_CONDITION_FIELDS = (
    "pressure",
    "pressure_unit",
    "solvent",
    "total_charge",
    "spin_multiplicity",
    "spin_polarized",
)


def _validate_conditions(
    declaration: Declaration,
    symbols: dict[str, Declaration],
    diagnostics: list[Diagnostic],
) -> None:
    _require_fields(declaration, ("phase",), diagnostics)
    if "phase" in declaration.fields and declaration.fields["phase"] not in CONDITION_PHASES:
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2602",
                f"Phase {declaration.fields['phase']!r} is outside the declared vocabulary.",
                "Use one of the RFC-0007 phase values; no default is applied.",
                "phase",
            )
        )
    target = declaration.fields.get("target")
    if target is not None and (not isinstance(target, str) or target not in symbols):
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2603",
                f"Conditions target {target!r} does not resolve.",
                "Reference a declared subject or drop the target field.",
                "target",
            )
        )
    temperature = declaration.fields.get("temperature")
    if temperature is not None and (
        not _is_bounded_integer(temperature, 0, MAX_TEMPERATURE_KELVIN)
        or declaration.fields.get("temperature_unit") != TEMPERATURE_UNIT
    ):
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2602",
                "Temperature must be a whole-kelvin integer with an explicit unit.",
                f"Use 'temperature <integer>' and 'temperature_unit {TEMPERATURE_UNIT}'.",
                "temperature" if "temperature" in declaration.fields else "temperature_unit",
            )
        )
    pressure = declaration.fields.get("pressure")
    if pressure is not None and (
        not _is_bounded_integer(pressure, 0, MAX_PRESSURE_BAR)
        or declaration.fields.get("pressure_unit") != PRESSURE_UNIT
    ):
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2602",
                "Pressure must be a whole-bar integer with an explicit unit.",
                f"Use 'pressure <integer>' and 'pressure_unit {PRESSURE_UNIT}'.",
                "pressure" if "pressure" in declaration.fields else "pressure_unit",
            )
        )
    value_checks: list[tuple[str, Callable[[object], bool]]] = [
        (
            "solvent",
            lambda value: (
                isinstance(value, str)
                and bool(value)
                and len(value) <= MAX_SHORT_STRING_LENGTH
                and is_nfc(value)
            ),
        ),
        ("total_charge", lambda value: _is_bounded_integer(value, -128, 128)),
        ("spin_multiplicity", lambda value: _is_bounded_integer(value, 1, 128)),
        ("spin_polarized", lambda value: isinstance(value, bool)),
    ]
    for field, checker in value_checks:
        if field in declaration.fields and not checker(declaration.fields[field]):
            diagnostics.append(
                _diagnostic(
                    declaration,
                    Severity.ERROR,
                    "CHM2602",
                    f"Conditions field {field!r} has an invalid value.",
                    "Use the RFC-0007 value shape for this field.",
                    field,
                )
            )


def _condition_admission(
    consumer: Declaration,
    condition: Declaration,
    expected_phase: str,
    expected_target: str,
    diagnostics: list[Diagnostic],
) -> None:
    """Admit one condition set for the alpha's zero-kelvin profiles, no defaults."""
    if condition.fields.get("phase") is None:
        diagnostics.append(
            _diagnostic(
                consumer,
                Severity.ERROR,
                "CHM2605",
                "Insufficient conditions: phase is required by this workflow.",
                "Declare the phase on the conditions object; it is never defaulted.",
                "conditions",
            )
        )
    elif condition.fields["phase"] != expected_phase:
        diagnostics.append(
            _diagnostic(
                consumer,
                Severity.ERROR,
                "CHM2604",
                f"Phase {condition.fields['phase']!r} is outside this workflow's "
                f"admitted profile ({expected_phase!r}).",
                "Use a conditions object matching the workflow profile.",
                "conditions",
            )
        )
    if "temperature" not in condition.fields:
        diagnostics.append(
            _diagnostic(
                consumer,
                Severity.ERROR,
                "CHM2605",
                "Insufficient conditions: temperature is required by this workflow.",
                "Declare 'temperature 0' explicitly for the zero-kelvin alpha profiles.",
                "conditions",
            )
        )
    elif condition.fields["temperature"] != 0:
        diagnostics.append(
            _diagnostic(
                consumer,
                Severity.ERROR,
                "CHM2604",
                f"Temperature {condition.fields['temperature']!r} is outside this "
                "workflow's admitted zero-kelvin profile.",
                "Finite-temperature workflows need their own reviewed profile.",
                "conditions",
            )
        )
    for field in _FORBIDDEN_CONDITION_FIELDS:
        if field in condition.fields:
            diagnostics.append(
                _diagnostic(
                    consumer,
                    Severity.ERROR,
                    "CHM2604",
                    f"Conditions field {field!r} is not admitted by this workflow.",
                    "Remove the field or wait for a workflow that requires it; "
                    "declared conditions are never silently ignored.",
                    "conditions",
                )
            )
    if condition.fields.get("target") != expected_target:
        diagnostics.append(
            _diagnostic(
                consumer,
                Severity.ERROR,
                "CHM2603",
                f"Conditions target {condition.fields.get('target')!r} does not match "
                f"the consumer subject {expected_target!r}.",
                "Use one conditions object per subject.",
                "conditions",
            )
        )


def _validate_calculation_conditions(
    declaration: Declaration,
    target: Declaration,
    symbols: dict[str, Declaration],
    diagnostics: list[Diagnostic],
) -> None:
    conditions_name = declaration.fields.get("conditions")
    if not isinstance(conditions_name, str):
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2601",
                "Insufficient conditions: the calculation lacks a conditions reference.",
                "Declare a conditions object for this target and reference it.",
            )
        )
        return
    condition = symbols.get(conditions_name)
    if condition is None or condition.kind != "conditions":
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2602",
                f"Calculation conditions {conditions_name!r} does not resolve to a "
                "conditions declaration.",
                "Reference a declared conditions object.",
                "conditions",
            )
        )
        return
    expected_phase = _CONDITION_ENVIRONMENT_PHASES.get(target.kind, "solid")
    _condition_admission(declaration, condition, expected_phase, target.identifier, diagnostics)


def _validate_comparison(
    declaration: Declaration,
    symbols: dict[str, Declaration],
    diagnostics: list[Diagnostic],
) -> None:
    for required in (
        "kind",
        "stability_kind",
        "subjects",
        "conditions",
        "reference_state",
        "method",
    ):
        if required not in declaration.fields:
            diagnostics.append(
                _diagnostic(
                    declaration,
                    Severity.ERROR,
                    "CHM2610",
                    f"Insufficient comparison semantics: {required!r} is required "
                    "by this task kind.",
                    f"Add the {required!r} field; comparison semantics stay data, "
                    "never prose or defaults.",
                    required if required in declaration.field_spans else None,
                )
            )
    for field, allowed in (
        ("kind", COMPARISON_KINDS),
        ("stability_kind", STABILITY_KINDS),
    ):
        if field in declaration.fields and declaration.fields[field] not in allowed:
            diagnostics.append(
                _diagnostic(
                    declaration,
                    Severity.ERROR,
                    "CHM2610",
                    f"Comparison {field} {declaration.fields[field]!r} is outside the "
                    "declared task vocabulary.",
                    "State the comparison semantics the workflow admits.",
                    field,
                )
            )
    subjects = declaration.fields.get("subjects")
    subject_declarations: list[Declaration] = []
    if (
        not isinstance(subjects, list)
        or not subjects
        or not all(isinstance(item, str) for item in subjects)
        or len(subjects) < 2
        or len(subjects) > MAX_COMPARISON_SUBJECTS
        or len(set(subjects)) != len(subjects)
    ):
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2611",
                "Comparison subjects must be at least two unique references.",
                "List the candidate subjects explicitly.",
                "subjects" if "subjects" in declaration.fields else None,
            )
        )
    else:
        for name in subjects:
            subject = symbols.get(name)
            if subject is None:
                diagnostics.append(
                    _diagnostic(
                        declaration,
                        Severity.ERROR,
                        "CHM2611",
                        f"Comparison subject {name!r} does not resolve.",
                        "Reference declared subjects.",
                        "subjects",
                    )
                )
            else:
                subject_declarations.append(subject)
    stability_kind = declaration.fields.get("stability_kind")
    slab_ids: set[object] = set()
    resolved_all = isinstance(subjects, list) and len(subject_declarations) == len(subjects)
    if subject_declarations and resolved_all:
        if stability_kind == "adsorption_site_preference":
            if not all(item.kind == "adsorption_complex" for item in subject_declarations):
                diagnostics.append(
                    _diagnostic(
                        declaration,
                        Severity.ERROR,
                        "CHM2611",
                        "Adsorption-site preference compares adsorption complexes only.",
                        "Use energy_ordering_under_profile for other subject kinds.",
                        "subjects",
                    )
                )
            else:
                slab_ids = {item.fields.get("slab") for item in subject_declarations}
                if len(slab_ids) != 1:
                    diagnostics.append(
                        _diagnostic(
                            declaration,
                            Severity.ERROR,
                            "CHM2611",
                            "Site-preference subjects come from more than one slab.",
                            "Compare sites on a single slab; cross-slab ordering is "
                            "incomparable without a reviewed profile.",
                            "subjects",
                        )
                    )
        elif stability_kind == "energy_ordering_under_profile" and not all(
            item.kind == "crystal" for item in subject_declarations
        ):
            diagnostics.append(
                _diagnostic(
                    declaration,
                    Severity.ERROR,
                    "CHM2611",
                    "Energy ordering compares explicit crystal subjects only.",
                    "Use adsorption_site_preference for surface complexes.",
                    "subjects",
                )
            )
    if (
        stability_kind in STABILITY_KINDS
        and declaration.fields.get("method") not in SURFACE_METHOD_NAMES
    ):
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2610",
                f"Comparison method {declaration.fields.get('method')!r} is not admitted "
                "for these subjects.",
                "The alpha admits the classical 'emt' method profile only.",
                "method" if "method" in declaration.fields else None,
            )
        )
    conditions_name = declaration.fields.get("conditions")
    condition = symbols.get(conditions_name) if isinstance(conditions_name, str) else None
    if condition is None or condition.kind != "conditions":
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2610",
                f"Comparison conditions {conditions_name!r} do not resolve to a "
                "conditions declaration.",
                "Bind the environment as data on the comparison.",
                "conditions" if "conditions" in declaration.fields else None,
            )
        )
    else:
        if stability_kind == "adsorption_site_preference" and len(slab_ids) == 1:
            expected_target = next(iter(slab_ids))
            expected_phase = "gas_solid_interface"
        elif (
            stability_kind == "energy_ordering_under_profile"
            and subject_declarations
            and resolved_all
            and all(item.kind == "crystal" for item in subject_declarations)
            and isinstance(subjects, list)
        ):
            expected_target = subjects[0]
            expected_phase = "solid"
        else:
            expected_target = None
            expected_phase = "solid"
        if isinstance(expected_target, str):
            _condition_admission(
                declaration, condition, expected_phase, expected_target, diagnostics
            )
    reference_state = declaration.fields.get("reference_state")
    if reference_state is not None and (
        not isinstance(reference_state, str)
        or not reference_state
        or len(reference_state) > MAX_SHORT_STRING_LENGTH
        or not is_nfc(reference_state)
    ):
        diagnostics.append(
            _diagnostic(
                declaration,
                Severity.ERROR,
                "CHM2610",
                "A comparison requires an explicit non-empty reference state.",
                "Declare what the candidates are measured against.",
                "reference_state",
            )
        )
    diagnostics.append(
        _diagnostic(
            declaration,
            Severity.REVIEW_REQUIRED,
            "CHM2612",
            "The comparison is format-accepted only: model validity needs executed "
            "results, and experimental validity is never claimed by this object.",
            "Run the admitted workflow and review evidence before drawing conclusions.",
            None,
        )
    )
