# S5 — Complexity Analyzer

> **Status**: APPROVED
> **Author**: architect
> **Created**: 2026-03-26
> **Priority**: MVP
> **Layer**: 4 (Analysis)

## 1. Overview

S5 is the mathematical core of the complexity profiler pipeline. It receives raw `(n, opCount)` measurement data from S4 for every profiled function, fits seven candidate complexity models to each function's growth curve using ordinary least-squares regression, and selects the best-fitting model by R-squared score. Its single output -- a `ComplexityResult` per function -- tells S6 which complexity class to display, how confident the classification is, which AST node is the computational bottleneck, and where in the original TypeScript source to place the annotation. S5 is purely computational: it performs no I/O, no async operations, and depends on no external math libraries. All regression is implemented with basic arithmetic (sums, products, division).

## 2. User Value

When S5 works correctly, the developer sees a precise, trustworthy complexity label on every function -- `O(n^2)` on their bubble sort, `O(n log n)` on their merge sort, `O(1)` on their hash lookup -- with a confidence score that distinguishes strong classifications from guesses. The `dominantLine` attribution points the developer to the exact TypeScript line responsible for the complexity (typically the innermost loop), so they know exactly where to optimize. When the data is insufficient or ambiguous, S5 says so explicitly (`INSUFFICIENT_DATA`, `LOW_CONFIDENCE`) rather than guessing -- the developer never sees a confident wrong answer from a thin dataset.

If S5 misclassifies a function -- labeling an O(n^2) sort as O(n), or an O(n) scan as O(n log n) -- the developer either ignores a real performance problem or wastes time investigating a false alarm. The R-squared threshold (0.92) and the 5-data-point minimum exist precisely to prevent these misclassifications.

## 3. Detailed Design

### 3.1 Public Interface

```typescript
export function analyzeComplexity(
  measurements:       MeasurementPoint[],    // from S4
  nodeRegistry:       Map<string, NodeMeta>, // from S2
  sourceMap:          SourceMap,             // from S1
  functionBoundaries: FunctionBoundary[],    // from S2 (name + jsStartLine per function)
  functionStatuses:   FunctionStatus[],      // from orchestrator (ok / timeout / runtime_error)
  minConfidence:      number,                // R² threshold; passed by orchestrator from VS Code config
): ComplexityResult[]
```

**Parameters:**

- `measurements` (`MeasurementPoint[]`): All measurement data collected by S4 for the current file. Each element contains `functionId`, `n`, `opCount`, and `nodeCounters`. Multiple elements may share the same `functionId` (one per input size that completed execution). The array may be empty if all functions timed out or errored.
- `nodeRegistry` (`Map<string, NodeMeta>`): Maps `nodeId` strings to AST node metadata. Produced by S2. Used to resolve `dominantNodeId` to a source location. Keys match the keys in `MeasurementPoint.nodeCounters`.
- `sourceMap` (`SourceMap`): The source map produced by S1, providing `jsToTs(jsLine, jsCol)` for translating JavaScript line numbers to TypeScript line numbers.
- `functionBoundaries` (`FunctionBoundary[]`): All function boundaries detected by S2. Used to resolve `ComplexityResult.functionName` from `FunctionBoundary.name` and to compute `tsLine` for functions with no measurements via `FunctionBoundary.jsStartLine`.
- `functionStatuses` (`FunctionStatus[]`): Per-function execution status built by the orchestrator from S4's `ExecutionResult`. Functions with `status: 'timeout'` or `status: 'runtime_error'` receive `TIMEOUT` or `RUNTIME_ERROR` results without OLS fitting. If a `functionId` present in `functionBoundaries` has no matching entry in `functionStatuses`, treat it as `FunctionStatus { functionId, status: 'ok' }`. This should not occur in correct orchestrator usage but provides a safe defensive fallback.

**Returns:** `ComplexityResult[]` -- one element per unique `functionId` in `functionBoundaries`. The array is not ordered in any guaranteed way. May be empty if `functionBoundaries` is empty.

**Synchronous.** This function performs no I/O and no async operations. All computation is arithmetic.

### 3.2 Candidate Complexity Models

S5 evaluates seven candidate models for each function. Each model defines a transformation function that maps input size `n` to a predictor value `x`:

| Class | String literal | Model f(n) | Predictor transform: x = transform(n) |
|-------|---------------|-----------|---------------------------------------|
| O(1) | `'O(1)'` | f(n) = c | x = 1 (constant predictor for all n) |
| O(log n) | `'O(log n)'` | f(n) = c * log_2(n) | x = log_2(n) |
| O(n) | `'O(n)'` | f(n) = c * n | x = n |
| O(n log n) | `'O(n log n)'` | f(n) = c * n * log_2(n) | x = n * log_2(n) |
| O(n^2) | `'O(n^2)'` | f(n) = c * n^2 | x = n^2 |
| O(n^3) | `'O(n^3)'` | f(n) = c * n^3 | x = n^3 |
| O(2^n) | `'O(2^n)'` | f(n) = c * 2^n | x = 2^n |

The predictor transform converts each raw input size `n_i` into the variable `x_i` used by the OLS fitting step. The string literal values match the `ComplexityClass` type union defined in `interface-contracts`.

### 3.3 OLS Fitting Algorithm (No Intercept, Forced Through Origin)

For each candidate model, the algorithm fits a single constant `c` to the data by minimizing the sum of squared residuals. The model is `opCount = c * transform(n)` -- a one-parameter linear regression through the origin.

**Input data:** `k` measurement points `{ (n_i, opCount_i) }` for a single `functionId`, where `i = 1..k`.

**Variables:**

| Variable | Type | Definition | Source |
|----------|------|-----------|--------|
| `k` | integer | Number of data points for this function | Count of MeasurementPoints with matching functionId |
| `n_i` | number | Input size for the i-th measurement | `MeasurementPoint.n` |
| `opCount_i` | number | Total operation count for the i-th measurement | `MeasurementPoint.opCount` |
| `x_i` | number | Predictor value: `transform(n_i)` for the current candidate model | Computed from `n_i` using the transform column in Section 3.2 |
| `c` | number | Best-fit scaling constant | Computed by OLS formula (Step 2 below) |
| `predicted_i` | number | Predicted opCount for the i-th point under this model | `c * x_i` |
| `mean_y` | number | Arithmetic mean of all `opCount_i` values | `(1/k) * sum(opCount_i)` |
| `SS_res` | number | Residual sum of squares | `sum((opCount_i - predicted_i)^2)` |
| `SS_tot` | number | Total sum of squares | `sum((opCount_i - mean_y)^2)` |
| `R_squared` | number | Coefficient of determination | `1 - (SS_res / SS_tot)`, clamped to [0.0, 1.0] |

**Algorithm steps (per candidate model):**

```
Step 1: Compute predictor values
  For each i in 1..k:
    x_i = transform(n_i)
  where transform() is defined by the candidate model (Section 3.2)

Step 2: Compute best-fit constant c (OLS, no intercept)
  c = sum(x_i * opCount_i, i=1..k) / sum(x_i^2, i=1..k)

Step 3: Compute predicted values
  For each i in 1..k:
    predicted_i = c * x_i

Step 4: Compute R-squared
  mean_y = (1/k) * sum(opCount_i, i=1..k)
  SS_res = sum((opCount_i - predicted_i)^2, i=1..k)
  SS_tot = sum((opCount_i - mean_y)^2, i=1..k)

  If SS_tot = 0:
    // All opCount values are identical
    // Handled in Step 5
  Else:
    R_squared = 1 - (SS_res / SS_tot)

Step 5: Clamp R-squared to [0.0, 1.0]
  R_squared = max(0.0, min(1.0, R_squared))
```

**Special case: O(1)**

The O(1) model does not use the standard OLS formula. Instead:

```
c = mean_y = (1/k) * sum(opCount_i, i=1..k)
predicted_i = c    (constant for all n)
SS_res = sum((opCount_i - c)^2, i=1..k)
SS_tot = sum((opCount_i - c)^2, i=1..k)
```

Note that for O(1), `SS_res` and `SS_tot` are identical. Therefore:
- If `SS_tot = 0` (all values identical): `R_squared = 1.0` (perfect constant fit).
- If `SS_tot > 0`: `R_squared = 1 - (SS_res / SS_tot) = 1 - 1 = 0.0`.

This is correct behavior: the O(1) model only achieves a high R-squared when the data is actually constant. When the data varies, O(1) always scores 0.0. The OLS formula without intercept would assign a non-zero `c` and could produce a misleading R-squared, so the O(1) model uses the mean as its constant instead.

**Special case: O(2^n)**

Before fitting, filter data points to only those where `n_i <= 30`:

```
filtered = { (n_i, opCount_i) | n_i <= 30 }
If |filtered| < 5:
  Skip this candidate entirely (do not compute R_squared; this model is not a contender)
Else:
  Compute OLS on filtered points only (k = |filtered|)
```

The cap at `n <= 30` prevents floating-point overflow: `2^31 = 2,147,483,648` which exceeds safe integer range for multiplication in OLS numerator/denominator terms. The 5-point minimum for the filtered set prevents overfitting to a small handful of points.

### 3.4 Class Selection Decision Tree

After computing R-squared for all candidate models (up to 7), select the final `ComplexityClass`:

```
// minConfidence is the 6th parameter (default: 0.92, passed by the orchestrator from VS Code config)

1. If total data points k < MIN_DATA_POINTS (5):
   complexity  = 'INSUFFICIENT_DATA'
   confidence  = 0
   // dataPoints still populated with whatever was collected

2. Let bestClass = the candidate with the highest R_squared
   (ties broken by selecting the LOWER complexity class -- prefer simpler models)

3. If bestClass.R_squared >= minConfidence:
   complexity = bestClass.class    // e.g., 'O(n^2)'
   confidence = bestClass.R_squared

4. Else (bestClass.R_squared < minConfidence):
   complexity = 'LOW_CONFIDENCE'
   confidence = bestClass.R_squared   // the highest R_squared even though < minConfidence
```

Dominant node attribution (§3.5) and tsLine attribution (§3.6) are performed regardless of the selected complexity class, including `LOW_CONFIDENCE`. The `dominantNodeId` and `dominantLine` fields are populated normally even when confidence is below the threshold.

**Tie-breaking order** (simplest to most complex): `O(1)`, `O(log n)`, `O(n)`, `O(n log n)`, `O(n^2)`, `O(n^3)`, `O(2^n)`. If two candidates produce the exact same R-squared, the one appearing earlier in this list wins.

### 3.5 Dominant Node Attribution

The dominant node is the instrumented AST node that accumulated the most operation counts -- the bottleneck.

**Algorithm:**

```
1. Find the measurement point with the largest n for this function:
   largestPoint = the MeasurementPoint with max(n) among all points for this functionId
   (ties broken by taking the first encountered)

2. From largestPoint.nodeCounters, find the nodeId with the highest count:
   dominantNodeId = argmax over nodeId of largestPoint.nodeCounters[nodeId]
   (ties broken by taking the first key encountered in iteration order)

3. Look up dominantNodeId in nodeRegistry:
   If nodeRegistry.has(dominantNodeId):
     dominantMeta = nodeRegistry.get(dominantNodeId)
     dominantLine = sourceMap.jsToTs(dominantMeta.jsLine, dominantMeta.jsCol).tsLine
   Else:
     // Fallback: use the function's own entry counter
     dominantNodeId = functionEntryNodeId   // the functionId itself (which is the nodeId of the function entry __op() call)
     dominantLine = tsLine of the function  // the function declaration's TS line
```

**Variables:**

| Variable | Type | Source |
|----------|------|--------|
| `largestPoint` | `MeasurementPoint` | The point in `measurements` (for this functionId) with the highest `n` value |
| `dominantNodeId` | `string` | The key in `largestPoint.nodeCounters` with the highest value |
| `dominantMeta` | `NodeMeta` | `nodeRegistry.get(dominantNodeId)` |
| `dominantLine` | `number` | `sourceMap.jsToTs(dominantMeta.jsLine, dominantMeta.jsCol).tsLine` |
| `functionEntryNodeId` | `string` | The `functionId` from `FunctionBoundary` -- which equals the nodeId of the function entry `__op()` call, since S2 uses the function entry node's `(jsLine, jsCol)` to compute `functionId` |

### 3.6 Source Line Attribution (tsLine)

The `tsLine` field in `ComplexityResult` is the TypeScript source line where the function is declared. It is computed by mapping the function's JavaScript start position through the source map using the `FunctionBoundary` directly:

```
// boundary is the FunctionBoundary for this functionId (from boundaryMap)
tsLine = sourceMap.jsToTs(boundary.jsStartLine, boundary.jsStartCol).tsLine
```

If no `FunctionBoundary` is found for the `functionId` (which should not occur in correct usage), fall back to `tsLine = 1`.

The `tsLine` value must always be a positive integer (>= 1). The `SourceMap.jsToTs()` method guarantees this by returning `{ tsLine: 1, tsCol: 0 }` for unmapped positions.

### 3.7 Data Point Sorting

`ComplexityResult.dataPoints` is an array of `[n, opCount]` tuples sorted in ascending order by `n`. This is constructed by:

```
dataPoints = measurements
  .filter(m => m.functionId === targetFunctionId)
  .map(m => [m.n, m.opCount])
  .sort((a, b) => a[0] - b[0])
```

### 3.8 Function Name Resolution

`ComplexityResult.functionName` is copied from `FunctionBoundary.name`. S5 receives `FunctionBoundary[]` as the `functionBoundaries` parameter (see §3.1). During the grouping step (§4.1), S5 builds a `boundaryMap: Map<string, FunctionBoundary>` keyed by `functionId`. For each function result, `functionName = boundaryMap.get(functionId)?.name ?? '<unknown>'`.

`NodeMeta` does not carry a function name — it only carries position and type. The `FunctionBoundary[]` parameter is the sole source of names. No name enrichment of `nodeRegistry` is performed.

## 4. Data Model & Logic

### 4.1 Data Grouping

The first step in `analyzeComplexity` is grouping measurements by `functionId`:

```
groups: Map<string, MeasurementPoint[]> = new Map()

For each measurement in measurements:
  If groups.has(measurement.functionId):
    groups.get(measurement.functionId).push(measurement)
  Else:
    groups.set(measurement.functionId, [measurement])
```

Each group is then processed independently through the OLS fitting pipeline described in Section 3.3.

Additionally, build a lookup from `functionBoundaries`:

```
boundaryMap: Map<string, FunctionBoundary> = new Map()

For each boundary in functionBoundaries:
  boundaryMap.set(boundary.functionId, boundary)
```

### 4.2 Full OLS Derivation

The ordinary least-squares regression without intercept minimizes:

```
L(c) = sum((opCount_i - c * x_i)^2, i=1..k)
```

Taking the derivative with respect to `c` and setting it to zero:

```
dL/dc = -2 * sum(x_i * (opCount_i - c * x_i), i=1..k) = 0
=> sum(x_i * opCount_i) = c * sum(x_i^2)
=> c = sum(x_i * opCount_i) / sum(x_i^2)
```

This is the standard OLS estimator for a one-parameter model through the origin.

### 4.3 Worked Example: bubbleSort (O(n^2))

**Input measurements (5 data points — meets the k >= 5 minimum for classification):**

```
functionId = 'aa11'

Point 1: { functionId: 'aa11', n: 10,   opCount: 121,    nodeCounters: { 'aa11': 1, 'cc33': 10,   'ee55': 100    } }
Point 2: { functionId: 'aa11', n: 30,   opCount: 961,    nodeCounters: { 'aa11': 1, 'cc33': 30,   'ee55': 900    } }
Point 3: { functionId: 'aa11', n: 100,  opCount: 10101,  nodeCounters: { 'aa11': 1, 'cc33': 100,  'ee55': 10000  } }
Point 4: { functionId: 'aa11', n: 300,  opCount: 90301,  nodeCounters: { 'aa11': 1, 'cc33': 300,  'ee55': 90000  } }
Point 5: { functionId: 'aa11', n: 1000, opCount: 1001001, nodeCounters: { 'aa11': 1, 'cc33': 1000, 'ee55': 1000000 } }
```

**OLS for O(n^2): x_i = n_i^2**

```
x values:   [100,       900,       10000,       90000,       1000000       ]
y values:   [121,       961,       10101,       90301,       1001001       ]

Numerator   = sum(x_i * y_i)
            = (100 * 121) + (900 * 961) + (10000 * 10101) + (90000 * 90301) + (1000000 * 1001001)
            = 12100 + 864900 + 101010000 + 8127090000 + 1001001000000
            = 1009229977000

Denominator = sum(x_i^2)
            = 100^2 + 900^2 + 10000^2 + 90000^2 + 1000000^2
            = 10000 + 810000 + 100000000 + 8100000000 + 1000000000000
            = 1008200820000

c = 1009229977000 / 1008200820000 ≈ 1.00102

mean_y = (121 + 961 + 10101 + 90301 + 1001001) / 5 = 220497.0

SS_res ≈ negligible (model fits near-perfectly)
SS_tot = sum((y_i - 220497)^2) ≈ 3.88 × 10^11

R_squared ≈ 0.9999998  (approximately)
```

R-squared is approximately 0.9999998 -- an almost perfect quadratic fit.

**OLS for O(n): x_i = n_i (showing why it is rejected)**

```
x values:  [10,   30,   100,    300,     1000    ]
y values:  [121,  961,  10101,  90301,   1001001 ]

c = sum(x_i * y_i) / sum(x_i^2)
  = (10*121 + 30*961 + 100*10101 + 300*90301 + 1000*1001001)
    / (100 + 900 + 10000 + 90000 + 1000000)
  = (1210 + 28830 + 1010100 + 27090300 + 1001001000) / 1101000
  ≈ 1001001000 / 1101000
  ≈ 909.17

Predicted (n=1000): 909170  vs actual 1001001 — poor fit at large n
SS_res >> SS_res from O(n^2) model

R_squared ≈ 0.926 (above the configured minConfidence, but far below the O(n^2) result)
```

The O(n) model scores ~0.926 -- above the default `minConfidence` threshold but far below the O(n^2) model's 0.9999998. The O(n^2) model wins (step 2: highest R_squared).

**Selected class:** `'O(n^2)'` with confidence approximately 0.9999998.

**Dominant node attribution:**

```
largestPoint = Point 5 (n=1000, opCount=1001001)
nodeCounters = { 'aa11': 1, 'cc33': 1000, 'ee55': 1000000 }
dominantNodeId = 'ee55'   (highest counter value: 1000000)

nodeRegistry.get('ee55') = { nodeId: 'ee55', jsLine: 4, jsCol: 4, ... }
dominantLine = sourceMap.jsToTs(4, 4).tsLine = 3  (inner ForStatement in TS source)
```

**tsLine attribution:**

```
boundary = boundaryMap.get('aa11') = { jsStartLine: 1, jsStartCol: 0, ... }
tsLine = sourceMap.jsToTs(boundary.jsStartLine, boundary.jsStartCol).tsLine
       = sourceMap.jsToTs(1, 0).tsLine = 1
```

**Final ComplexityResult:**

```typescript
{
  functionId:     'aa11',
  functionName:   'bubbleSort',
  tsLine:         1,
  complexity:     'O(n^2)',
  confidence:     0.9999,
  dominantNodeId: 'ee55',
  dominantLine:   3,
  dataPoints:     [[10, 121], [30, 961], [100, 10101], [300, 90301], [1000, 1001001]]
}
```

### 4.4 Edge Case Math: SS_tot = 0

When all `opCount` values are identical (e.g., a perfectly constant function returning the same count at every n):

```
opCount values: [42, 42, 42, 42, 42, 42, 42]
mean_y = 42
SS_tot = sum((42 - 42)^2) = 0
```

**For the O(1) model:**
```
c = mean_y = 42
predicted_i = 42 for all i
SS_res = sum((42 - 42)^2) = 0
R_squared = 1 - (0 / 0)  -- division by zero
```

When `SS_tot = 0`, the O(1) model is a perfect fit (all values are constant). Set `R_squared = 1.0` directly without computing the ratio.

**For all other models (non-O(1)):**
```
SS_res > 0 typically (unless the model also predicts exactly the same values)
R_squared = 1 - (SS_res / 0)  -- division by zero
```

When `SS_tot = 0` and the model is not O(1), `R_squared` is undefined. Clamp to `0.0`. The O(1) model will win with `R_squared = 1.0`.

**Implementation rule for SS_tot = 0:**
```
If SS_tot = 0:
  If this is the O(1) candidate:
    R_squared = 1.0
  Else:
    R_squared = 0.0
```

### 4.5 Processing Functions with TIMEOUT or RUNTIME_ERROR

S5 does not receive `ExecutionResult` directly. The orchestrator converts S4's `timedOut` flag and `errors` array into a `FunctionStatus[]` array (one entry per function boundary) before calling `analyzeComplexity`. `FunctionStatus` is defined in `interface-contracts` and imported from there.

The orchestrator's construction algorithm (see extension-orchestrator §4.6) assigns:
- `status: 'timeout'` if the worker timed out and no `MeasurementPoint` was collected for that functionId.
- `status: 'runtime_error'` if `ExecutionResult.errors` contains an entry for that functionId and no measurement was collected.
- `status: 'ok'` otherwise.

S5's processing rules:
- `status === 'timeout'`: emit `complexity: 'TIMEOUT'`, `confidence: 0`, `dominantNodeId: ''`, `dominantLine: 0`, `dataPoints: []` (or partial measurements if some sizes completed before the kill).
- `status === 'runtime_error'`: emit `complexity: 'RUNTIME_ERROR'`, `confidence: 0`, `dominantNodeId: ''`, `dominantLine: 0`, `dataPoints: []`.
- `status === 'ok'`: proceed with normal OLS fitting (§3.3–3.7).

## 5. Edge Cases & Error Handling

### 5.1 Function with 0 data points (all InputSets errored or all timed out)

**Trigger:** `measurements` contains no entries for a given `functionId`, but `functionBoundaries` includes the function.

**Behavior:** The function still receives a `ComplexityResult`.

**Output:**
```typescript
{
  functionId:     '<the functionId>',
  functionName:   '<from FunctionBoundary.name>',
  tsLine:         sourceMap.jsToTs(boundary.jsStartLine, boundary.jsStartCol).tsLine,
  complexity:     'INSUFFICIENT_DATA',
  confidence:     0,
  dominantNodeId: '',
  dominantLine:   0,
  dataPoints:     []
}
```

Note: `dominantLine` is `0` (not `tsLine`) because there is no dominant node to attribute.

### 5.2 Function with 1-4 data points

**Trigger:** Between 1 and 4 `MeasurementPoint` entries exist for a `functionId`.

**Behavior:** Regardless of how high R-squared might be for any candidate model, the data is insufficient for reliable classification.

**Output:**
```typescript
{
  functionId:     '<the functionId>',
  functionName:   '<from FunctionBoundary.name>',
  tsLine:         sourceMap.jsToTs(boundary.jsStartLine, boundary.jsStartCol).tsLine,
  complexity:     'INSUFFICIENT_DATA',
  confidence:     0,
  dominantNodeId: '',
  dominantLine:   0,
  dataPoints:     [[n1, opCount1], [n2, opCount2], ...]  // whatever was collected, sorted by n
}
```

### 5.3 All R-squared values below 0.92 (with 5+ data points)

**Trigger:** All seven candidate models produce R-squared below the configured `minConfidence` value.

**Behavior:** No model fits the data well enough. The best available R-squared is still reported.

**Output:**
```typescript
{
  functionId:     '<the functionId>',
  functionName:   '<from FunctionBoundary.name>',
  tsLine:         sourceMap.jsToTs(boundary.jsStartLine, boundary.jsStartCol).tsLine,
  complexity:     'LOW_CONFIDENCE',
  confidence:     0.87,     // example: the highest R_squared among all candidates
  dominantNodeId: '<the nodeId with highest count at largest n>',
  dominantLine:   sourceMap.jsToTs(dominantMeta.jsLine, dominantMeta.jsCol).tsLine,
  dataPoints:     [[10, y1], [30, y2], ...]   // all data points sorted by n
}
```

### 5.4 SS_tot = 0 (all opCount values identical -- perfectly constant function)

**Trigger:** Every measurement point for a function has the exact same `opCount` value (e.g., all zeros from an empty function, or all identical counts from a fixed-iteration function).

**Behavior:**
- O(1) candidate: `R_squared = 1.0` (perfect fit -- the data is constant).
- All other candidates: `R_squared = 0.0` (division `SS_res / SS_tot` is undefined; clamped to 0.0).

**Output:** `complexity: 'O(1)'`, `confidence: 1.0` (assuming 5+ data points).

### 5.5 Function timed out (S4 timedOut = true)

**Trigger:** S4 reports that the function exceeded the 5-second execution limit.

**Behavior:** The orchestrator passes `status: 'timeout'` in `functionStatuses`.

**Output:**
```typescript
{
  functionId:     '<the functionId>',
  functionName:   '<from FunctionBoundary.name>',
  tsLine:         sourceMap.jsToTs(boundary.jsStartLine, boundary.jsStartCol).tsLine,
  complexity:     'TIMEOUT',
  confidence:     0,
  dominantNodeId: '',
  dominantLine:   0,
  dataPoints:     []    // or partial data if some sizes completed before timeout
}
```

### 5.6 Function had RUNTIME_ERROR in S4

**Trigger:** S4 reports an `ExecutionError` for the function.

**Behavior:** The orchestrator passes `status: 'runtime_error'` in `functionStatuses`.

**Output:**
```typescript
{
  functionId:     '<the functionId>',
  functionName:   '<from FunctionBoundary.name>',
  tsLine:         sourceMap.jsToTs(boundary.jsStartLine, boundary.jsStartCol).tsLine,
  complexity:     'RUNTIME_ERROR',
  confidence:     0,
  dominantNodeId: '',
  dominantLine:   0,
  dataPoints:     []
}
```

### 5.7 dominantNodeId not found in nodeRegistry

**Trigger:** The `nodeId` with the highest counter value in `largestPoint.nodeCounters` does not exist as a key in `nodeRegistry`. This should not happen in normal operation (it would indicate a bug in S2 or S4), but the code must handle it.

**Behavior:** Fall back to the function entry counter's nodeId (which is the `functionId` itself).

**Output fields affected:**
```
dominantNodeId = functionId
dominantLine   = tsLine   // the function declaration's TS line
```

## 6. Dependencies

### Upstream (this component depends on)

| Component | Interface consumed | Data received |
|-----------|-------------------|---------------|
| **s4-runtime-executor** | `MeasurementPoint[]` | Raw `(functionId, n, opCount, nodeCounters)` data points; one per function-per-input-size that completed. S5 does not consume `ExecutionError` directly; the orchestrator converts S4's execution errors into `FunctionStatus[]` entries before calling S5. |
| **s2-ast-instrumenter** | `Map<string, NodeMeta>` (nodeRegistry), `FunctionBoundary[]` | Node metadata for dominant-node attribution and source-line mapping. Function boundaries for name resolution and JS start line. |
| **s1-compiler-bridge** | `SourceMap` | `jsToTs(jsLine, jsCol)` for converting JS positions to TS positions. |
| **interface-contracts** | Type imports | `MeasurementPoint`, `ComplexityResult`, `ComplexityClass`, `NodeMeta`, `SourceMap`, `FunctionBoundary`, `FunctionStatus` (not `ExecutionError` — that type is consumed by the orchestrator, not by S5) |

### Downstream (components that depend on this)

| Component | Interface consumed | Data received |
|-----------|-------------------|---------------|
| **s6-annotation-engine** | `ComplexityResult[]` | One `ComplexityResult` per analyzed function. S6 reads `tsLine`, `complexity`, `confidence`, `functionName`, `dominantLine`, and `dataPoints` to render inline decorations, diagnostics, and the WebView chart. |
| **extension-orchestrator** | `ComplexityResult[]` | The orchestrator passes results to S6 and may log or cache them. |

### External Dependencies

**None.** S5 implements OLS regression using basic arithmetic operations (`+`, `*`, `/`, `Math.log2`, `Math.pow`, `Math.max`, `Math.min`). No external math library (e.g., mathjs, simple-statistics) is required or permitted. This keeps the extension bundle size minimal and eliminates a third-party dependency surface.

## 7. Configuration

| Key | Type | Default | Valid Range | Effect |
|-----|------|---------|-------------|--------|
| `tsComplexity.minConfidence` | `number` | `0.92` | `[0.5, 1.0]` | The R-squared threshold below which a classification is demoted to `LOW_CONFIDENCE`. Lowering this value makes the analyzer more permissive (accepts weaker fits as valid classifications). Raising it makes the analyzer stricter (requires stronger fits). Values below 0.5 are rejected because they would accept models that explain less than half the variance. |
| `tsComplexity.inputSizes` | `number[]` | `[10, 30, 100, 300, 1000, 3000, 10000]` | Each element > 0, array length >= 5 | Configured in S3 (Input Generator), but affects S5 indirectly: the number of data points available for curve fitting equals the number of input sizes that complete execution. The 5-point minimum for `INSUFFICIENT_DATA` is derived from `inputSizes.length` but hardcoded as `5` for v1 to avoid coupling S5's threshold to S3's configuration at runtime. |

**Note on `tsComplexity.inputSizes`:** This value is not read by S5 directly. S5 only observes its effect through the number of `MeasurementPoint` entries it receives. The minimum data point threshold (5) is a constant within S5, not dynamically derived from this configuration.

**Constants internal to S5 (not user-configurable in v1):**

| Constant | Value | Purpose |
|----------|-------|---------|
| `MIN_DATA_POINTS` | `5` | Minimum measurement points required for classification. Below this, result is `INSUFFICIENT_DATA`. |
| `EXP_CAP_N` | `30` | Maximum `n` value used when fitting the O(2^n) model. Points with `n > 30` are excluded from the exponential fit. |
| `EXP_MIN_POINTS` | `5` | Minimum filtered data points required to attempt the O(2^n) fit. If fewer than 5 points remain after capping at `n <= 30`, the O(2^n) candidate is skipped. |

## 8. Acceptance Criteria

### Functional Criteria

- [ ] **AC-1: O(n^2) classification.** Given 7 data points from a standard bubble sort implementation (opCount grows as approximately n^2/2 + n/2), `analyzeComplexity` returns `complexity: 'O(n^2)'` with `confidence > 0.98`.
- [ ] **AC-2: O(log n) classification.** Given 7 data points from a standard binary search implementation (opCount grows as approximately log_2(n)), `analyzeComplexity` returns `complexity: 'O(log n)'` with `confidence > 0.95`.
- [ ] **AC-3: O(n) classification.** Given 7 data points from a standard linear scan (opCount grows as approximately n), `analyzeComplexity` returns `complexity: 'O(n)'` with `confidence > 0.97`.
- [ ] **AC-4: O(n log n) classification.** Given 7 data points from a standard merge sort implementation (opCount grows as approximately n * log_2(n)), `analyzeComplexity` returns `complexity: 'O(n log n)'` with `confidence > 0.94`.
- [ ] **AC-5: O(1) classification.** Given 7 data points from a constant-time function (opCount is the same value for all n), `analyzeComplexity` returns `complexity: 'O(1)'` with `confidence > 0.99`.
- [ ] **AC-6: INSUFFICIENT_DATA for fewer than 5 points.** Given 4 data points with R-squared > 0.99 for the O(n) model, `analyzeComplexity` returns `complexity: 'INSUFFICIENT_DATA'` and `confidence: 0`.

### Dominant Node and Source Attribution Criteria

- [ ] **AC-7: dominantNodeId validity.** For every `ComplexityResult` where `dominantNodeId !== ''`, the value of `dominantNodeId` is a key present in `nodeRegistry`.
- [ ] **AC-8: dataPoints sorting.** For every `ComplexityResult`, `dataPoints` is sorted in ascending order by the first element (n). Formally: for all `i` in `0..dataPoints.length-2`, `dataPoints[i][0] < dataPoints[i+1][0]`.
- [ ] **AC-9: confidence clamping.** For every `ComplexityResult`, `0.0 <= confidence <= 1.0`. The value is never negative, never greater than 1.0, and never `NaN`.
- [ ] **AC-10: tsLine validity.** For every `ComplexityResult`, `tsLine >= 1`. The value is never 0, never negative, and never `undefined` or `NaN`.

### Edge Case Criteria

- [ ] **AC-11: SS_tot = 0 produces O(1).** Given 7 data points where all `opCount` values are `42`, `analyzeComplexity` returns `complexity: 'O(1)'` with `confidence: 1.0`.
- [ ] **AC-12: TIMEOUT propagation.** Given a function with `status: 'timeout'` in `functionStatuses`, `analyzeComplexity` returns `complexity: 'TIMEOUT'`, `confidence: 0`, `dominantNodeId: ''`, `dominantLine: 0`. Additionally assert `result.dataPoints` contains the measurements collected before the timeout fired (may be non-empty if some input sizes completed before the kill).
- [ ] **AC-13: RUNTIME_ERROR propagation.** Given a function with `status: 'runtime_error'` in `functionStatuses`, `analyzeComplexity` returns `complexity: 'RUNTIME_ERROR'`, `confidence: 0`, `dominantNodeId: ''`, `dominantLine: 0`.
- [ ] **AC-14: O(2^n) cap enforcement.** Given 7 data points at n = [10, 30, 100, 300, 1000, 3000, 10000] from a function where `opCount = 2^n` (exponential growth), when `analyzeComplexity` is called: (a) the O(2^n) candidate is skipped because only n=10 and n=30 qualify (both satisfy n ≤ 30 inclusive; n=100 does not satisfy n ≤ 30), giving 2 eligible points — fewer than the EXP_MIN_POINTS=5 threshold required to fit the O(2^n) model; (b) the returned `complexity` is `'LOW_CONFIDENCE'` because no remaining model fits the exponential data above the configured `minConfidence` value; (c) `confidence` is the highest R_squared among the six remaining candidates.

### Performance Criteria

- [ ] **AC-15: Per-function fitting time.** For a single function with 7 data points, `analyzeComplexity` completes in under 20ms (target) and under 100ms (hard limit), measured on a standard development machine (4-core, 2.5 GHz, Node.js 18+).
