# Chemistry analysis and statistical methods

The chemistry computation workspace adds five local, fixed operators in
`apps/proto-workbench/runtime/chem-integration/chem_analysis.py`. They expose the
same schemas and results to the workbench and the shared Chat tool service. The
module imports NumPy and SciPy only when a calculation needs them; unavailable
packages can therefore be reported by the catalog without preventing discovery.

## Scope and sources

OpenScience's public [statistical-analysis procedure](https://github.com/synthetic-sciences/openscience/blob/main/backend/cli/skills/coding/statistical-analysis/SKILL.md)
was inspected on 2026-09-19. Its separation of test selection, assumptions,
effect magnitude, intervals and diagnostic reporting informed this integration.
The five operators are newly written adapters to established numerical methods;
OpenScience's full statistics package, kernels and remote compute providers are
not embedded or claimed as installed. Its
[attribution registry](https://github.com/synthetic-sciences/openscience/blob/main/backend/cli/skills/ATTRIBUTION.md)
credits the statistical-analysis and scikit-learn procedures to K-Dense's
Scientific Agent Skills collection under MIT. OpenScience's application is
Apache-2.0. No upstream source code or skill text is copied into this module.

| Method provider | Use in this integration | Primary reference | License |
| --- | --- | --- | --- |
| NumPy | Sample summaries, weighted least squares, centered SVD and trapezoidal integration | [Least squares](https://numpy.org/doc/stable/reference/generated/numpy.linalg.lstsq.html), [SVD](https://numpy.org/doc/stable/reference/generated/numpy.linalg.svd.html) | [BSD-3-Clause](https://github.com/numpy/numpy/blob/main/LICENSE.txt) |
| SciPy statistics | Student t quantiles and probabilities for summaries, comparisons and coefficient intervals | [Independent t test](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.ttest_ind.html), [Student t distribution](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.t.html) | [BSD-3-Clause](https://github.com/scipy/scipy/blob/main/LICENSE.txt) |
| SciPy signal | Savitzky–Golay smoothing, local extrema, prominence and peak width | [Savitzky–Golay filter](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.savgol_filter.html), [Peak detection](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.find_peaks.html) | BSD-3-Clause |
| scikit-learn | Public PCA documentation was inspected as a method reference; this operator uses NumPy SVD and does not require or claim an installed scikit-learn runtime | [PCA](https://scikit-learn.org/stable/modules/generated/sklearn.decomposition.PCA.html) | [BSD-3-Clause](https://github.com/scikit-learn/scikit-learn/blob/main/COPYING) |

## Operators

### Replicate precision and uncertainty

`summarize_replicates` accepts named groups of measurements sharing one explicit
unit. It reports supplied/retained/missing counts, mean, minimum, maximum, sample
SD using `n - 1`, RSD as `100 * SD / abs(mean)`, SEM and a two-sided Student t
confidence interval for the mean. Confidence defaults to 0.95 and can range from
0.5 to 0.999.

An explicit JSON `null` is rejected by default. Selecting `missing: "omit"`
excludes only those null observations, records the count and preserves gaps at
their original positions in the plot. It does not remove outliers or impute
values. With fewer than two retained measurements the sample SD and inferential
interval are null; a zero mean produces null RSD. Independence and approximately
normal errors for small-sample intervals remain assumptions requiring review.
The input is bounded to 32 groups and 10,000 observations per group.

### Compare assay groups

`compare_assay_groups` supports two-sided Welch and paired t tests. Welch uses
the separate sample variances and Satterthwaite degrees of freedom. Paired mode
requires exactly equal vector lengths and interprets matching row indices as
the pairing declaration. Missing values are rejected, avoiding silent
misalignment of pairs. The difference and confidence interval are always A
minus B; the returned row includes standard error, degrees of freedom, t and p.

The standardized effect is explicitly defined: Cohen's d using pooled sample SD
for the independent comparison, or Cohen's dz using the sample SD of differences
for paired data. The displayed interval applies to the mean difference, not to
the standardized effect. Zero estimated standard error produces null inferential
statistics and an explanation, rather than infinite values or a significance
claim. This is a single comparison without multiplicity adjustment. Independence
cannot be established by the software, and no automatic normality acceptance or
equivalence claim is made. Each group requires 2–10,000 numeric observations.

### Analytical calibration curve

`fit_calibration_curve` fits `response = intercept + slope * concentration` by
ordinary least squares or explicit positive relative inverse-variance weights.
Standards remain paired by row. The design is centered and scaled before the
solve, then coefficients and covariance are transformed to the supplied units.
Coefficient intervals use a Student t distribution with `n - 2` degrees of
freedom and an estimated common residual scale. Responses, fitted values,
residuals and normalized weights are returned per standard.

Unknown responses are inverted through the fitted line. `dilution_factor`
multiplies the measured concentration to report the original concentration; it
defaults to one. Extrapolation flags compare the measured concentration with
the supplied standards' range. Negative estimates are retained and explained.
An effectively flat fit returns no inverse estimate. Inverse estimates are
points: preparation, dilution and unknown-response uncertainties are not
propagated. The fit assumes the concentration axis is known and does not perform
errors-in-variables regression. R-squared alone is not a validation result.
There are 3–1,000 standards, at least two distinct concentrations, and at most
256 unknowns. Declared units are preserved, without automatic conversion.

### Spectrum and chromatogram analysis

`analyze_spectrum` takes 3–10,000 finite x/y pairs with explicit axis labels and
units. A decreasing axis is reversed together with its response values; all
reported integrals then use increasing x. Nonmonotonic or duplicate x values
are rejected. Savitzky–Golay smoothing is optional (`smooth_window: 0` disables
it); when enabled, x must be uniformly spaced and the odd window must exceed
the polynomial order. No silent resampling occurs.

An optional straight endpoint baseline uses the actual x coordinate, including
nonuniform spacing. Positive or negative extrema are selected with declared
prominence and sample-distance thresholds. Width is reported at half
prominence, which must not be labeled generally as full width at half maximum.
Signal features carry no proposed chemical identities. Supplied regions are
integrated after processing using trapezoids and linear interpolation at exact
region boundaries; signed area and composite units are retained. The operator
does not deconvolve overlapping peaks, quantify a chemical without a calibration,
or infer an instrument's acquisition method.

### Chemical descriptor PCA

`chemical_pca` accepts a rectangular numeric table with unique feature names and
sample IDs. It centers every retained feature and optionally divides by sample
SD (`n - 1`). Constant or numerically unresolved features are reported and
excluded; at least two varying features must remain. Missing values and duplicate
IDs are errors. The matrix is bounded to 3–500 samples and 2–128 features.

NumPy SVD provides orthonormal loading vectors and sample scores. Component signs
are made reproducible by requiring the largest absolute loading to be positive.
Explained variance, cumulative fractions, preprocessing means/scales and a
reconstruction residual are returned. No whitening or supervised fitting is
performed. Loadings are eigenvectors, not feature-score correlations; tied
eigenspaces can rotate. Autoscaling is on by default for mixed chemistry
descriptors. Disabling it is explicit because numerically large feature
variances then dominate. Apparent grouping is descriptive evidence only.

## Result and artifact contract

Every operator returns a flat `rows` table, `method`, `warnings` and a
`visualization` with explicit x/y labels, units and aligned numeric series.
Optional null y values preserve missing replicate positions. Calibration adds
`coefficients`, `unknowns` and `residual_visualization`; spectra add `peaks` and
`integrations`; PCA adds `loadings`, `explained_variance`, `preprocessing` and
`scree_visualization`. Overflow is an explicit `NUMERICAL_RANGE` error rather than
NaN or infinity in an apparently successful result. The host service owns run
history, cancellation and hashed input/result artifacts; these operators do not
read external paths or execute supplied scripts.

## Verification

Run with the existing chemistry environment from the repository root:

```powershell
& 'C:/Users/pc/Documents/Chem CLI/.venv/Scripts/python.exe' apps/proto-workbench/tests/test_chem_analysis.py
```

The suite compares known replicate statistics, Welch and paired results against
independent SciPy test APIs, exact and weighted calibration solutions, a
triangular signal's partial area, Gaussian area/width, polynomial smoothing,
nonuniform-axis baselines, and PCA rank-one/covariance solutions. Boundary cases
cover missing data, pairing mismatch, zero variance, flat/singular calibration,
extrapolation, invalid axes/windows, constant columns and non-finite inputs.
All catalog examples must serialize without non-finite values and satisfy the
plot contract.

The generated receipt is
`build/chem-analysis-qa/analysis-numerical-acceptance.json`, including executed
case values, runtime versions and the exact module hash. These are local software
and numerical checks; they do not establish analytical method validation for an
instrument or application.
