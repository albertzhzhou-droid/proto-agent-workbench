# Chem computation: Analysis, Statistics and Chemical Data

Chem Compute now uses three chemistry-specific sections in the shared paper/ink
workbench shell. The reaction simulator, complete operator catalog and saved run
history remain available. The catalog contains 21 fixed local operators, with
11 added by this extension. Availability comes from the configured Python runtime.

| Section | Added calculation | Method |
| --- | --- | --- |
| Analysis | Analytical calibration | OLS or explicitly weighted linear least squares, coefficient intervals, residuals and unknown concentration with dilution correction |
| Analysis | Spectrum and chromatogram | Optional Savitzky–Golay smoothing, endpoint baseline, prominence-based peaks and trapezoidal integration |
| Analysis | Chemical descriptor PCA | Centering, optional autoscaling, NumPy SVD, sample scores, loadings and explained variance |
| Statistics | Replicate precision | Sample SD, RSD, SEM, Student t interval and explicit missing-value policy |
| Statistics | Assay group comparison | Welch or paired t test, mean difference, interval and standardized effect |
| Chemical Data | Molecular dataset preparation | RDKit canonical identity, descriptors, duplicate groups, invalid records and explicit salt policy |
| Chemical Data | Substructure search | SMARTS matching with indices on the returned canonical molecular graph |
| Chemical Data | Molecular clustering | Morgan fingerprints, Tanimoto similarity and Butina centroids |
| Chemical Data | Formula properties | Element/isotope counts and molar mass, including parentheses and hydrates |
| Chemical Data | Equation balancing | Exact SymPy nullspace with atom, explicit isotope and charge conservation |
| Chemical Data | Solution calculator | Amount/mass/concentration conversion and dilution material balance with explicit units |

## Input, output and shared Chat

Forms are generated from the same live schemas supplied to Chat. Numeric arrays,
replicate groups, compound SMILES lines and descriptor matrices have dedicated
editing controls. CSV/TSV imports preview the table and require explicit column
selection before changing the form. Complete JSON remains available for nested
or advanced input. Import does not infer chemical identity, measurement units,
pairing or missing-value treatment.

Charts carry the actual x/y labels and units. Calibration residuals and PCA
explained variance have their own plots. Saved results retain warnings and
method choices. Editing an input labels the displayed result as belonging to
the previous run. Run history restores the saved operator, input and result.

Both Chat editions discover canonical `chemistry.*` tools through
`science_catalog` and execute them through `science_run`. `chem.*` aliases resolve
to the same operators and deduplication signature. There is one worker service
and one history, rather than an independent Chat implementation.

Every run keeps input, result and manifest artifacts under `build/chem-science/`.
Worker provenance includes hashes of `chem_science.py`, `chem_analysis.py` and
`chem_data.py`, plus an aggregate source hash and installed dependency versions.
The imported Chem source snapshot is unchanged.

## Sources and interpretation

Public OpenScience chemistry procedures informed the analytical workflow and
RDKit data operators. The analytical numerical adapters use NumPy/SciPy; formula
mass uses RDKit's element data and balancing uses SymPy. These are documented
adaptations and local implementations, not a claim that every algorithm was
ported from OpenScience. Source commits, inspected files, methods and licenses
are recorded in [analysis methods](chem-analysis-methods.md) and
[chemical data methods](chem-data-methods.md).

Calibration treats standards as known x values and returns point estimates for
unknown concentrations; it does not propagate preparation or dilution errors.
Peaks and PCA separation do not identify compounds. Dataset processing preserves
invalid rows and does not silently neutralize charges or merge tautomers.
Balanced equations establish conservation, not reaction feasibility. The
existing reaction scene remains linked to solved populations; these additions
do not turn it into an atomistic reaction-path solver.

## Verification

Focused evidence is written under `build/chem-analysis-qa/` and
`build/chem-data-qa/`. It covers numerical comparisons with analytic cases and
independent scientific APIs, invalid inputs, all 21 catalog examples, all 11 new
operators through the actual shared bridge, schema validation, aliases and saved
source hashes. Browser acceptance includes CSV calibration input, missing-value
rejection/recovery, molecular data, plots and history. A real local
`unsloth/qwen3.8-27b` Q4_K_M Chat turn discovered and executed calibration and
reported slope 2, intercept 0.1 and dilution-corrected concentration 15 mg/L.

These checks demonstrate the local numerical and workflow behavior; they are
not a model promotion or clean-machine installer acceptance.
