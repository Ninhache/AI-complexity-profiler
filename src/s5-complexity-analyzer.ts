/**
 * @file src/s5-complexity-analyzer.ts
 *
 * S5 — Complexity Analyzer
 *
 * Mathematical core of the pipeline. Receives raw (n, opCount) measurements from S4,
 * fits seven candidate complexity models using OLS regression (no intercept), selects
 * the best-fitting model by R-squared, and produces one ComplexityResult per function.
 *
 * Public API:
 *   analyzeComplexity(measurements, nodeRegistry, sourceMap, functionBoundaries,
 *                     functionStatuses, minConfidence) — returns ComplexityResult[]
 */

import {
  MeasurementPoint,
  NodeMeta,
  SourceMap,
  FunctionBoundary,
  FunctionStatus,
  ComplexityResult,
  ComplexityClass,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum number of data points required for OLS classification. */
const MIN_DATA_POINTS = 5;

/** Maximum input size n to include when fitting the O(2^n) model. */
const EXPONENTIAL_CAP = 30;

/** Tie-breaking order: simpler models win over more complex ones. */
const COMPLEXITY_ORDER: ComplexityClass[] = [
  'O(1)',
  'O(log n)',
  'O(n)',
  'O(n log n)',
  'O(n^2)',
  'O(n^3)',
  'O(2^n)',
];

// ---------------------------------------------------------------------------
// Model transforms: n → predictor value x
// ---------------------------------------------------------------------------

type ModelTransform = (n: number) => number;

const TRANSFORMS: Array<{ cls: ComplexityClass; transform: ModelTransform }> = [
  { cls: 'O(1)',       transform: (_n) => 1 },
  { cls: 'O(log n)',   transform: (n) => Math.log2(n) },
  { cls: 'O(n)',       transform: (n) => n },
  { cls: 'O(n log n)', transform: (n) => n * Math.log2(n) },
  { cls: 'O(n^2)',     transform: (n) => n * n },
  { cls: 'O(n^3)',     transform: (n) => n * n * n },
  { cls: 'O(2^n)',     transform: (n) => Math.pow(2, n) },
];

// ---------------------------------------------------------------------------
// OLS fitting
// ---------------------------------------------------------------------------

/**
 * Fits a single candidate model to the data and returns R-squared.
 *
 * Implements the O(1) special case and the O(2^n) n-cap filter.
 * Returns null if the model should be skipped (O(2^n) with too few filtered points).
 */
function fitModel(
  cls: ComplexityClass,
  transform: ModelTransform,
  ns: number[],
  opCounts: number[],
): number | null {
  const k = ns.length;

  if (cls === 'O(1)') {
    // O(1) special case: c = mean_y; SS_res = SS_tot (constant predictor).
    const meanY = opCounts.reduce((a, b) => a + b, 0) / k;
    const ssTot = opCounts.reduce((sum, y) => sum + (y - meanY) ** 2, 0);
    return ssTot === 0 ? 1.0 : 0.0;
  }

  // O(2^n): filter to n <= 30 before fitting.
  let fitNs = ns;
  let fitOpCounts = opCounts;
  if (cls === 'O(2^n)') {
    const filtered: { n: number; op: number }[] = [];
    for (let i = 0; i < k; i++) {
      if (ns[i] <= EXPONENTIAL_CAP) {
        filtered.push({ n: ns[i], op: opCounts[i] });
      }
    }
    if (filtered.length < MIN_DATA_POINTS) {
      return null; // not enough filtered points — skip this candidate
    }
    fitNs = filtered.map((p) => p.n);
    fitOpCounts = filtered.map((p) => p.op);
  }

  const fk = fitNs.length;
  const xs = fitNs.map(transform);

  // OLS no-intercept: c = Σ(x·y) / Σ(x²)
  let sumXY = 0;
  let sumX2 = 0;
  for (let i = 0; i < fk; i++) {
    sumXY += xs[i] * fitOpCounts[i];
    sumX2 += xs[i] * xs[i];
  }

  const c = sumX2 === 0 ? 0 : sumXY / sumX2;

  // R-squared
  const meanY = fitOpCounts.reduce((a, b) => a + b, 0) / fk;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < fk; i++) {
    const predicted = c * xs[i];
    ssRes += (fitOpCounts[i] - predicted) ** 2;
    ssTot += (fitOpCounts[i] - meanY) ** 2;
  }

  if (ssTot === 0) {
    // All values identical; non-O(1) models score 0 per spec §4.4.
    return 0.0;
  }

  const r2 = 1 - ssRes / ssTot;
  return Math.max(0.0, Math.min(1.0, r2));
}

// ---------------------------------------------------------------------------
// Dominant node attribution
// ---------------------------------------------------------------------------

function computeDominantNode(
  functionPoints: MeasurementPoint[],
  nodeRegistry: Map<string, NodeMeta>,
  sourceMap: SourceMap,
  functionId: string,
  tsLine: number,
): { dominantNodeId: string; dominantLine: number } {
  if (functionPoints.length === 0) {
    return { dominantNodeId: '', dominantLine: 0 };
  }

  // Largest n first (ties: first encountered).
  const largestPoint = functionPoints.reduce(
    (best, p) => (p.n > best.n ? p : best),
    functionPoints[0],
  );

  // Find nodeId with highest count in largest point's nodeCounters.
  let dominantNodeId = '';
  let dominantCount = -1;
  for (const [nodeId, count] of Object.entries(largestPoint.nodeCounters)) {
    if (count > dominantCount) {
      dominantCount = count;
      dominantNodeId = nodeId;
    }
  }

  if (dominantNodeId === '') {
    // No counters at all — fall back to function entry node.
    dominantNodeId = functionId;
    return { dominantNodeId, dominantLine: tsLine };
  }

  const meta = nodeRegistry.get(dominantNodeId);
  if (!meta) {
    // Fallback: function entry.
    dominantNodeId = functionId;
    return { dominantNodeId, dominantLine: tsLine };
  }

  const dominantLine = sourceMap.jsToTs(meta.jsLine, meta.jsCol).tsLine;
  return { dominantNodeId, dominantLine };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyzes complexity for all functions detected in a single file pass.
 *
 * @param measurements       Raw (functionId, n, opCount, nodeCounters) data from S4.
 * @param nodeRegistry       AST node metadata indexed by nodeId, from S2.
 * @param sourceMap          JS→TS coordinate mapper, from S1.
 * @param functionBoundaries Function locations and names, from S2.
 * @param functionStatuses   Per-function ok/timeout/runtime_error, from orchestrator.
 * @param minConfidence      R² threshold for a confident classification (e.g. 0.92).
 * @returns One ComplexityResult per function in functionBoundaries.
 */
export function analyzeComplexity(
  measurements: MeasurementPoint[],
  nodeRegistry: Map<string, NodeMeta>,
  sourceMap: SourceMap,
  functionBoundaries: FunctionBoundary[],
  functionStatuses: FunctionStatus[],
  minConfidence: number,
): ComplexityResult[] {
  // Build lookup maps.
  const boundaryMap = new Map<string, FunctionBoundary>();
  for (const b of functionBoundaries) {
    boundaryMap.set(b.functionId, b);
  }

  const statusMap = new Map<string, FunctionStatus['status']>();
  for (const s of functionStatuses) {
    statusMap.set(s.functionId, s.status);
  }

  // Group measurements by functionId.
  const groups = new Map<string, MeasurementPoint[]>();
  for (const m of measurements) {
    const existing = groups.get(m.functionId);
    if (existing) {
      existing.push(m);
    } else {
      groups.set(m.functionId, [m]);
    }
  }

  const results: ComplexityResult[] = [];

  for (const boundary of functionBoundaries) {
    const { functionId, name: functionName, jsStartLine, jsStartCol } = boundary;

    const tsLine = sourceMap.jsToTs(jsStartLine, jsStartCol).tsLine;
    const status = statusMap.get(functionId) ?? 'ok';

    // TIMEOUT / RUNTIME_ERROR: short-circuit — no OLS.
    if (status === 'timeout') {
      results.push({
        functionId,
        functionName,
        tsLine,
        complexity: 'TIMEOUT',
        confidence: 0,
        dominantNodeId: '',
        dominantLine: 0,
        dataPoints: [],
      });
      continue;
    }

    if (status === 'runtime_error') {
      results.push({
        functionId,
        functionName,
        tsLine,
        complexity: 'RUNTIME_ERROR',
        confidence: 0,
        dominantNodeId: '',
        dominantLine: 0,
        dataPoints: [],
      });
      continue;
    }

    // status === 'ok' — proceed with OLS.
    const functionPoints = groups.get(functionId) ?? [];

    // dataPoints sorted ascending by n.
    const dataPoints = functionPoints
      .map((m): [number, number] => [m.n, m.opCount])
      .sort((a, b) => a[0] - b[0]);

    const k = functionPoints.length;

    if (k < MIN_DATA_POINTS) {
      results.push({
        functionId,
        functionName,
        tsLine,
        complexity: 'INSUFFICIENT_DATA',
        confidence: 0,
        dominantNodeId: '',
        dominantLine: 0,
        dataPoints,
      });
      continue;
    }

    const ns = functionPoints.map((m) => m.n);
    const opCounts = functionPoints.map((m) => m.opCount);

    // Fit all candidate models and collect (class, r2) pairs.
    let bestCls: ComplexityClass = 'O(1)';
    let bestR2 = -Infinity;

    for (const { cls, transform } of TRANSFORMS) {
      const r2 = fitModel(cls, transform, ns, opCounts);
      if (r2 === null) continue; // O(2^n) filtered out

      const orderIndex = COMPLEXITY_ORDER.indexOf(cls);
      const bestOrderIndex = COMPLEXITY_ORDER.indexOf(bestCls);

      // Higher R² wins; ties broken by simpler model (lower order index).
      if (r2 > bestR2 || (r2 === bestR2 && orderIndex < bestOrderIndex)) {
        bestR2 = r2;
        bestCls = cls;
      }
    }

    // If no model produced a valid R² (edge case: only O(2^n) was viable and filtered out).
    const confidence = bestR2 < 0 ? 0 : bestR2;
    const complexity: ComplexityClass =
      confidence >= minConfidence ? bestCls : 'LOW_CONFIDENCE';

    const { dominantNodeId, dominantLine } = computeDominantNode(
      functionPoints,
      nodeRegistry,
      sourceMap,
      functionId,
      tsLine,
    );

    results.push({
      functionId,
      functionName,
      tsLine,
      complexity,
      confidence,
      dominantNodeId,
      dominantLine,
      dataPoints,
    });
  }

  return results;
}
