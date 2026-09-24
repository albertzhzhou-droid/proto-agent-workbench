"""Single source of truth for the Chem Workbench package version."""

__version__ = "0.1.0a2"
COMPILER_ID = f"chem-workbench/{__version__}"
SUPPORTED_REVIEW_COMPILER_IDS = frozenset(
    {
        "chem-workbench/0.1.0a1",
        COMPILER_ID,
    }
)
