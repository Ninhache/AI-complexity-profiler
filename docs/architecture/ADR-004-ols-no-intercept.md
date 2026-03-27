# ADR-004: Use OLS Regression Forced Through the Origin for Complexity Fitting

**Status**: Accepted
**Date**: 2026-03-27
**Deciders**: Architecture team

## Context

The S5 Complexity Analyzer must fit empirical `{n, opCount}` measurements to one of 7 candidate complexity models (O(1), O(log n), O(n), O(n log n), O(n²), O(n³), O(2ⁿ)) and select the best-fitting model. The fitting method must be simple, fast (< 20ms per function), and produce a reliable R² goodness-of-fit score for threshold comparison.

Three approaches were considered. **OLS with no intercept (forced through the origin)** linearizes each candidate model via a transform (e.g., for O(n²): let x = n², fit opCount = c·x), then finds the single coefficient c via ordinary least squares: c = Σ(x·y) / Σ(x²). This produces a one-parameter model per candidate and a well-defined R² score. **OLS with intercept** adds a constant term b, producing opCount = c·f(n) + b. This models fixed overhead (stack frame setup, constant-time initialization) but introduces a second parameter that must be estimated via a 2×2 linear system per candidate. The intercept does not affect the growth rate classification — the class is determined by f(n) alone — so the added parameter increases fitting complexity without improving the classification decision. **Non-linear least squares (e.g., Levenberg-Marquardt)** can fit multi-parameter models directly but requires iterative convergence, is sensitive to initial conditions, and adds a significant dependency (or implementation burden) for a problem that OLS already solves adequately.

The 7 input sizes [10, 30, 100, 300, 1000, 3000, 10000] span 3 orders of magnitude. At these scales, growth behavior dominates over any fixed overhead: a function with O(n²) behavior will have opCount at n=10000 that is ~10^6 times larger than at n=10, dwarfing any constant offset. The intercept, even if it exists, is negligible relative to the growth term at the upper end of the input range.

## Decision

S5 uses OLS regression forced through the origin: for each candidate model with transform function t(n), compute c = Σ(t(n)·opCount) / Σ(t(n)²) over the 7 measurement points, then compute R² = 1 - SS_res / SS_tot where SS_res = Σ(opCount - c·t(n))² and SS_tot = Σ(opCount - mean(opCount))². The model with the highest R² above the 0.92 threshold is selected.

OLS with intercept is rejected because the two-parameter model introduces a 2×2 system per candidate without changing the classification outcome. The extra parameter also risks overfitting: a poor-fit model (e.g., O(log n) for a truly O(n²) function) could absorb measurement noise into a large intercept and achieve a misleadingly high R². Non-linear least squares is rejected on complexity and dependency grounds; the linearization trick makes OLS exact for all 7 candidate models.

## Consequences

### Positive
- One-parameter model per candidate: the closed-form solution for c requires a single pass over 7 points — O(7) arithmetic per candidate, well within the 20ms budget
- No matrix inversion required: the no-intercept case reduces to a scalar division
- Forcing through the origin is theoretically correct: a function with zero input performs zero operations, so opCount(0) = 0 is a meaningful constraint
- R² interpretation is straightforward and consistent across all 7 candidates
- The math is fully self-contained; no external fitting library is needed

### Negative
- Functions with significant fixed overhead (e.g., a large constant-time initialization block before an O(n) loop) will have their opCount measurements slightly distorted at small n values, potentially inflating or deflating R² for the true model
- The no-intercept model cannot distinguish between a pure O(n) function and an O(n) function with a large constant additive term; both will classify as O(n) but with different c values
- A two-parameter model might achieve higher R² on pathological inputs and provide a better fit signal

### Mitigations
- The input sizes start at n=10 and reach n=10000; at n=10000, a fixed overhead term would need to be on the order of 10^4 operations to be non-negligible relative to O(n) behavior — uncommon in practice
- The R² threshold of 0.92 acts as a safety valve: if fixed overhead significantly distorts the fit, R² will fall below threshold and the function will receive a `~Θ(?)` LOW_CONFIDENCE annotation rather than a false classification
- A regression test fixture (constant_plus_linear.ts) will verify that a function with significant fixed overhead is classified as O(n) or LOW_CONFIDENCE, never as O(1)
