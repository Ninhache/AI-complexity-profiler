/**
 * @file src/s4-runtime-executor.ts
 *
 * S4 — Runtime Executor
 *
 * Receives instrumented JavaScript from S2, a list of (functionId, n, args) input sets
 * from S3, and function boundary metadata. Spawns an isolated worker_threads Worker to
 * execute each function at each input size and collect __op() counter measurements.
 *
 * Public API:
 *   export async function executeAll(
 *     instrumentedJs: string,
 *     inputSets: InputSet[],
 *     boundaries: FunctionBoundary[],
 *     timeoutMs: number,
 *   ): Promise<ExecutionResult>
 *
 * The promise never rejects. All errors are captured inside ExecutionResult.errors.
 * timeoutMs is silently clamped to [1000, 30000].
 */

import { Worker } from 'worker_threads';
import { InputSet, FunctionBoundary, ExecutionResult, MeasurementPoint, ExecutionError } from './types';

// ---------------------------------------------------------------------------
// Internal types (local to S4)
// ---------------------------------------------------------------------------

interface WorkerPayload {
  instrumentedJs: string;
  inputSets: InputSet[];
  functionIdToName: Record<string, string>;
}

type WorkerMessage =
  | { type: 'measurement'; functionId: string; n: number; opCount: number; nodeCounters: Record<string, number> }
  | { type: 'error'; functionId: string; message: string }
  | { type: 'fatalError'; message: string }
  | { type: 'done' };

// ---------------------------------------------------------------------------
// Worker script body (embedded; the require() line is prepended by the parent)
// ---------------------------------------------------------------------------

/**
 * The body of the worker script, evaluated inside a worker_threads Worker.
 * The parent thread prepends `const { workerData, parentPort } = require('worker_threads');\n`
 * before this string when constructing the Worker with `{ eval: true }`.
 *
 * Responsibilities:
 *   1. eval() the instrumented JS to define all user functions and __counters/__op globals.
 *   2. Iterate over inputSets, resolving each functionId to a callable by name.
 *   3. Clear __counters before each call, invoke the function, then post a 'measurement'.
 *   4. Post 'error' for per-function failures (including anonymous functions and missing refs).
 *   5. Post 'fatalError' if the outer eval() or any unrecoverable failure occurs.
 *   6. Post 'done' when all input sets have been processed.
 */
const WORKER_SCRIPT_BODY = `
try {
  const { instrumentedJs, inputSets, functionIdToName } = workerData;

  eval(instrumentedJs);

  for (const { functionId, n, args } of inputSets) {
    __counters.clear();

    const name = functionIdToName[functionId];
    if (name === undefined) {
      parentPort.postMessage({ type: 'error', functionId, message: \`No function found for id: \${functionId}\` });
      continue;
    }

    const anonMatch = name.match(/^<anonymous>_L(\\d+)$/);
    if (anonMatch) {
      parentPort.postMessage({ type: 'error', functionId, message: \`Anonymous function at line \${anonMatch[1]}\` });
      continue;
    }

    let fn;
    try {
      fn = eval(name);
    } catch {
      parentPort.postMessage({ type: 'error', functionId, message: \`ReferenceError: \${name} is not defined\` });
      continue;
    }

    if (typeof fn !== 'function') {
      parentPort.postMessage({ type: 'error', functionId, message: \`ReferenceError: \${name} is not defined\` });
      continue;
    }

    try {
      fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      parentPort.postMessage({ type: 'error', functionId, message: message.length > 500 ? message.slice(0, 497) + '...' : message });
      continue;
    }

    const opCount = [...__counters.values()].reduce((a, b) => a + b, 0);
    const nodeCounters = Object.fromEntries(__counters);
    parentPort.postMessage({ type: 'measurement', functionId, n, opCount, nodeCounters });
  }

  parentPort.postMessage({ type: 'done' });

} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  parentPort.postMessage({ type: 'fatalError', message: message.length > 500 ? message.slice(0, 497) + '...' : message });
}
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Executes all input sets against the provided instrumented JavaScript inside an
 * isolated worker_threads Worker, collecting __op() counter measurements for each
 * (functionId, n) pair.
 *
 * @param instrumentedJs - The S2-instrumented JavaScript source. Must include the
 *                         __counters/__op preamble emitted by S2.
 * @param inputSets      - One entry per (functionId, n) pair to execute. All args
 *                         must be JSON-serializable (worker_threads structured clone).
 * @param boundaries     - FunctionBoundary records from S2, used to resolve functionId
 *                         to callable function name inside the worker.
 * @param timeoutMs      - Wall-clock timeout for the entire worker run. Silently clamped
 *                         to [1000, 30000] milliseconds.
 * @returns A Promise that always resolves (never rejects) with the accumulated
 *          measurements, errors, and a timedOut flag.
 */
export async function executeAll(
  instrumentedJs: string,
  inputSets: InputSet[],
  boundaries: FunctionBoundary[],
  timeoutMs: number,
): Promise<ExecutionResult> {
  // Clamp timeout to the allowed range
  const clampedTimeout = Math.max(1000, Math.min(30000, timeoutMs));

  if (inputSets.length === 0) {
    return { measurements: [], errors: [], timedOut: false };
  }

  const functionIdToName: Record<string, string> = {};
  for (const fb of boundaries) {
    functionIdToName[fb.functionId] = fb.name;
  }

  return new Promise((resolve) => {
    const measurements: MeasurementPoint[] = [];
    const errors: ExecutionError[] = [];
    let timedOut = false;
    let finished = false;

    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      worker.terminate();
      resolve({ measurements, errors, timedOut });
    }

    const payload: WorkerPayload = { instrumentedJs, inputSets, functionIdToName };

    const worker = new Worker(
      `const { workerData, parentPort } = require('worker_threads');\n${WORKER_SCRIPT_BODY}`,
      { eval: true, workerData: payload }
    );

    const timer = setTimeout(() => {
      timedOut = true;
      finish();
    }, clampedTimeout);

    worker.on('message', (msg: WorkerMessage) => {
      if (finished) return;
      if (msg.type === 'measurement') {
        measurements.push({ functionId: msg.functionId, n: msg.n, opCount: msg.opCount, nodeCounters: msg.nodeCounters });
      }
      if (msg.type === 'error') {
        if (!errors.some((e) => e.functionId === msg.functionId)) {
          errors.push({ functionId: msg.functionId, message: msg.message });
        }
      }
      if (msg.type === 'fatalError') {
        errors.push({ functionId: '__global__', message: msg.message });
        finish();
      }
      if (msg.type === 'done') {
        finish();
      }
    });

    worker.on('error', (err: Error) => {
      errors.push({ functionId: '__global__', message: err.message });
      finish();
    });

    worker.on('exit', () => {
      finish();
    });
  });
}
