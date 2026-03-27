# Test Fixtures

> **Status**: APPROVED
> **Author**: architect
> **Created**: 2026-03-27
> **Priority**: MVP
> **Layer**: 1 (Foundation)

## 1. Overview

`test-fixtures` is a set of eight TypeScript source files located under `src/test/fixtures/` that serve as the ground-truth inputs for the integration test suite. Each file exercises a distinct path through the S1-S6 pipeline: five files cover the five major complexity classes (O(1), O(log n), O(n), O(n log n), O(n^2)), and three files cover error and edge-case paths (infinite loop / timeout, file with no functions, file with a type error). The integration tests (owned by Agent 7) run the full pipeline on each fixture and assert that the resulting `ComplexityResult` matches the expected complexity class within a specified R-squared threshold. These fixtures are the acceptance criteria for the entire extension made concrete -- if the pipeline cannot correctly classify these eight files, the extension does not work.

## 2. User Value

These fixtures exist to guarantee that the complexity annotations a developer sees in their editor are correct. Each fixture represents a real-world pattern a user would encounter:

- **Bubble sort** is the canonical O(n^2) nested loop that the extension must flag with a warning. If the pipeline mis-classifies this as O(n), the user loses trust in every annotation.
- **Binary search** is the canonical O(log n) algorithm. Correct classification here proves the pipeline can distinguish logarithmic from linear growth -- a distinction that matters for performance-critical code paths.
- **Linear scan** is the simplest loop-based function. Correct classification validates the baseline O(n) model and ensures the pipeline does not over-fit (it must not report O(n log n) for a simple scan).
- **Merge sort** is the hardest classification: O(n log n) sits close to O(n) for small n, and the pipeline must produce enough data points across the input sizes [10, 30, 100, 300, 1000, 3000, 10000] to separate the two. If this fixture fails, the risk register item "curve fitter misclassifies O(n log n) as O(n)" has materialized.
- **Constant-time functions** test that functions with no loops and no recursion are not falsely classified as growing.
- **Infinite loop** tests that the 5-second worker timeout fires and the user sees a `TIMEOUT` decoration rather than a hung editor.
- **No functions** tests that a file containing only types, interfaces, and constants produces no annotations and does not crash the pipeline.
- **Compiler error** tests that a file with a TypeScript type error still produces diagnostics surfaced in the Problems panel, without the pipeline throwing an unhandled `CompilerBridgeError`.

Without these fixtures, the integration tests have nothing to assert against, and the extension ships with zero empirical validation.

## 3. Detailed Design

### 3.1 File Inventory

Eight `.ts` files under `src/test/fixtures/`. Each file is a standalone TypeScript module with `export` declarations. No file imports from any other fixture or from any extension subsystem -- they are pure TypeScript source that the S1 compiler bridge can process in isolation.

### 3.2 Fixture Files

#### 3.2.1 `bubble_sort.ts` -- O(n^2)

```typescript
// Expected: bubbleSort -> O(n^2), R^2 > 0.98
export function bubbleSort(arr: number[]): number[] {
  const result = [...arr];
  for (let i = 0; i < result.length; i++) {
    for (let j = 0; j < result.length - 1; j++) {
      if (result[j] > result[j + 1]) {
        const tmp = result[j];
        result[j] = result[j + 1];
        result[j + 1] = tmp;
      }
    }
  }
  return result;
}
```

**Design rationale**: Two nested `for` loops over the full array length produce counter increments proportional to n^2. The outer loop runs n times, the inner loop runs n-1 times per outer iteration. The `__op()` counter placed at the top of each loop body will record approximately n*(n-1) increments. Spread arr (`[...arr]`) is used to avoid mutating the input, which keeps the function pure and re-runnable across input sizes.

The R^2 threshold of 0.98 is intentionally high because the n^2 signal is unambiguous: there is no competing model that fits a perfect double-nested loop better than the quadratic model.

#### 3.2.2 `binary_search.ts` -- O(log n)

```typescript
// Expected: binarySearch -> O(log n), R^2 > 0.95
export function binarySearch(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (arr[mid] === target) return mid;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
```

**Design rationale**: The `while` loop halves the search space each iteration, producing counter increments proportional to log_2(n). The `target` parameter is a scalar (`number`), which per the S3 multi-parameter growth decision receives a fixed mid-range value -- only the `arr` parameter (the first `T[]`) grows with n. The S3 generator will produce sorted arrays so the binary search actually executes its loop (an unsorted array would produce wrong results but similar counter growth since the loop still runs log_2(n) iterations before terminating).

The R^2 threshold of 0.95 is lower than the quadratic fixture because logarithmic curves are harder to fit precisely: at small n (10, 30), log_2(10) = 3.3 and log_2(30) = 4.9 differ by less than 2, which introduces noise in the low-n data points.

#### 3.2.3 `linear_scan.ts` -- O(n)

```typescript
// Expected: linearScan -> O(n), R^2 > 0.97
export function linearScan(arr: number[], target: number): number {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === target) return i;
  }
  return -1;
}
```

**Design rationale**: A single `for` loop that scans every element. The `target` parameter receives a value that does not appear in the array (per S3 generation: it produces arrays of sequential numbers and sets target to a value outside the range). This forces the loop to run all n iterations rather than short-circuiting, which is essential for a clean O(n) signal. Without this guarantee, the function would sometimes return at index 0 (O(1)) and sometimes at index n-1 (O(n)), producing noisy measurements.

The R^2 threshold of 0.97 reflects that a single loop over n elements produces an almost-perfect linear signal.

#### 3.2.4 `merge_sort.ts` -- O(n log n)

```typescript
// Expected: mergeSort -> O(n log n), R^2 > 0.94
export function mergeSort(arr: number[]): number[] {
  const n = arr.length;
  const result = [...arr];
  for (let width = 1; width < n; width *= 2) {
    for (let i = 0; i < n; i += 2 * width) {
      const lo = i;
      const mid = Math.min(i + width, n);
      const hi = Math.min(i + 2 * width, n);
      merge(result, lo, mid, hi);
    }
  }
  return result;
}

function merge(arr: number[], lo: number, mid: number, hi: number): void {
  const left = arr.slice(lo, mid);
  const right = arr.slice(mid, hi);
  let i = 0, j = 0, k = lo;
  while (i < left.length && j < right.length) {
    if (left[i] <= right[j]) arr[k++] = left[i++];
    else arr[k++] = right[j++];
  }
  while (i < left.length) arr[k++] = left[i++];
  while (j < right.length) arr[k++] = right[j++];
}
```

**Why iterative (bottom-up) instead of recursive**: Recursive merge sort using standard TypeScript recursion would work correctly, but the iterative version is preferred for three reasons:

1. **Cleaner instrumentation signal**: The outer loop over `width` runs log_2(n) times. The inner loop over `i` runs n/(2*width) times per outer iteration. The `merge` helper's `while` loop runs proportional to the subarray size. Together, the instrumented counters accumulate approximately n * log_2(n) increments -- a clean signal for the S5 fitter.

2. **No deep recursion issues**: At n=10000 (the largest input size), recursive merge sort would produce a call stack ~14 levels deep. This is not a stack overflow risk, but the S2 instrumenter's recursive-call-site counter would fire at each recursion level, producing a counter pattern that mixes recursion-entry counts with loop-body counts. The iterative version keeps all growth in loop counters, which the S5 fitter is designed for.

3. **Generator function avoidance**: The `merge` helper is a plain function, not a generator. S2 does not instrument generator functions in v1.

The R^2 threshold of 0.94 is the lowest of all classified fixtures because O(n log n) is the hardest model to distinguish from O(n). At small n, n*log_2(n) and c*n are nearly collinear. The seven input sizes [10, 30, 100, 300, 1000, 3000, 10000] provide enough spread (10*3.3=33 vs 10000*13.3=133000) for the fitter to separate the models, but some noise is expected.

#### 3.2.5 `constant.ts` -- O(1)

```typescript
// Expected: getFirst -> O(1), R^2 > 0.99
export function getFirst(arr: number[]): number {
  return arr[0] ?? -1;
}

// Expected: identityAdd -> O(1), R^2 > 0.99
export function identityAdd(a: number, b: number): number {
  return a + b;
}
```

**Why two functions in one file**: This file tests two aspects simultaneously:

1. **Multi-function detection**: The pipeline must discover and independently classify both `getFirst` and `identityAdd`. If S2 only reports the first function boundary, or S5 merges their measurements, this fixture catches the bug.

2. **Non-collection parameter handling**: `getFirst` takes a `number[]` -- the standard case where S3 grows the array size with n. `identityAdd` takes two `number` parameters with no array. Per the S3 multi-parameter growth decision, scalar parameters receive a fixed mid-range value. Since `identityAdd` has no collection parameter at all, S3 must still generate inputs at the seven n-values but with fixed scalar arguments for both `a` and `b`. The resulting counter should be constant (just the function-entry counter fires once per call), producing a flat O(1) curve.

The R^2 threshold of 0.99 is the highest because a constant function produces identical counter values across all n-values. The only variance is floating-point noise in the regression, which is negligible.

#### 3.2.6 `infinite_loop.ts` -- TIMEOUT

```typescript
// Expected: infiniteLoop -> TIMEOUT (worker killed after 5s)
export function infiniteLoop(arr: number[]): number {
  let i = 0;
  while (true) {
    i++;
  }
  return i; // unreachable -- suppresses TS error
}
```

**Why `while(true)`**: The S4 timeout test requires a function that never terminates. Using `while(true)` is the simplest guarantee -- there is no condition under which this loop exits. The `return i` statement after the loop is unreachable at runtime but is necessary to suppress the TypeScript compiler error "function lacks ending return statement." Without it, `ts.transpileModule()` would emit a diagnostic that is not relevant to what this fixture tests (timeout behavior, not compiler diagnostics).

**Why `arr: number[]` parameter**: The function must accept an array parameter so that S3's input generator treats it like any other function. S3 generates arrays at sizes [10, 30, ...] and calls the function. The worker will be killed at 5 seconds (the S4 hard timeout) during the first input size (n=10), since the function never returns.

#### 3.2.7 `no_functions.ts` -- Empty Result

```typescript
// Expected: pipeline exits after S2 with empty FunctionBoundary[] -- no decorations, no crash
export type Point = { x: number; y: number };
export interface Shape {
  area(): number;
}
export const PI = 3.14159;
```

**Design rationale**: This file contains valid TypeScript with zero function declarations, arrow functions, or method definitions (the `area(): number` inside `Shape` is an interface method signature, not a function body). S1 compiles it successfully. S2 parses the resulting JS and finds no function bodies to instrument, producing an empty `FunctionBoundary[]`. The pipeline must handle this gracefully: S3 receives an empty array and produces no `InputSet[]`, S4 is never invoked, S5 receives no measurements, and S6 renders no decorations.

The critical assertion is: **no crash, no unhandled exception, no spurious decoration**. This tests the "nothing to analyze" path that occurs when a user saves a file containing only types and constants.

#### 3.2.8 `compiler_error.ts` -- Diagnostics Path

```typescript
// Expected: S1 returns diagnostics[], CompilerBridgeError NOT thrown (pipeline continues)
// S2 receives whatever partial JS was produced; S6 shows compiler diagnostic in Problems panel
export function badFunction(x: number): string {
  return x + 1; // type error: number is not assignable to string
  const unreachable = "this code has a type error above";
}
```

**Why a type error (not a syntax error)**: A syntax error (e.g., `function foo( {`) would cause `ts.transpileModule()` to produce empty or malformed JavaScript -- then S2 receives an unparseable string and the pipeline fails at S2, not S1. A type error is more realistic and more useful:

1. **Realistic**: Developers frequently save files with type errors (e.g., during refactoring). The extension must not crash or produce confusing behavior when this happens.
2. **`ts.transpileModule()` behavior with type errors**: TypeScript's `transpileModule` performs type erasure without full type checking. It will emit valid JavaScript even when there are type errors (it strips types and emits the runtime-equivalent code). The `diagnostics` array in the S1 output will contain the type error, but `compiledJs` will contain runnable JavaScript.
3. **Tests the diagnostics pipeline**: S1 must populate its `diagnostics[]` output. S6 must surface those diagnostics in the VS Code Problems panel. The integration test asserts that diagnostics are present and that no `CompilerBridgeError` is thrown.

**The `unreachable` variable**: The `const unreachable` line exists to make the function body multi-statement, ensuring S2 has a meaningful function body to instrument. If the function were a single `return` statement, S2 would still produce a valid `FunctionBoundary`, but the test would not exercise multi-statement instrumentation.

### 3.3 File Location and Naming Convention

All fixtures are located at `src/test/fixtures/<name>.ts`. The names use snake_case to match the algorithm or scenario they represent. This directory is not included in the extension's compiled output -- it is only consumed by the test suite.

## 4. Data Model & Logic

### 4.1 Fixture Contract Table

Each fixture defines a contract: given this source file, the full S1-S6 pipeline must produce a `ComplexityResult` matching these expectations.

S2 instruments **all function declarations** encountered during the AST walk, regardless of whether they are exported. Non-exported, file-scoped helper functions (such as the `merge` helper in `merge_sort.ts`) will appear as separate entries in `InstrumentResult.functionBoundaries`. This is consistent with the `interface-contracts.md` `InstrumentResult` definition which states "one entry per non-generator function detected during the AST walk."

| Fixture File | Function Name | Expected `ComplexityClass` | R^2 Threshold | Expected `diagnostics` |
|---|---|---|---|---|
| `bubble_sort.ts` | `bubbleSort` | `'O(n^2)'` | > 0.98 | `[]` |
| `binary_search.ts` | `binarySearch` | `'O(log n)'` | > 0.95 | `[]` |
| `linear_scan.ts` | `linearScan` | `'O(n)'` | > 0.97 | `[]` |
| `merge_sort.ts` | `mergeSort` | `'O(n log n)'` | > 0.94 | `[]` |
| `merge_sort.ts` | `merge` | `'O(n)'` | > 0.90 | `[]` |

> **Note on `merge` helper**: The `merge` helper will be instrumented and classified separately from `mergeSort`. Integration tests should assert on both functions. `merge` receives a growing array slice and two fixed indices, producing a linear measurement.

| `constant.ts` | `getFirst` | `'O(1)'` | > 0.99 | `[]` |
| `constant.ts` | `identityAdd` | `'O(1)'` | > 0.99 | `[]` |
| `infinite_loop.ts` | `infiniteLoop` | `'TIMEOUT'` | confidence not asserted (TIMEOUT has no regression) | `[]` |
| `no_functions.ts` | (none) | (none) | no ComplexityResult emitted | `[]` |
| `compiler_error.ts` | `badFunction` | `'O(1)'` | confidence not asserted (any value ≥ 0.0 acceptable) | `length >= 1` |

> **Note on `badFunction`**: `ts.transpileModule()` emits valid JS for type errors; `badFunction` contains no loops or recursion, so it classifies as O(1). The test asserts `complexity === 'O(1)'` AND `diagnostics.length >= 1` (a TSDiagnostic for the type error).

### 4.2 How Integration Tests Consume the Fixtures

Each integration test follows this sequence:

1. **Read**: Load the fixture file from `src/test/fixtures/<name>.ts` as a string.
2. **S1**: Pass the source string to the Compiler Bridge. Receive `{ compiledJs, sourceMap, diagnostics }`.
3. **S2**: Pass `compiledJs` to the AST Instrumenter. Receive `{ instrumentedJs, nodeRegistry, functionBoundaries }`.
4. **S3**: Call `generateInputs(functionBoundaries, sourceMap, filePath)` — passing the `sourceMap` from Step 2 (`CompilerBridgeResult.sourceMap`) and the `filePath` of the source file. S3 requires the `sourceMap` to resolve TypeScript type positions for each `FunctionBoundary`. Receive `InputSet[]` per function.
5. **S4**: Pass `instrumentedJs` and `InputSet[]` to the Runtime Executor. Receive `MeasurementPoint[]` per function (or a timeout signal).
6. **S5**: Pass `MeasurementPoint[]` to the Complexity Analyzer. Receive `ComplexityResult[]`.
7. **Assert**: Compare each `ComplexityResult` against the fixture contract table.

For `no_functions.ts`, the test asserts that `functionBoundaries` is an empty array after S2 and that no subsequent stage throws.

For `compiler_error.ts`, the test asserts that `diagnostics.length >= 1` after S1 and that the pipeline does not throw a `CompilerBridgeError`.

For `infinite_loop.ts`, the test asserts that S4 returns a timeout signal and that `ComplexityResult.complexity` is `'TIMEOUT'`.

### 4.3 Worked Example: bubble_sort.ts Through the Pipeline

**S1**: `ts.transpileModule()` strips the TypeScript type annotations from `arr: number[]` and `number[]` return type, producing plain JavaScript. The `export` keyword becomes a CommonJS `exports.bubbleSort = ...` or stays as ESM depending on the target config. `diagnostics` is empty (no type errors).

**S2**: Acorn parses the JS. The instrumenter finds:
- One `FunctionDeclaration` named `bubbleSort` -- injects `__op('fn-entry-hash1')` at the function entry
- One outer `ForStatement` (the `i` loop) -- injects `__op('loop-hash2')` at the top of its body
- One inner `ForStatement` (the `j` loop) -- injects `__op('loop-hash3')` at the top of its body

Result: `functionBoundaries = [{ functionId: 'hash1', name: 'bubbleSort', ... paramTypes: ['number[]'] }]`

> **(paramTypes shown post-S3 enrichment — S2 emits paramTypes: [] which S3 populates)**

**S3**: Sees `paramTypes: ['number[]']`. Generates arrays of size [10, 30, 100, 300, 1000, 3000, 10000]. Each array is filled with random numbers (seeded deterministically). Produces 7 `InputSet` objects.

**S4**: Runs the instrumented code in a worker thread 7 times (one per input size). The `__op()` counter increments:
- At n=10: fn-entry fires 1 time, outer loop fires 10 times, inner loop fires 10*9 = 90 times. Total opCount approximately 101.
- At n=100: fn-entry 1, outer 100, inner 100*99 = 9900. Total approximately 10001.
- At n=10000: fn-entry 1, outer 10000, inner 10000*9999 = 99990000. Total approximately 100000001.

Result: 7 `MeasurementPoint` objects with `{ n, opCount }` pairs showing quadratic growth.

**S5**: Fits the 7 data points against all 7 models. The quadratic model `f(n) = c * n^2` achieves R^2 > 0.99 (the dominant term is the inner loop counter). The linear model achieves R^2 approximately 0.7 (poor fit). The fitter selects `'O(n^2)'` as the best model.

Result: `ComplexityResult = { functionId: 'hash1', complexity: 'O(n^2)', confidence: 0.99, ... }`

**Integration test assertion**: `result.complexity === 'O(n^2)'` and `result.confidence > 0.98`. PASS.

## 5. Edge Cases & Error Handling

### 5.1 merge_sort.ts Misclassified as O(n)

**Scenario**: The S5 fitter selects `'O(n)'` instead of `'O(n log n)'` for `mergeSort`.
**Input condition**: The R^2 for the linear model is higher than for the n*log(n) model, likely because the input sizes do not provide enough spread to separate the two curves.
**Expected behavior**: The integration test for `merge_sort.ts` fails with an assertion error: `Expected complexity to be 'O(n log n)' but got 'O(n)'`.
**System state**: This is a regression in S5 (the fitter) or S4 (not enough measurement points). The developer must investigate the fitting algorithm or the input sizes used by S3.
**Why this matters**: The risk register explicitly calls out "curve fitter misclassifies O(n log n) as O(n)" as a design risk. This fixture is the tripwire that detects it.

### 5.2 infinite_loop.ts Never Times Out

**Scenario**: The S4 worker does not enforce the 5-second timeout, and the function runs indefinitely.
**Input condition**: A bug in S4's timeout enforcement -- the `setTimeout` / `worker.terminate()` logic does not fire.
**Expected behavior**: The integration test has its own hard timeout at 8 seconds (the pipeline hard limit from the performance targets). If S4 does not return within 8 seconds, the test framework kills the test and reports a timeout failure.
**System state**: The test fails loudly. The developer must fix S4's timeout enforcement.
**Error surfaced**: Test framework timeout error (e.g., Mocha's `Error: Timeout of 8000ms exceeded`).

### 5.3 compiler_error.ts Throws CompilerBridgeError

**Scenario**: S1 throws a `CompilerBridgeError` instead of returning diagnostics when processing a file with a type error.
**Input condition**: A bug in S1 where type diagnostics are treated as fatal errors rather than non-fatal warnings.
**Expected behavior**: The integration test catches the thrown error and fails with: `Expected S1 to return diagnostics without throwing, but CompilerBridgeError was thrown`.
**System state**: The test fails. The developer must fix S1 to treat type errors as non-fatal (TypeScript's `transpileModule` emits JS even with type errors; S1 should not throw).

### 5.4 no_functions.ts Produces Spurious FunctionBoundaries

**Scenario**: S2 incorrectly identifies the `area(): number` interface method signature as a function body and produces a `FunctionBoundary` for it.
**Input condition**: S2's Acorn AST walker does not correctly distinguish between interface method signatures (which are erased by S1 and do not appear in the JS output) and actual function declarations.
**Expected behavior**: The integration test asserts `functionBoundaries.length === 0`. If S2 produces any boundaries, the test fails with: `Expected 0 function boundaries but got N`.
**System state**: The test fails. The developer must review S2's function-detection logic. Since `ts.transpileModule()` erases interfaces, the compiled JS should contain no function-like nodes from the interface declaration. If S2 produces boundaries, it is parsing something unexpected in the JS output.

### 5.5 constant.ts identityAdd Classified as Non-Constant

**Scenario**: S3 incorrectly grows one of `identityAdd`'s scalar parameters with n instead of keeping it fixed, causing the opCount to appear to grow.
**Input condition**: S3's parameter-type inspection does not correctly identify that `identityAdd(a: number, b: number)` has no collection parameters, and incorrectly varies one or both scalars proportionally to n.
**Expected behavior**: The integration test for `identityAdd` asserts `complexity === 'O(1)'`. If the result is `'O(n)'` or any non-constant class, the test fails.
**System state**: The test fails. The developer must fix S3's parameter classification to correctly apply the "first array/collection only" growth rule: no collection parameter means no growth dimension, all scalars are fixed.

### 5.6 Fixture File Not Found at Test Time

**Scenario**: A fixture file is missing, renamed, or not included in the test build.
**Input condition**: The integration test attempts to read `src/test/fixtures/bubble_sort.ts` and the file does not exist.
**Expected behavior**: The test fails immediately with a file-system error (e.g., `ENOENT: no such file or directory`). The error message includes the expected file path.
**System state**: The test suite reports the missing file. The developer must ensure fixture files are present in the build output or are read from the source tree.

## 6. Dependencies

### Upstream (this component depends on):

None. The fixture files are standalone TypeScript source code with no imports from the extension codebase or from each other. They are leaf nodes in the dependency graph.

### Downstream (components that depend on this):

- **extension-orchestrator** (Agent 7 integration tests): The integration test suite reads each fixture file as input to the full S1-S6 pipeline. The test assertions reference the fixture contract table defined in this spec. If a fixture file changes, the corresponding integration test assertions must be updated.

### External Dependencies:

None. The fixture files use only built-in TypeScript/JavaScript language features (`Array`, `Math.floor`, `while`, `for`, `export`, `type`, `interface`, `const`). No third-party library imports.

### Cross-Reference Note:

The `extension-orchestrator` spec (when written) must list `test-fixtures` in its Dependencies section as an upstream dependency for the integration test suite.

## 7. Configuration

No configuration values. The fixture files are static TypeScript source and accept no parameters, environment variables, or feature flags.

File paths are hardcoded in the integration test suite relative to the extension root:

| Fixture | Path (relative to extension root) |
|---|---|
| bubble_sort.ts | `src/test/fixtures/bubble_sort.ts` |
| binary_search.ts | `src/test/fixtures/binary_search.ts` |
| linear_scan.ts | `src/test/fixtures/linear_scan.ts` |
| merge_sort.ts | `src/test/fixtures/merge_sort.ts` |
| constant.ts | `src/test/fixtures/constant.ts` |
| infinite_loop.ts | `src/test/fixtures/infinite_loop.ts` |
| no_functions.ts | `src/test/fixtures/no_functions.ts` |
| compiler_error.ts | `src/test/fixtures/compiler_error.ts` |

If the fixture directory is relocated, the integration test file paths must be updated to match.

## 8. Acceptance Criteria

### Functional Criteria

- [ ] All 8 fixture files exist at `src/test/fixtures/<name>.ts` with the exact filenames listed in Section 3.2.
- [ ] `bubble_sort.ts` contains a single exported function `bubbleSort` that, when run through the full S1-S6 pipeline, produces a `ComplexityResult` with `complexity === 'O(n^2)'` and `confidence > 0.98`.
- [ ] `binary_search.ts` contains a single exported function `binarySearch` that produces `complexity === 'O(log n)'` and `confidence > 0.95`.
- [ ] `linear_scan.ts` contains a single exported function `linearScan` that produces `complexity === 'O(n)'` and `confidence > 0.97`.
- [ ] `merge_sort.ts` contains an exported function `mergeSort` (with a non-exported helper `merge`) that produces `complexity === 'O(n log n)'` and `confidence > 0.94`.
- [ ] **AC-FX (merge helper)**: For `merge_sort.ts`, the integration test asserts that a `ComplexityResult` entry exists for the `merge` helper function with `complexity === 'O(n)'` and `confidence > 0.90`. The `merge` function must appear in `FunctionBoundary[]` (S2 instruments all functions, not just exports).
- [ ] `constant.ts` contains two exported functions `getFirst` and `identityAdd`, each producing `complexity === 'O(1)'` and `confidence > 0.99`.
- [ ] `infinite_loop.ts` contains a single exported function `infiniteLoop` that causes S4 to trigger a timeout after 5 seconds, producing a `ComplexityResult` with `complexity === 'TIMEOUT'`.
- [ ] `no_functions.ts` contains only type aliases, interfaces, and constants. S2 produces an empty `FunctionBoundary[]`. No subsequent pipeline stage throws. No decorations are rendered.
- [ ] `compiler_error.ts` contains a function with a TypeScript type error. S1 returns a non-empty `diagnostics[]` array. S1 does not throw a `CompilerBridgeError`. The pipeline continues (does not abort).

### Compilation Criteria

- [ ] All 8 fixture files are accepted by `ts.transpileModule()` without producing a `SyntaxError`. (Note: `compiler_error.ts` produces type diagnostics, which are semantic errors, not syntax errors. `ts.transpileModule()` still emits valid JavaScript for it.)
- [ ] No fixture file contains `import` statements (each is self-contained).
- [ ] No fixture file references any extension subsystem module.

### Edge Case Criteria

- [ ] The integration test for `merge_sort.ts` fails with a clear assertion error if S5 classifies it as `'O(n)'` instead of `'O(n log n)'` -- confirming the fixture acts as a regression tripwire for the risk register item.
- [ ] The integration test for `infinite_loop.ts` has an 8-second hard timeout at the test-framework level. If S4's 5-second timeout fails to fire, the test-framework timeout catches it and reports a failure.
- [ ] The integration test for `constant.ts` independently asserts `getFirst` and `identityAdd` -- both must pass for the fixture to be considered successful.
- [ ] The integration test for `no_functions.ts` asserts `functionBoundaries.length === 0` after S2 (not just "no crash").
