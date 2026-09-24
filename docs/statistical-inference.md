# Statistical inference contracts

`compare_two_groups` and `correlation` accept an optional `confidence_level`
strictly between 0 and 1 (default 0.95). Existing input examples and result fields
remain valid. The new fields are additive; selecting another confidence level
changes interval coverage, not the test's two-sided p-value or point estimates.

Both results expose `confidence_interval` with `status`, `method`,
`confidence_level`, `estimand`, `estimate`, `lower` and `upper`. An unavailable
interval has null bounds and an explicit `reason`; it is never replaced with
zero uncertainty. `assumptions` describes the inferential conditions, which the
software does not infer or establish from a successful calculation.

## Two-group comparisons

The raw mean difference, its interval and standardized differences use **group A
minus group B**. `mean_difference_orientation` records that convention. Values
retain the caller's measurement units; standardized effect estimates are
dimensionless. `standard_error` is the sampling standard error of the raw mean
difference for t methods, and is null for Mann-Whitney.

| Method | Interval | Effect-size point estimates |
| --- | --- | --- |
| Welch t | Mean difference plus/minus the t critical value times its standard error, using Welch-Satterthwaite degrees of freedom | `cohen_d`, explicitly standardized by the sample-size-weighted pooled sample SD; a descriptive convention under unequal variances |
| Student t | Mean-difference t interval using pooled variance and `n_a+n_b-2` degrees of freedom | `cohen_d` and `hedges_g`; the latter uses the exact gamma-ratio correction `J(df)` |
| Paired t | Mean-of-paired-differences t interval with `n_pairs-1` degrees of freedom | `cohen_dz`, standardized by the sample SD of paired differences |
| Mann-Whitney | Unavailable: a rank test is not a mean-difference interval | `rank_biserial = P(A>B)-P(A<B)`, estimated over cross-group pairs; ties contribute zero |

Each standardized mean effect declares its denominator and value; Hedges g
additionally records the correction and its degrees of freedom. Effect-size
confidence intervals are not implemented. The interval attached to a t result
covers its raw population mean difference, not Cohen d, Hedges g or dz.

Student t and its bias correction assume independent normal populations with
equal variances. Welch permits unequal variances, using an approximate reference
distribution. Paired t requires independent pairs and normally distributed
within-pair differences for exact small-sample inference. These are model
conditions, not diagnostics inferred by this tool.

Both constant groups and zero-variance paired differences remain errors. One
constant independent group is allowed if the other has positive variance, and
retains a positive standard error and interval width. Two pairs are supported
with one degree of freedom; they can yield a very wide interval. Floating-point
overflow or an interval that cannot be numerically resolved is rejected.

Mann-Whitney retains the existing tie-adjusted, continuity-corrected asymptotic
p-value. It compares distributions; a median-shift interpretation requires
additional shape assumptions. It is not silently substituted for a paired test
or for an exact small-sample calculation.

## Correlations

Pearson results use an approximate Fisher-z interval for more than three pairs:
transform the coefficient, use standard error `1/sqrt(n-3)`, then transform the
normal-quantile limits back to [-1, 1]. The approximation assumes independent
pairs from a bivariate normal population; outliers and small samples can affect
coverage. The coefficient is itself a signed, dimensionless effect measure.

The interval is explicitly unavailable for three pairs, or perfect/numerically
saturated correlation (within eight floating-point ulps of magnitude one).
This avoids presenting a degenerate interval as evidence of certainty.
Constant vectors remain errors. Spearman retains its coefficient and asymptotic
p-value, but reports an unavailable interval: no resampling interval is
implemented, and the Pearson formula is not reused for ranks.

## Verification and method references

`tests/test_compute_inference.py` covers exact Cauchy and t-two-degree reference
intervals, a tabulated t-four-degree quantile, a closed-form gamma correction,
unequal-size/unequal-variance Welch inference, tied rank effects, reversal of
group orientation, a zero-correlation analytic Fisher interval, and independent
SciPy result-object interval comparisons. It also checks strict confidence
bounds, unsupported intervals and variance degeneracy. These are numerical
software checks, not validation on a particular biological or clinical dataset.

- [NIST two-sample t-test](https://www.itl.nist.gov/div898/handbook/eda/section3/eda353.htm): pooled and unequal-variance inference.
- [NIST Hedges g](https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/hedgeg.htm): weighted pooled SD and the gamma-ratio bias correction. Naming conventions vary; results explicitly identify the denominator used here.
- [SciPy independent t-test](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.ttest_ind.html): mean-difference sign and interval reference implementation.
- [SciPy Pearson confidence interval](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats._result_classes.PearsonRResult.confidence_interval.html): Fisher transformation assumptions and small-sample limits.
- [SciPy Mann-Whitney test](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.mannwhitneyu.html): first-group U statistic, tie handling and distributional null.
