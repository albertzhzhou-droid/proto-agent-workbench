"""Schema-aligned constraints shared by source and artifact validation."""

from __future__ import annotations

import re
import unicodedata
from decimal import Decimal, InvalidOperation
from pathlib import PurePath, PureWindowsPath

IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")
SHA256_HEX_PATTERN = re.compile(r"^[0-9a-f]{64}$")
SOURCE_REFERENCE_PATTERN = re.compile(r"^source:sha256:([0-9a-f]{64})$")
NAMESPACED_EXTENSION_PATTERN = re.compile(
    r"^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*:[A-Za-z][A-Za-z0-9_.-]*$"
)
CANONICAL_DECIMAL_PATTERN = re.compile(r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$")
MAX_CANONICAL_DECIMAL_LENGTH = 64
MAX_OBJECTS = 100_000
MAX_REFERENCE_ITEMS = 4_096
MAX_RELATIVE_PATH_LENGTH = 4_096
MAX_SHORT_STRING_LENGTH = 512
MAX_REPRESENTATION_BYTES = 16 * 1024 * 1024
MAX_PROPERTIES = 64

MOLECULAR_FORMATS = frozenset({"smiles", "inchi", "sdf"})
SUPPORTED_TASKS = frozenset(
    {
        "single_point",
        "geometry_optimization",
        "frequency",
        "molecular_dynamics",
        "cell_optimization",
        "band_structure",
        "density_of_states",
    }
)
SUPPORTED_PROPERTIES = frozenset(
    {
        "energy",
        "gradient",
        "hessian",
        "forces",
        "stress",
        "dipole",
        "charges",
        "orbitals",
        "optimized_geometry",
        "frequencies",
        "band_structure",
        "density_of_states",
    }
)

# Surface and interface extension (RFC-0006). These sets are the admitted
# alpha surface profile, not the advertised capability of any backend: EMT's
# extended element parameters are deliberately not admitted, so the declared
# adsorbate composition is closed to copper while no execution exists at all.
SURFACE_SLAB_CONSTRUCTIONS = frozenset({"fcc-cubic-cell-cut"})
SURFACE_SLAB_MILLER_INDICES = frozenset({(1, 1, 1)})
SURFACE_SITE_LABELS = frozenset({"top", "bridge", "fcc_hollow", "hcp_hollow"})
SURFACE_METHOD_NAMES = frozenset({"emt"})
SURFACE_PROFILE_ELEMENTS = frozenset({"Cu"})
LENGTH_UNIT = "angstrom"
MAX_SLAB_LAYERS = 64
MAX_SLAB_VACUUM_ANGSTROM = 1000
MAX_ADSORBATE_ELEMENTS = 64
MAX_ADSORBATE_HEIGHT_ANGSTROM = 1000

ELEMENT_SYMBOLS = frozenset(
    {
        "H",
        "He",
        "Li",
        "Be",
        "B",
        "C",
        "N",
        "O",
        "F",
        "Ne",
        "Na",
        "Mg",
        "Al",
        "Si",
        "P",
        "S",
        "Cl",
        "Ar",
        "K",
        "Ca",
        "Sc",
        "Ti",
        "V",
        "Cr",
        "Mn",
        "Fe",
        "Co",
        "Ni",
        "Cu",
        "Zn",
        "Ga",
        "Ge",
        "As",
        "Se",
        "Br",
        "Kr",
        "Rb",
        "Sr",
        "Y",
        "Zr",
        "Nb",
        "Mo",
        "Tc",
        "Ru",
        "Rh",
        "Pd",
        "Ag",
        "Cd",
        "In",
        "Sn",
        "Sb",
        "Te",
        "I",
        "Xe",
        "Cs",
        "Ba",
        "La",
        "Ce",
        "Pr",
        "Nd",
        "Pm",
        "Sm",
        "Eu",
        "Gd",
        "Tb",
        "Dy",
        "Ho",
        "Er",
        "Tm",
        "Yb",
        "Lu",
        "Hf",
        "Ta",
        "W",
        "Re",
        "Os",
        "Ir",
        "Pt",
        "Au",
        "Hg",
        "Tl",
        "Pb",
        "Bi",
        "Po",
        "At",
        "Rn",
        "Fr",
        "Ra",
        "Ac",
        "Th",
        "Pa",
        "U",
        "Np",
        "Pu",
        "Am",
        "Cm",
        "Bk",
        "Cf",
        "Es",
        "Fm",
        "Md",
        "No",
        "Lr",
        "Rf",
        "Db",
        "Sg",
        "Bh",
        "Hs",
        "Mt",
        "Ds",
        "Rg",
        "Cn",
        "Nh",
        "Fl",
        "Mc",
        "Lv",
        "Ts",
        "Og",
    }
)


def is_chemir_identifier(value: object) -> bool:
    return isinstance(value, str) and IDENTIFIER_PATTERN.fullmatch(value) is not None


def is_namespaced_extension(value: object) -> bool:
    return isinstance(value, str) and NAMESPACED_EXTENSION_PATTERN.fullmatch(value) is not None


def is_sha256_hex(value: object) -> bool:
    return isinstance(value, str) and SHA256_HEX_PATTERN.fullmatch(value) is not None


def is_nfc(value: object) -> bool:
    return isinstance(value, str) and unicodedata.normalize("NFC", value) == value


def source_reference_digest(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    match = SOURCE_REFERENCE_PATTERN.fullmatch(value)
    return match.group(1) if match is not None else None


def is_portable_relative_path(value: object) -> bool:
    if not isinstance(value, str) or not value or len(value) > MAX_RELATIVE_PATH_LENGTH:
        return False
    normalized = value.replace("\\", "/")
    return not (
        PureWindowsPath(value).is_absolute()
        or value.startswith(("/", "\\"))
        or ".." in PurePath(normalized).parts
    )


def canonical_decimal(text: str) -> str | None:
    """Return the canonical decimal string for exact CIF/JSON-style input.

    Canonical form: optional sign, no leading zeros, no exponent, no trailing
    fractional zeros, and a plain ``0`` for every zero. ``None`` means the
    input is not a finite decimal number. Binary floating point never appears:
    decimals are carried as strings end to end.
    """
    if not isinstance(text, str) or not text or len(text) > MAX_CANONICAL_DECIMAL_LENGTH:
        return None
    try:
        value = Decimal(text)
    except InvalidOperation:
        return None
    if not value.is_finite():
        return None
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    if rendered in ("", "-", "-0"):
        rendered = "0"
    if len(rendered) > MAX_CANONICAL_DECIMAL_LENGTH:
        return None
    if CANONICAL_DECIMAL_PATTERN.fullmatch(rendered) is None:
        return None
    return rendered


def is_canonical_decimal(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) <= MAX_CANONICAL_DECIMAL_LENGTH
        and CANONICAL_DECIMAL_PATTERN.fullmatch(value) is not None
        and value != "-0"
    )


# Conditions and comparison task semantics (RFC-0007). These sets are the
# declared question dimensions; workflow profiles decide which are required
# or forbidden, and nothing here is ever defaulted.
CONDITION_PHASES = frozenset(
    {
        "solid",
        "liquid",
        "gas",
        "solution",
        "gas_solid_interface",
        "liquid_solid_interface",
        "solid_solid_interface",
        "gas_liquid_interface",
    }
)
TEMPERATURE_UNIT = "kelvin"
PRESSURE_UNIT = "bar"
MAX_TEMPERATURE_KELVIN = 100_000
MAX_PRESSURE_BAR = 1_000_000_000
COMPARISON_KINDS = frozenset({"stability"})
STABILITY_KINDS = frozenset({"energy_ordering_under_profile", "adsorption_site_preference"})
MAX_COMPARISON_SUBJECTS = 64
