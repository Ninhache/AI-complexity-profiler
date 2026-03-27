# Interface Contracts

> **Status**: APPROVED
> **Author**: architect
> **Created**: 2026-03-26
> **Priority**: MVP
> **Layer**: 1 (Foundation)

## 1. Overview

`interface-contracts` is a single, zero-runtime-logic TypeScript module located at `src/types.ts` that defines every shared type used across the six-subsystem pipeline (S1 through S6). It exists because the pipeline is designed for parallel agent implementation -- each subsystem is built by an independent agent, and all agents must agree on the shape of data crossing subsystem boundaries. By centralizing these contracts in one file with no runtime imports, the module acts as the single source of truth: no subsystem may define a cross-boundary type locally, and any change to a contract requires updating this file, which makes contract drift structurally impossible.

## 2. User Value

These contracts are invisible to the end user, but they are the structural foundation that makes every user-visible feature reliable. When a developer saves a `.ts` file and sees `O(n^2)` appear next to their function signature, that result has passed through six subsystems -- compiled code, instrumented AST, generated inputs, runtime measurements, curve-fitted analysis, and UI annotation. If any two subsystems disagree on the shape of data between them, the pipeline produces silent wrong answers: a misaligned `MeasurementPoint` could attribute operation counts to the wrong function, or a missing `tsLine` mapping could pin the annotation to the wrong source line. The user would see a confident, incorrect complexity label with no indication that it is wrong.

By locking every inter-subsystem type in a single file compiled under `--strict`, type mismatches between subsystems become compile-time errors rather than runtime mysteries. This means: correct annotations, correct source-line attribution, and correct confidence scores -- or a clear, catchable failure.

## 3. Detailed Design

All types are exported from `src/types.ts`. The module contains no executable logic, no side effects, and no runtime imports. Every subsystem imports its required types from this single file.

### SourceMap

Produced by S1 (Compiler Bridge). Consumed by S3 (Input Generator) and S5 (Complexity Analyzer).

```typescript
/**
 * Translates JavaScript output coordinates back to original TypeScript source coordinates.
 * Constructed from the inline source map emitted by ts.transpileModule().
 *
 * Implementations must be pure functions: identical inputs always produce identical outputs
 * with no side effects, no I/O, and no internal mutable state.
 */
interface SourceMap {
  /**
   * Maps a JavaScript line and column to the corresponding TypeScript source position.
   *
   * @param jsLine - 1-indexed line number in the compiled JavaScript output.
   * @param jsCol  - 0-indexed column number in the compiled JavaScript output.
   * @returns An object with tsLine (1-indexed) and tsCol (0-indexed) in the original .ts file.
   *          If the input coordinates fall outside the mapped range, returns { tsLine: 1, tsCol: 0 }
   *          as a fallback. This method never throws.
   */
  jsToTs(jsLine: number, jsCol: number): { tsLine: number; tsCol: number };
}
```

**Design rationale**: `jsToTs` returns a fallback instead of throwing because a missing source map entry is a degraded-accuracy scenario, not a fatal error. The pipeline can still produce a complexity result attributed to line 1 -- which is visually wrong but debuggable -- rather than aborting the entire analysis for one unmapped position.

### FunctionBoundary

Produced by S2 (AST Instrumenter). Consumed by S3 (Input Generator) and S5 (Complexity Analyzer).

```typescript
/**
 * Describes a single function's location and signature in the compiled JavaScript.
 * One FunctionBoundary is emitted per top-level function detected by Acorn during
 * AST instrumentation.
 */
interface FunctionBoundary {
  /**
   * Stable identifier for this function. Computed as:
   *   sha256(jsStartLine + ':' + jsStartCol), truncated to the first 8 hex characters.
   * Deterministic across re-parses as long as the function's position does not change.
   */
  functionId: string;

  /**
   * Human-readable function name. For named declarations and expressions, this is the declared name
   * (e.g., "bubbleSort"). For anonymous functions (arrow functions, unnamed function expressions),
   * this is '<anonymous>_L{jsStartLine}' where {jsStartLine} is the 1-indexed JS line of the
   * function's opening token.
   */
  name: string;

  /** 1-indexed line number where the function body begins in the compiled JS. */
  jsStartLine: number;

  /** 0-indexed column number where the function body begins in the compiled JS. */
  jsStartCol: number;

  /** 1-indexed line number where the function body ends in the compiled JS. */
  jsEndLine: number;

  /**
   * TypeScript type annotation strings for each parameter, in declaration order.
   * Examples: ['number[]', 'number'], ['Map<string, number>'], ['unknown'].
   *
   * This field is empty ([]) when emitted by S2 because S2 operates on JavaScript AST
   * which has no type information. S3 (Input Generator) populates this field by querying
   * the TypeScript type checker against the original .ts source.
   */
  paramTypes: string[];
}
```

**Design rationale**: `paramTypes` starts empty from S2 and is populated by S3 because S2 works on JavaScript (post-compilation) where type annotations have been erased. Requiring S2 to access the TypeScript type checker would create a circular dependency (S2 would need S1's compiler context). Instead, S3 owns the type checker query and enriches the FunctionBoundary before generating inputs.

### InputSet

Produced by S3 (Input Generator). Consumed by S4 (Runtime Executor).

```typescript
/**
 * A set of arguments for a single function at a specific input size n.
 * S3 produces one InputSet per (function, n) pair for each n in
 * [10, 30, 100, 300, 1000, 3000, 10000].
 */
interface InputSet {
  /** References FunctionBoundary.functionId of the target function. */
  functionId: string;

  /**
   * The logical input size. This is the length of the primary collection argument.
   * For scalar-only functions (no array/Map/Set/Record parameter), n represents
   * the magnitude of the first numeric parameter.
   */
  n: number;

  /**
   * The concrete arguments to pass to the function, in parameter declaration order.
   * Every element must be JSON-serializable (i.e., JSON.parse(JSON.stringify(args))
   * deep-equals args). This constraint exists because args are transferred to a
   * worker_threads Worker via structured clone, and must also be loggable/storable
   * for debugging.
   *
   * If any element is not JSON-serializable, InputSet construction must throw:
   *   TypeError("InputSet args must be JSON-serializable: <detail>")
   * where <detail> is a human-readable description of the non-serializable element
   * (e.g., "args[2] contains a function" or "args[0] contains a circular reference").
   */
  args: unknown[];
}
```

### MeasurementPoint

Produced by S4 (Runtime Executor). Consumed by S5 (Complexity Analyzer).

```typescript
/**
 * The runtime measurement for a single function at a single input size n.
 * S4 produces one MeasurementPoint per (function, n) pair that completes
 * execution within the configured timeoutMs value (default 5000ms).
 */
interface MeasurementPoint {
  /** References FunctionBoundary.functionId of the measured function. */
  functionId: string;

  /** The input size that produced this measurement. Matches InputSet.n. */
  n: number;

  /**
   * Total number of __op() counter increments recorded during execution.
   * This is the sum of all nodeCounters values. Always >= 0.
   * A value of 0 indicates the function executed without hitting any
   * instrumented node (e.g., an empty function body).
   */
  opCount: number;

  /**
   * Per-node breakdown of counter increments. Keys are NodeMeta.nodeId strings;
   * values are the number of times that node's __op() counter fired.
   * Every value is >= 1 (nodes with zero hits are omitted from this record).
   * An empty record {} indicates no instrumented nodes were hit.
   */
  nodeCounters: Record<string, number>;
}
```

### ComplexityResult

Produced by S5 (Complexity Analyzer). Consumed by S6 (Annotation Engine).

```typescript
/**
 * The final complexity classification for a single function, ready for
 * rendering as an inline annotation.
 */
interface ComplexityResult {
  /** References FunctionBoundary.functionId of the analyzed function. */
  functionId: string;

  /**
   * Human-readable function name, copied from FunctionBoundary.name.
   * Included here so S6 does not need to look up the FunctionBoundary.
   */
  functionName: string;

  /**
   * The original TypeScript source line (1-indexed) where this function is declared.
   * Computed by passing FunctionBoundary.jsStartLine through SourceMap.jsToTs().
   * S6 uses this to position the inline decoration on the correct editor line.
   */
  tsLine: number;

  /**
   * The classified complexity. One of the 7 mathematical classes (O(1) through O(2^n)),
   * or one of 4 non-mathematical outcomes: LOW_CONFIDENCE (R^2 < 0.92 for all models),
   * INSUFFICIENT_DATA (fewer than 5 measurement points), TIMEOUT (S4 hit the 5s limit),
   * RUNTIME_ERROR (function threw during execution).
   */
  complexity: ComplexityClass;

  /**
   * The R-squared (coefficient of determination) score of the best-fit model.
   * Range: 0.0 to 1.0 inclusive. Both boundary values are valid and require no special handling.
   * For non-mathematical outcomes (INSUFFICIENT_DATA, TIMEOUT, RUNTIME_ERROR), this is 0.0.
   * For LOW_CONFIDENCE, this is the highest R^2 achieved (which is < 0.92).
   */
  confidence: number;

  /**
   * The nodeId (from NodeMeta) whose __op() counter accumulated the highest opCount
   * across all measurement points. This identifies the "hot" instrumentation site --
   * typically the innermost loop or the recursive call site.
   * Empty string "" when complexity is INSUFFICIENT_DATA, TIMEOUT, or RUNTIME_ERROR.
   * LOW_CONFIDENCE results DO carry valid dominant attribution: dominantNodeId is populated
   * normally even when the confidence score is below the minConfidence threshold.
   */
  dominantNodeId: string;

  /**
   * The TypeScript source line (1-indexed) of the dominant node, computed by passing
   * the dominant node's jsLine through SourceMap.jsToTs().
   * 0 when dominantNodeId is "" (i.e., for INSUFFICIENT_DATA, TIMEOUT, or RUNTIME_ERROR).
   * Populated with a real line number for LOW_CONFIDENCE results (not 0).
   */
  dominantLine: number;

  /**
   * Raw (n, opCount) measurement pairs used for curve fitting, sorted ascending by n.
   * Each element is a 2-tuple [n, opCount].
   * Contains 0 to 7 elements (one per input size that completed execution).
   * Empty array [] when complexity is TIMEOUT or RUNTIME_ERROR for all input sizes.
   */
  dataPoints: [number, number][];
}
```

### NodeMeta

Internal to S2 (AST Instrumenter), also consumed by S5 (Complexity Analyzer) for source attribution.

```typescript
/**
 * Metadata for a single instrumented AST node. S2 emits one NodeMeta per injected
 * __op() counter. The collection of all NodeMeta for a file is the "nodeRegistry."
 */
interface NodeMeta {
  /**
   * Deterministic identifier for this node. Computed as:
   *   sha256(jsLine + ':' + jsCol), truncated to the first 8 hex characters.
   * Matches the keys used in MeasurementPoint.nodeCounters.
   */
  nodeId: string;

  /** 1-indexed line number of this node in the compiled JavaScript. */
  jsLine: number;

  /** 0-indexed column number of this node in the compiled JavaScript. */
  jsCol: number;

  /**
   * Identity placeholder — S2 sets tsLine = jsLine at instrumentation time.
   * S2 does not have access to the source map. Use sourceMap.jsToTs(jsLine, jsCol).tsLine
   * to get the true TypeScript line number.
   */
  tsLine: number;

  /**
   * Identity placeholder — S2 sets tsCol = jsCol at instrumentation time.
   * Use sourceMap.jsToTs(jsLine, jsCol).tsCol to get the true TypeScript column.
   */
  tsCol: number;

  /** The AST node type that triggered instrumentation. */
  type: AstNodeType;
}
```

### InstrumentResult

Produced by S2 (AST Instrumenter). Consumed by S3 (Input Generator), S4 (Runtime Executor), and S5 (Complexity Analyzer).

```typescript
/**
 * The complete output of a single S2 instrumentation pass over one compiled JS file.
 * S2 returns this as the result of instrumentCode(compiledJs).
 */
interface InstrumentResult {
  /** The instrumented JavaScript source. Contains __counters and __op preamble plus user
   *  code with __op() calls injected at all loop bodies, function entries, and recursive
   *  call sites. Syntactically valid ES2020 JavaScript. */
  instrumentedJs: string;

  /** Maps each nodeId (8-char hex) to its AST metadata. One entry per injected __op() call.
   *  Keyed by the same nodeId strings used in MeasurementPoint.nodeCounters. */
  nodeRegistry: Map<string, NodeMeta>;

  /** One entry per non-generator function detected during the AST walk.
   *  paramTypes is always [] — S3 populates it later via the TS type checker. */
  functionBoundaries: FunctionBoundary[];
}
```

### AstNodeType

```typescript
/**
 * Exhaustive enumeration of AST node types that receive __op() counter instrumentation.
 * This list is closed: no 'other' or 'unknown' variant exists. If a new node type
 * needs instrumentation, it must be added here as a new literal, and all subsystems
 * that pattern-match on AstNodeType must be updated.
 */
type AstNodeType =
  | 'ForStatement'
  | 'WhileStatement'
  | 'DoWhileStatement'
  | 'ForInStatement'
  | 'ForOfStatement'
  | 'CallExpression'
  | 'FunctionDeclaration'
  | 'ArrowFunctionExpression'
  | 'FunctionExpression';
```

**Design rationale**: This is a closed union, not an open string type. The absence of an `'other'` or `'unknown'` variant is intentional: every instrumented node must map to a specific AST construct. This forces explicit extension of the union when new node types are added, which surfaces type errors in all downstream consumers at compile time.

### FunctionStatus

Produced by the extension orchestrator. Consumed by S5 (Complexity Analyzer) to emit `TIMEOUT` and `RUNTIME_ERROR` results for functions that never produced measurements.

```typescript
/**
 * Per-function execution status summary built by the orchestrator from S4's
 * ExecutionResult before calling S5. S5 uses this to emit TIMEOUT and
 * RUNTIME_ERROR ComplexityResults without needing to inspect S4's raw output.
 */
interface FunctionStatus {
  /** References FunctionBoundary.functionId of the function. */
  functionId: string;

  /**
   * Execution outcome:
   *   'ok'            — function produced at least one MeasurementPoint; run OLS normally.
   *   'timeout'       — S4's worker was killed before the function completed all input sizes.
   *   'runtime_error' — S4 received an ExecutionError for this functionId.
   */
  status: 'ok' | 'timeout' | 'runtime_error';
}
```

### TSDiagnostic

Produced by S1 (Compiler Bridge). Consumed by the extension orchestrator for optional display.

```typescript
/**
 * A non-fatal diagnostic emitted during TypeScript compilation. These do not stop
 * the pipeline -- a file with warnings still proceeds through S2-S6. The orchestrator
 * may surface these in the VS Code Problems panel.
 */
interface TSDiagnostic {
  /** Human-readable diagnostic message from the TypeScript compiler. */
  message: string;

  /** 1-indexed line number in the original TypeScript source. */
  line: number;

  /** 1-indexed column number in the original TypeScript source. */
  col: number;

  /**
   * Severity level. Maps directly to VS Code DiagnosticSeverity:
   *   'error'      -> DiagnosticSeverity.Error
   *   'warning'    -> DiagnosticSeverity.Warning
   *   'suggestion' -> DiagnosticSeverity.Hint
   */
  severity: 'error' | 'warning' | 'suggestion';
}
```

### CompilerBridgeResult

Produced by S1 (Compiler Bridge). Consumed by the extension orchestrator as S1's successful return value.

```typescript
/**
 * The successful return value of S1's compile() function.
 * Contains the compiled JavaScript, the source map for coordinate translation,
 * and any non-fatal TypeScript diagnostics (warnings, suggestions).
 *
 * If compilation fails fatally, S1 throws CompilerBridgeError instead of
 * returning CompilerBridgeResult.
 */
interface CompilerBridgeResult {
  /** The compiled JavaScript source, ready for S2 instrumentation. */
  compiledJs: string;

  /** Source coordinate mapper from JS back to TS. Passed to S3 and S5. */
  sourceMap: SourceMap;

  /**
   * Non-fatal TypeScript compiler diagnostics (errors, warnings, suggestions).
   * May be non-empty even when compiledJs is valid — TypeScript can compile
   * a file with type errors by emitting best-effort JavaScript.
   */
  diagnostics: TSDiagnostic[];
}
```

### ExecutionError

Produced by S4 (Runtime Executor). Consumed by the extension orchestrator, which converts errors into `FunctionStatus[]` entries (status `'runtime_error'`) and passes them to S5. S5 never receives `ExecutionError` directly.

```typescript
/**
 * Reported when a function throws during execution at any input size.
 * One ExecutionError per function, capturing the first error encountered
 * (subsequent errors for the same function at larger n values are discarded).
 */
interface ExecutionError {
  /**
   * References FunctionBoundary.functionId of the function that threw.
   * Special sentinel value: `'__global__'` indicates a fatal worker-level failure
   * (e.g., the worker script itself threw before any function could be called).
   * A `'__global__'` error has no corresponding FunctionBoundary entry.
   */
  functionId: string;

  /**
   * The error message. If the thrown value is an Error instance, this is error.message.
   * If the thrown value is a string, this is the string itself.
   * For all other thrown values, this is String(thrownValue).
   * Maximum length: 500 characters. Truncated with trailing '...' if exceeded.
   */
  message: string;
}
```

### ExecutionResult

Produced by S4 (Runtime Executor). Consumed by the extension orchestrator.

```typescript
/**
 * The complete output of a single S4 execution run covering all input sizes
 * for all functions in the instrumented JS.
 */
interface ExecutionResult {
  /** One MeasurementPoint per (functionId, n) pair that completed within the timeout. */
  measurements: MeasurementPoint[];

  /**
   * One ExecutionError per function that threw during execution (first error only;
   * subsequent errors for the same function are discarded).
   */
  errors: ExecutionError[];

  /**
   * True if the worker was forcibly terminated by the timeout before completing
   * all input sizes. Some measurements may still be present (partial results).
   * False if the worker completed normally.
   */
  timedOut: boolean;
}
```

### ComplexityClass

```typescript
/**
 * The complete set of complexity classification outcomes.
 *
 * Mathematical classes (R^2 >= 0.92 for the best-fit model):
 *   'O(1)', 'O(log n)', 'O(n)', 'O(n log n)', 'O(n^2)', 'O(n^3)', 'O(2^n)'
 *
 * Non-mathematical outcomes:
 *   'LOW_CONFIDENCE'   - All models produced R^2 < 0.92. Rendered as ~O(?) hint.
 *   'INSUFFICIENT_DATA'- Fewer than 5 measurement points. No annotation rendered.
 *   'TIMEOUT'          - S4 worker exceeded the 5-second limit. Rendered as TIMEOUT error.
 *   'RUNTIME_ERROR'    - Function threw during execution. Rendered as runtime error.
 */
type ComplexityClass =
  | 'O(1)'
  | 'O(log n)'
  | 'O(n)'
  | 'O(n log n)'
  | 'O(n^2)'
  | 'O(n^3)'
  | 'O(2^n)'
  | 'LOW_CONFIDENCE'
  | 'INSUFFICIENT_DATA'
  | 'TIMEOUT'
  | 'RUNTIME_ERROR';
```

### CompilerBridgeError

```typescript
/**
 * Thrown by S1 when the input file cannot be parsed or compiled at all.
 * This is distinct from TSDiagnostic: diagnostics are non-fatal warnings
 * that allow the pipeline to continue, while CompilerBridgeError is a
 * fatal error that halts the pipeline for this file.
 *
 * Examples of fatal conditions: file does not exist, file is not valid UTF-8,
 * TypeScript parser throws an unrecoverable error.
 */
class CompilerBridgeError extends Error {
  /**
   * @param message  - Human-readable description of the failure.
   * @param filePath - The absolute filesystem path of the file that failed compilation.
   *                   Preserved exactly as passed (no normalization).
   * @param cause    - The underlying error, if any (e.g., the original ts.transpileModule error).
   */
  constructor(
    message: string,
    public readonly filePath: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'CompilerBridgeError';
  }
}
```

**Design rationale**: `filePath` is stored as `readonly` and preserved exactly as passed to the constructor because downstream error handlers (e.g., the orchestrator surfacing a diagnostic in the VS Code Problems panel) need to match the error back to the open editor document by path. Normalizing the path here could break that match on case-sensitive filesystems.

## 4. Data Model & Logic

### Type Flow Table

| Type | Producer | Consumers | Transfer Mechanism |
|---|---|---|---|
| `SourceMap` | S1 (Compiler Bridge) | S3 (Input Generator), S5 (Complexity Analyzer) | In-process function call |
| `FunctionBoundary` | S2 (AST Instrumenter) | S3 (Input Generator), S4 (Runtime Executor), S5 (Complexity Analyzer) | In-process array |
| `InputSet` | S3 (Input Generator) | S4 (Runtime Executor) | Structured clone to Worker |
| `MeasurementPoint` | S4 (Runtime Executor) | S5 (Complexity Analyzer) | Structured clone from Worker |
| `ComplexityResult` | S5 (Complexity Analyzer) | S6 (Annotation Engine) | In-process array |
| `NodeMeta` | S2 (AST Instrumenter) | S5 (Complexity Analyzer) | In-process registry (Map) |
| `TSDiagnostic` | S1 (Compiler Bridge) | Extension Orchestrator | In-process array |
| `ExecutionError` | S4 (Runtime Executor) | Extension Orchestrator | Structured clone from Worker |
| `ExecutionResult` | S4 (Runtime Executor) | Extension Orchestrator | Structured clone from Worker |
| `CompilerBridgeError` | S1 (Compiler Bridge) | Extension Orchestrator | Thrown exception |
| `CompilerBridgeResult` | S1 (Compiler Bridge) | Extension Orchestrator | In-process return value |

### Pipeline Data Flow Diagram

```
  .ts file
     |
     v
  [S1: Compiler Bridge]
     |--- compiledJs: string
     |--- sourceMap: SourceMap
     |--- diagnostics: TSDiagnostic[]
     |    (or throws CompilerBridgeError)
     v
  [S2: AST Instrumenter]
     |--- instrumentedJs: string
     |--- functionBoundaries: FunctionBoundary[]  (paramTypes empty)
     |--- nodeRegistry: Map<string, NodeMeta>
     v
  [S3: Input Generator]  (also receives sourceMap from S1)
     |--- inputSets: InputSet[]  (enriches FunctionBoundary.paramTypes)
     v
  [S4: Runtime Executor]
     |--- measurements: MeasurementPoint[]
     |--- errors: ExecutionError[]
     v
  [S5: Complexity Analyzer]  (also receives sourceMap from S1, nodeRegistry from S2)
     |--- results: ComplexityResult[]
     v
  [S6: Annotation Engine]
     |--- VS Code decorations, diagnostics, WebView
```

### Worked Example: bubbleSort

Consider this TypeScript function saved in `src/sort.ts`:

```typescript
function bubbleSort(arr: number[]): number[] {
  const n = arr.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n - i - 1; j++) {
      if (arr[j] > arr[j + 1]) {
        [arr[j], arr[j + 1]] = [arr[j + 1], arr[j]];
      }
    }
  }
  return arr;
}
```

**Step 1 -- S1 emits SourceMap + compiled JS**

The compiled JS preserves the same line structure (no type erasure changes line numbers in this case). `sourceMap.jsToTs(2, 0)` returns `{ tsLine: 2, tsCol: 0 }`.

**Step 2 -- S2 emits FunctionBoundary and NodeMeta entries**

```typescript
// FunctionBoundary (paramTypes empty at this stage)
{
  functionId: "a3f8c012",   // sha256("1:0") truncated to 8 hex
  name: "bubbleSort",
  jsStartLine: 1,
  jsStartCol: 0,
  jsEndLine: 11,
  paramTypes: []            // empty -- S2 has no type info
}

// NodeMeta entries (3 instrumented nodes)
{
  nodeId: "b7e24f01",       // outer for-loop
  jsLine: 3, jsCol: 2,
  tsLine: 3, tsCol: 2,
  type: "ForStatement"
}
{
  nodeId: "c9d31a02",       // inner for-loop
  jsLine: 4, jsCol: 4,
  tsLine: 4, tsCol: 4,
  type: "ForStatement"
}
{
  nodeId: "d1a45b03",       // function entry
  jsLine: 1, jsCol: 0,
  tsLine: 1, tsCol: 0,
  type: "FunctionDeclaration"
}
```

**Step 3 -- S3 enriches paramTypes and generates InputSets**

S3 queries the TS type checker, discovers `arr: number[]`, and populates:

```typescript
// FunctionBoundary (enriched)
{ ...boundary, paramTypes: ["number[]"] }

// InputSets (7 sizes)
{ functionId: "a3f8c012", n: 10,    args: [[4, 7, 2, 9, 1, 5, 3, 8, 6, 0]] }
{ functionId: "a3f8c012", n: 30,    args: [[...30 random ints...]] }
{ functionId: "a3f8c012", n: 100,   args: [[...100 random ints...]] }
{ functionId: "a3f8c012", n: 300,   args: [[...300 random ints...]] }
{ functionId: "a3f8c012", n: 1000,  args: [[...1000 random ints...]] }
{ functionId: "a3f8c012", n: 3000,  args: [[...3000 random ints...]] }
{ functionId: "a3f8c012", n: 10000, args: [[...10000 random ints...]] }
```

**Step 4 -- S4 executes and measures**

```typescript
// MeasurementPoints (showing 3 of 7 for brevity)
{ functionId: "a3f8c012", n: 10,   opCount: 56,     nodeCounters: { "b7e24f01": 10, "c9d31a02": 45, "d1a45b03": 1 } }
{ functionId: "a3f8c012", n: 100,  opCount: 5051,   nodeCounters: { "b7e24f01": 100, "c9d31a02": 4950, "d1a45b03": 1 } }
{ functionId: "a3f8c012", n: 1000, opCount: 500501, nodeCounters: { "b7e24f01": 1000, "c9d31a02": 499500, "d1a45b03": 1 } }
```

Note: `opCount = 10 + 45 + 1 = 56` for n=10. The inner loop counter ("c9d31a02") dominates.

**Step 5 -- S5 fits curves and produces ComplexityResult**

S5 runs least-squares regression on the 7 data points against all 7 complexity models. The O(n^2) model produces the highest R^2:

```typescript
{
  functionId: "a3f8c012",
  functionName: "bubbleSort",
  tsLine: 1,                          // sourceMap.jsToTs(1, 0).tsLine
  complexity: "O(n^2)",
  confidence: 0.9998,                 // R^2 score
  dominantNodeId: "c9d31a02",         // inner for-loop had highest opCount
  dominantLine: 4,                    // sourceMap.jsToTs(4, 4).tsLine
  dataPoints: [
    [10, 56], [30, 496], [100, 5051],
    [300, 45151], [1000, 500501],
    [3000, 4501501], [10000, 50005001]
  ]
}
```

**Step 6 -- S6 renders**

S6 places an inline decoration on TypeScript line 1: `O(n^2)` with a warning diagnostic.

## 5. Edge Cases & Error Handling

### Anonymous function names

**Trigger**: S2 encounters a function expression or arrow function with no declared name.

**Behavior**: `FunctionBoundary.name` is set to `'<anonymous>_L{jsStartLine}'` where `{jsStartLine}` is the 1-indexed JavaScript line number of the function's opening token. For example, an arrow function starting at JS line 42 receives the name `'<anonymous>_L42'`.

**State after**: The FunctionBoundary is valid and flows through the pipeline normally. S6 displays the generated name in the annotation.

### Functions with zero parameters

**Trigger**: S2 detects a function declaration with no parameters (e.g., `function getTimestamp(): number`).

**Behavior**: `FunctionBoundary.paramTypes` is set to `[]` (empty array). S3 receives this boundary and must still generate InputSets with `args: []` (empty args array) at each n value. S4 executes the function with no arguments. This is valid because the function may still contain loops with hardcoded iteration counts.

**State after**: The pipeline continues. The function will likely be classified as `O(1)` since there is no input-driven growth.

### Non-serializable args in InputSet

**Trigger**: S3 attempts to construct an InputSet where one or more elements of `args` are not JSON-serializable (e.g., contain functions, `undefined` nested in arrays, circular references, `BigInt`, `Symbol`).

**Behavior**: InputSet construction throws:
```
TypeError("InputSet args must be JSON-serializable: args[2] contains a function")
TypeError("InputSet args must be JSON-serializable: args[0] contains a circular reference")
```

The message format is always: `"InputSet args must be JSON-serializable: "` followed by a specific description identifying the argument index and the reason (one of: `"contains a function"`, `"contains a circular reference"`, `"contains a BigInt"`, `"contains a Symbol"`, `"contains undefined at key '{key}'"` for nested objects).

**State after**: The InputSet is not created. S3 must catch this error and skip the function, logging the error. The function receives no InputSets and S5 classifies it as `INSUFFICIENT_DATA`.

### SourceMap.jsToTs with out-of-range coordinates

**Trigger**: `jsToTs` is called with a `jsLine` or `jsCol` that does not appear in the inline source map (e.g., the line was injected by S2's instrumentation and has no TS origin).

**Behavior**: Returns `{ tsLine: 1, tsCol: 0 }` as a fallback. The method never throws, regardless of input values (including negative numbers, zero, or values exceeding the file length).

**State after**: The caller receives a valid but potentially inaccurate position. Downstream, this may cause an annotation to appear on line 1 of the TS file instead of the correct line. This is preferable to crashing the pipeline.

### Confidence score boundary values

**Trigger**: The R^2 score from least-squares regression is exactly 0.0 or exactly 1.0.

**Behavior**: Both values are valid for `ComplexityResult.confidence`. No special handling, clamping, or rounding is applied.
- `confidence: 0.0` occurs when the best-fit model explains none of the variance. This results in `complexity: 'LOW_CONFIDENCE'` (since 0.0 < 0.92).
- `confidence: 1.0` occurs when the data points fall exactly on the model curve (e.g., a function with a trivially predictable pattern). The corresponding mathematical ComplexityClass is assigned normally.

**State after**: The ComplexityResult is valid and S6 renders the appropriate decoration.

### Empty nodeCounters in MeasurementPoint

**Trigger**: A function contains no instrumented AST nodes (e.g., a function body with only `return 42;` and no loops, no calls, no nested functions).

**Behavior**: `MeasurementPoint.nodeCounters` is `{}` (empty record) and `opCount` is `0`. S5 receives flat data points `[(10, 0), (30, 0), ..., (10000, 0)]` and classifies the function as `O(1)` with high confidence.

**State after**: The ComplexityResult has `dominantNodeId: ""` and `dominantLine: 0` because there are no nodes to rank.

### FunctionBoundary.functionId collision

**Trigger**: Two functions in the same file start at the exact same JS line and column (theoretically impossible after correct compilation, but worth specifying).

**Behavior**: The sha256 hash is deterministic, so both functions receive the same `functionId`. The second FunctionBoundary overwrites the first in any map keyed by `functionId`. This is a data-loss scenario.

**Mitigation**: This case should not occur in practice because Acorn parses distinct function nodes at distinct source positions. If it does occur, it indicates a bug in S2's boundary detection. No runtime guard is provided in the type layer -- the bug must be fixed in S2.

### CompilerBridgeError preserves filePath

**Trigger**: S1 cannot compile a file and throws CompilerBridgeError.

**Behavior**: `CompilerBridgeError.filePath` is stored as a `readonly` property and contains the exact string passed to the constructor. No path normalization, resolution, or modification is applied. If the constructor receives `'/home/user/./src/../src/file.ts'`, that exact string is stored.

**State after**: The pipeline halts for this file. The orchestrator catches the error, reads `filePath` to identify the failing document, and surfaces the error in the VS Code Problems panel.

### ExecutionError message truncation

**Trigger**: S4 catches an error whose message exceeds 500 characters.

**Behavior**: The message is truncated to 497 characters followed by `'...'` (total 500 characters). No further processing is applied to the truncated message.

**State after**: The ExecutionError is emitted with the truncated message. S5 classifies the function as `RUNTIME_ERROR`.

## 6. Dependencies

### Upstream Dependencies

This module has **no upstream dependencies**. It is Layer 1 -- it depends on nothing.

### Downstream Dependents (all subsystems import from this module)

| Consumer | Types Imported | Purpose |
|---|---|---|
| **s1-compiler-bridge** | `SourceMap`, `TSDiagnostic`, `CompilerBridgeError`, `CompilerBridgeResult` | S1 constructs and returns these types |
| **s2-ast-instrumenter** | `FunctionBoundary`, `NodeMeta`, `AstNodeType`, `InstrumentResult`, `SourceMap` | S2 constructs FunctionBoundary, NodeMeta, and InstrumentResult; receives SourceMap from S1 |
| **s3-input-generator** | `FunctionBoundary`, `InputSet` | S3 reads FunctionBoundary.paramTypes, constructs InputSet |
| **s4-runtime-executor** | `InputSet`, `FunctionBoundary`, `MeasurementPoint`, `ExecutionError`, `ExecutionResult` | S4 receives InputSet and FunctionBoundary, constructs MeasurementPoint, ExecutionError, and ExecutionResult |
| **s5-complexity-analyzer** | `MeasurementPoint`, `ComplexityResult`, `ComplexityClass`, `NodeMeta`, `SourceMap`, `FunctionBoundary`, `FunctionStatus` | S5 receives measurements and function statuses, produces ComplexityResult |
| **s6-annotation-engine** | `ComplexityResult`, `ComplexityClass` | S6 reads ComplexityResult to render decorations |
| **extension-orchestrator** | All types | Orchestrator wires the pipeline and handles CompilerBridgeError |

### Third-Party Dependencies

**None.** This module is pure TypeScript type definitions and a single class (`CompilerBridgeError`). It has no `import` statements and no runtime dependencies. It compiles with the TypeScript compiler and nothing else.

### Bidirectional Reference Status

Every subsystem spec must list `interface-contracts` as an upstream dependency in its Dependencies section. Since `interface-contracts` is the first component being specified, this cross-reference will be verified as each subsystem spec is written.

## 7. Configuration

This module has **no runtime configuration**. It defines types only -- there are no tunable parameters, environment variables, feature flags, or configurable values.

All configuration for the extension (timeouts, input sizes, R^2 thresholds, enabled/disabled state) lives in the **extension-orchestrator** component and is defined in the **extension-manifest** (`package.json` `contributes.configuration` section). The type layer intentionally contains no configuration to maintain its role as a pure contract: if types depended on configuration values, the contract surface would become runtime-dependent and harder to reason about.

## 8. Acceptance Criteria

### Compilation

- [ ] `src/types.ts` compiles with zero errors and zero warnings under `tsc --strict --noEmit` using the project's `tsconfig.json`.
- [ ] All 15 exported types (`SourceMap`, `FunctionBoundary`, `InputSet`, `MeasurementPoint`, `ComplexityResult`, `NodeMeta`, `InstrumentResult`, `AstNodeType`, `FunctionStatus`, `TSDiagnostic`, `ExecutionError`, `ExecutionResult`, `ComplexityClass`, `CompilerBridgeError`, `CompilerBridgeResult`) are importable from `src/types.ts` by any other module in the project.

### JSON Round-Trip Stability

- [ ] Given any valid `ComplexityResult` value `r`, `JSON.parse(JSON.stringify(r))` deep-equals `r` (all fields survive serialization and deserialization without loss).
- [ ] Given any valid `InputSet` value `s`, `JSON.parse(JSON.stringify(s))` deep-equals `s` (the `args: unknown[]` array, which is constrained to JSON-serializable values, survives the round trip).
- [ ] Given a `MeasurementPoint` value `m`, `JSON.parse(JSON.stringify(m))` deep-equals `m`.

### CompilerBridgeError Behavior

- [ ] `new CompilerBridgeError("msg", "/a/b/c.ts").filePath` returns the exact string `"/a/b/c.ts"`.
- [ ] `new CompilerBridgeError("msg", "/a/b/c.ts").name` returns `"CompilerBridgeError"`.
- [ ] `new CompilerBridgeError("msg", "/a/b/c.ts") instanceof Error` returns `true`.
- [ ] `new CompilerBridgeError("msg", "/a/b/c.ts", originalError).cause` returns the same object reference as `originalError`.

### SourceMap Purity

- [ ] For any implementation of `SourceMap`, calling `jsToTs(x, y)` twice with the same arguments returns deep-equal results.
- [ ] `SourceMap.jsToTs` produces no side effects: no I/O, no mutation of external state, no logging. (Verified by code review of the S1 implementation.)

### AstNodeType Completeness

- [ ] `AstNodeType` contains exactly 9 literal types: `'ForStatement'`, `'WhileStatement'`, `'DoWhileStatement'`, `'ForInStatement'`, `'ForOfStatement'`, `'CallExpression'`, `'FunctionDeclaration'`, `'ArrowFunctionExpression'`, `'FunctionExpression'`.
- [ ] No variant named `'other'`, `'unknown'`, or any catch-all exists in `AstNodeType`.

### Type Constraint Enforcement

- [ ] Assigning a string not in the `ComplexityClass` union to a variable typed `ComplexityClass` produces a `tsc` compile error.
- [ ] Assigning a string not in the `AstNodeType` union to a variable typed `AstNodeType` produces a `tsc` compile error.
- [ ] Omitting any required field from `FunctionBoundary`, `InputSet`, `MeasurementPoint`, `ComplexityResult`, `NodeMeta`, `TSDiagnostic`, or `ExecutionError` produces a `tsc` compile error.
- [ ] `FunctionBoundary.paramTypes` accepts `string[]` and rejects `number[]` at compile time.
- [ ] `MeasurementPoint.nodeCounters` accepts `Record<string, number>` and rejects `Record<string, string>` at compile time.
