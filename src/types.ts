/**
 * @file src/types.ts
 *
 * Single source of truth for all cross-subsystem data types in the
 * TypeScript Complexity Profiler pipeline (S1 → S2 → S3 → S4 → S5 → S6).
 *
 * Rules:
 *   - No executable logic, no side effects, no runtime imports.
 *   - Every cross-boundary type lives here. No subsystem may redeclare one locally.
 *   - All types are exported; subsystems import only what they consume.
 */

// ---------------------------------------------------------------------------
// S1 → S3, S1 → S5
// ---------------------------------------------------------------------------

/**
 * Translates JavaScript output coordinates back to original TypeScript source coordinates.
 * Constructed from the inline source map emitted by ts.transpileModule().
 *
 * Implementations must be pure functions: identical inputs always produce identical outputs
 * with no side effects, no I/O, and no internal mutable state.
 */
export interface SourceMap {
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

// ---------------------------------------------------------------------------
// S2 → S3, S2 → S4, S2 → S5
// ---------------------------------------------------------------------------

/**
 * Describes a single function's location and signature in the compiled JavaScript.
 * One FunctionBoundary is emitted per top-level function detected by Acorn during
 * AST instrumentation.
 */
export interface FunctionBoundary {
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

// ---------------------------------------------------------------------------
// S3 → S4
// ---------------------------------------------------------------------------

/**
 * A set of arguments for a single function at a specific input size n.
 * S3 produces one InputSet per (function, n) pair for each n in
 * [10, 30, 100, 300, 1000, 3000, 10000].
 */
export interface InputSet {
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

// ---------------------------------------------------------------------------
// S4 → S5
// ---------------------------------------------------------------------------

/**
 * The runtime measurement for a single function at a single input size n.
 * S4 produces one MeasurementPoint per (function, n) pair that completes
 * execution within the configured timeoutMs value (default 5000ms).
 */
export interface MeasurementPoint {
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

// ---------------------------------------------------------------------------
// S4 → Orchestrator (via ExecutionResult)
// ---------------------------------------------------------------------------

/**
 * Reported when a function throws during execution at any input size.
 * One ExecutionError per function, capturing the first error encountered
 * (subsequent errors for the same function at larger n values are discarded).
 */
export interface ExecutionError {
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

/**
 * The complete output of a single S4 execution run covering all input sizes
 * for all functions in the instrumented JS.
 */
export interface ExecutionResult {
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

// ---------------------------------------------------------------------------
// S5 → S6
// ---------------------------------------------------------------------------

/**
 * The complete set of complexity classification outcomes.
 *
 * Mathematical classes (R^2 >= 0.92 for the best-fit model):
 *   'O(1)', 'O(log n)', 'O(n)', 'O(n log n)', 'O(n^2)', 'O(n^3)', 'O(2^n)'
 *
 * Non-mathematical outcomes:
 *   'LOW_CONFIDENCE'    - All models produced R^2 < 0.92. Rendered as ~O(?) hint.
 *   'INSUFFICIENT_DATA' - Fewer than 5 measurement points. No annotation rendered.
 *   'TIMEOUT'           - S4 worker exceeded the configured timeout. Rendered as TIMEOUT error.
 *   'RUNTIME_ERROR'     - Function threw during execution. Rendered as runtime error.
 */
export type ComplexityClass =
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

/**
 * The final complexity classification for a single function, ready for
 * rendering as an inline annotation.
 */
export interface ComplexityResult {
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
   * INSUFFICIENT_DATA (fewer than 5 measurement points), TIMEOUT (S4 hit the timeout limit),
   * RUNTIME_ERROR (function threw during execution).
   */
  complexity: ComplexityClass;

  /**
   * The R-squared (coefficient of determination) score of the best-fit model.
   * Range: 0.0 to 1.0 inclusive. Both boundary values are valid and require no special handling.
   * For non-mathematical outcomes (INSUFFICIENT_DATA, TIMEOUT, RUNTIME_ERROR), this is 0.0.
   * For LOW_CONFIDENCE, this is the highest R^2 achieved (which is < minConfidence).
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

// ---------------------------------------------------------------------------
// S2 internal + S5 (source attribution)
// ---------------------------------------------------------------------------

/**
 * Exhaustive enumeration of AST node types that receive __op() counter instrumentation.
 * This list is closed: no 'other' or 'unknown' variant exists. If a new node type
 * needs instrumentation, it must be added here as a new literal, and all subsystems
 * that pattern-match on AstNodeType must be updated.
 */
export type AstNodeType =
  | 'ForStatement'
  | 'WhileStatement'
  | 'DoWhileStatement'
  | 'ForInStatement'
  | 'ForOfStatement'
  | 'CallExpression'
  | 'FunctionDeclaration'
  | 'ArrowFunctionExpression'
  | 'FunctionExpression';

/**
 * Metadata for a single instrumented AST node. S2 emits one NodeMeta per injected
 * __op() counter. The collection of all NodeMeta for a file is the "nodeRegistry."
 */
export interface NodeMeta {
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

/**
 * The complete output of a single S2 instrumentation pass over one compiled JS file.
 * S2 returns this as the result of instrumentCode(compiledJs).
 */
export interface InstrumentResult {
  /**
   * The instrumented JavaScript source. Contains __counters and __op preamble plus user
   * code with __op() calls injected at all loop bodies, function entries, and recursive
   * call sites. Syntactically valid ES2020 JavaScript.
   */
  instrumentedJs: string;

  /**
   * Maps each nodeId (8-char hex) to its AST metadata. One entry per injected __op() call.
   * Keyed by the same nodeId strings used in MeasurementPoint.nodeCounters.
   */
  nodeRegistry: Map<string, NodeMeta>;

  /**
   * One entry per non-generator function detected during the AST walk.
   * paramTypes is always [] — S3 populates it later via the TS type checker.
   */
  functionBoundaries: FunctionBoundary[];
}

// ---------------------------------------------------------------------------
// Orchestrator → S5
// ---------------------------------------------------------------------------

/**
 * Per-function execution status summary built by the orchestrator from S4's
 * ExecutionResult before calling S5. S5 uses this to emit TIMEOUT and
 * RUNTIME_ERROR ComplexityResults without needing to inspect S4's raw output.
 */
export interface FunctionStatus {
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

// ---------------------------------------------------------------------------
// S1 → Orchestrator
// ---------------------------------------------------------------------------

/**
 * A non-fatal diagnostic emitted during TypeScript compilation. These do not stop
 * the pipeline -- a file with warnings still proceeds through S2-S6. The orchestrator
 * may surface these in the VS Code Problems panel.
 */
export interface TSDiagnostic {
  /** Human-readable diagnostic message from the TypeScript compiler. */
  message: string;

  /**
   * 1-indexed line number in the original TypeScript source.
   * 0 is a sentinel meaning "no source location" (used for synthetic diagnostics
   * such as tsconfig load failures). Consumers must check for line === 0.
   */
  line: number;

  /**
   * 1-indexed column number in the original TypeScript source.
   * 0 is a sentinel meaning "no source location" (paired with line === 0).
   */
  col: number;

  /**
   * Severity level. Maps directly to VS Code DiagnosticSeverity:
   *   'error'      -> DiagnosticSeverity.Error
   *   'warning'    -> DiagnosticSeverity.Warning
   *   'suggestion' -> DiagnosticSeverity.Hint
   */
  severity: 'error' | 'warning' | 'suggestion';
}

/**
 * The successful return value of S1's compileFile() function.
 * Contains the compiled JavaScript, the source map for coordinate translation,
 * and any non-fatal TypeScript diagnostics (warnings, suggestions).
 *
 * If compilation fails fatally, S1 throws CompilerBridgeError instead of
 * returning CompilerBridgeResult.
 */
export interface CompilerBridgeResult {
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

/**
 * Thrown by S1 when the input file cannot be parsed or compiled at all.
 * This is distinct from TSDiagnostic: diagnostics are non-fatal warnings
 * that allow the pipeline to continue, while CompilerBridgeError is a
 * fatal error that halts the pipeline for this file.
 *
 * Examples of fatal conditions: file does not exist, file is not valid UTF-8,
 * TypeScript parser throws an unrecoverable error.
 */
export class CompilerBridgeError extends Error {
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
