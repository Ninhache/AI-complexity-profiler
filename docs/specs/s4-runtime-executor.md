# S4 — Runtime Executor

> **Status**: APPROVED
> **Author**: architect
> **Created**: 2026-03-26
> **Priority**: MVP
> **Layer**: 3 (Core)

## 1. Overview

S4 runs instrumented JavaScript (produced by S2) inside a `worker_threads.Worker` and collects raw `{functionId, n, opCount, nodeCounters}` measurements for every (function, input size) pair that completes execution within a hard timeout. It is the measurement engine of the pipeline: S2 instruments the code with `__op()` counters, S3 generates the inputs, and S4 actually runs the code, resets the counters between runs, extracts the accumulated counts after each run, and returns the results to S5 for curve fitting. S4 enforces a per-invocation timeout to prevent infinite loops or exponentially expensive functions from blocking the extension host. A fresh worker is spawned for every call to `executeAll()` — no worker pooling, no state carryover between saves.

## 2. User Value

When a developer saves a `.ts` file, the pipeline must actually run their functions at multiple input sizes to measure how operation counts grow. S4 is the subsystem that performs this execution. If S4 is fast and correct, the developer sees accurate complexity annotations within a second of saving. If S4 hangs on an infinite loop, the 5-second timeout fires and the developer sees a `TIMEOUT` decoration on the offending function rather than an unresponsive editor. If a function throws at runtime (e.g., `TypeError: undefined is not a function`), S4 captures the error per-function so the remaining functions in the file still get analyzed — the developer sees complexity labels on working functions and a `RUNTIME_ERROR` marker on the broken one, rather than losing all annotations because one function failed.

## 3. Detailed Design

### 3.1 Public Interface

```typescript
export function executeAll(
  instrumentedJs: string,       // from S2 — JS string with __op() counters and __counters preamble
  inputSets:      InputSet[],   // from S3 — one entry per (functionId, n) pair
  boundaries:     FunctionBoundary[],  // from S1/S2 — used to build functionId-to-name map
  timeoutMs:      number,       // range: 1000–30000; recommended default: 5000
): Promise<ExecutionResult>
```

If `timeoutMs` is outside the range [1000, 30000], it is silently clamped: values below 1000 are raised to 1000, values above 30000 are lowered to 30000. No exception is thrown.

Where `ExecutionResult` is:

```typescript
interface ExecutionResult {
  measurements: MeasurementPoint[];
  errors:       ExecutionError[];
  /** True if the worker was terminated due to timeout before completing all input sizes. */
  timedOut:     boolean;
}
```

The function returns a `Promise<ExecutionResult>` that resolves after all worker communication is complete. It is async because it collects worker events asynchronously via the Node.js event loop. All error scenarios — function throws, worker crashes, timeouts — are captured inside the result object. The promise never rejects.

### 3.2 Return Type

**ExecutionResult** — imported from `src/types.ts` (defined in `interface-contracts`). Do not redeclare locally. The `ExecutionResult` interface crosses the S4→Orchestrator boundary and must use the single authoritative definition.

`MeasurementPoint` and `ExecutionError` are imported from `interface-contracts` (`src/types.ts`).

**`__global__` sentinel on `ExecutionError`:** When a fatal worker-level error occurs (e.g., the worker script itself throws during initialization before any function can run), emit a single `ExecutionError` with `functionId: '__global__'` and `message` set to the error's message or `String(error)`. This sentinel is defined in `interface-contracts.md` — it does not reference any `FunctionBoundary` entry.

### 3.3 Worker Data Structure

The worker is created with `workerData` containing the full execution payload:

```typescript
interface WorkerPayload {
  instrumentedJs:   string;                    // the full JS string to eval (includes __counters and __op preamble)
  inputSets:        InputSet[];                // all inputs for all functions
  functionIdToName: Record<string, string>;   // functionId -> human-readable name
}
```

`functionIdToName` maps each `FunctionBoundary.functionId` to `FunctionBoundary.name`. This allows the worker to include function names in error messages without needing the full `FunctionBoundary[]` object inside the worker.

This payload is transferred via `worker_threads` structured clone. All fields are JSON-serializable (string, array of objects with string/number/unknown[] fields where `unknown[]` is constrained to JSON-serializable values by the InputSet contract, and a plain string-keyed object).

### 3.4 Worker Script Embedding

The worker script is embedded as a string constant within the S4 module, not stored as a separate file on disk. At runtime, the worker is created using:

```typescript
const worker = new Worker(
  `const { workerData, parentPort } = require('worker_threads');\n${WORKER_SCRIPT_BODY}`,
  { eval: true, workerData: payload }
);
```

The `eval: true` option tells `worker_threads.Worker` to treat the first argument as JavaScript source code rather than a file path. This eliminates deployment issues with locating a worker script file relative to the extension's install directory.

### 3.5 Worker Execution Algorithm

The following algorithm runs inside the worker thread. It is expressed as pseudocode; the actual implementation is the embedded string.

```
const { instrumentedJs, inputSets } = require('worker_threads').workerData;
const parentPort = require('worker_threads').parentPort;

try {
  // Step 1: Eval the instrumented code.
  // This defines __counters (Map), __op (function), and all user functions.
  // Named functions declared with `function` keyword become local variables
  // accessible via eval() lookup.
  eval(instrumentedJs);

  // Step 2: Process each InputSet sequentially.
  for (const { functionId, n, args } of inputSets) {

    // Step 2a: Reset counters so each (functionId, n) pair starts from zero.
    __counters.clear();

    // Step 2b: Look up the function reference by name using the functionIdToName map.
    // The map is provided via workerData (see Section 3.3). After eval(instrumentedJs),
    // named function declarations are accessible in the eval scope.

    const { functionIdToName } = workerData;

    const name = functionIdToName[functionId];
    if (name === undefined) {
      // No mapping exists for this functionId.
      parentPort.postMessage({
        type: 'error',
        functionId,
        message: `No function found for id: ${functionId}`
      });
      continue;
    }

    // Check for anonymous functions before attempting eval.
    // Anonymous functions match the pattern '<anonymous>_L{digits}'.
    // They have no variable in the eval scope — emit error and skip.
    const anonMatch = name.match(/^<anonymous>_L(\d+)$/);
    if (anonMatch) {
      parentPort.postMessage({
        type: 'error',
        functionId,
        message: `Anonymous function at line ${anonMatch[1]}`
      });
      continue;
    }

    let fn;
    try {
      fn = eval(name);
    } catch {
      // Name is not in the eval scope (e.g., ReferenceError for block-scoped functions).
      parentPort.postMessage({
        type: 'error',
        functionId,
        message: `ReferenceError: ${name} is not defined`
      });
      continue;
    }

    if (typeof fn !== 'function') {
      parentPort.postMessage({
        type: 'error',
        functionId,
        message: `ReferenceError: ${name} is not defined`
      });
      continue;
    }

    // Step 2c: Execute the function with the provided args.
    try {
      fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      parentPort.postMessage({
        type: 'error',
        functionId,
        message: message.length > 500 ? message.slice(0, 497) + '...' : message
      });
      continue;  // __counters may be partially populated; skip this pair
    }

    // Step 2d: Extract measurements.
    const opCount = [...__counters.values()].reduce((a, b) => a + b, 0);
    const nodeCounters = Object.fromEntries(__counters);

    // Step 2e: Post measurement back to parent.
    parentPort.postMessage({
      type: 'measurement',
      functionId,
      n,
      opCount,
      nodeCounters
    });
  }

  // Step 3: Signal completion.
  parentPort.postMessage({ type: 'done' });

} catch (err) {
  // Top-level eval failure (e.g., SyntaxError in instrumentedJs).
  const message = err instanceof Error ? err.message : String(err);
  parentPort.postMessage({
    type: 'fatalError',
    message: message.length > 500 ? message.slice(0, 497) + '...' : message
  });
}
```

### 3.6 Function Name Resolution

`InputSet` contains `functionId` (an 8-character hex hash) but not the function name. To call functions by ID after `eval(instrumentedJs)`, S4 uses a `functionIdToName` map passed to the worker via `workerData` (see Section 3.3).

The parent thread constructs this map from the `boundaries` parameter before spawning the worker:

```typescript
const functionIdToName: Record<string, string> = {};
for (const fb of boundaries) {
  functionIdToName[fb.functionId] = fb.name;
}
```

Inside the worker, after `eval(instrumentedJs)`, function lookup proceeds as follows:

1. Look up `name = functionIdToName[functionId]`. If `undefined`: emit `ExecutionError` with message `'No function found for id: {functionId}'` and continue to the next InputSet.

2. Check whether `name` matches the pattern `<anonymous>_L{digits}`. If it does: the function has no variable in the eval scope and cannot be invoked. Emit `ExecutionError` with message `'Anonymous function at line {jsStartLine}'` (where `{jsStartLine}` is the numeric suffix of the pattern) and continue to the next InputSet.

3. Call `eval(name)` to retrieve the function reference from the eval scope. If this throws (e.g., `ReferenceError` because the function was a block-scoped `const`/`let` assignment): emit `ExecutionError` with the caught error message and continue to the next InputSet.

4. If the resolved value is not a function: emit `ExecutionError` with message `'ReferenceError: {name} is not defined'` and continue to the next InputSet.

**Anonymous function limitation:** Anonymous functions cannot be invoked by S4. An `ExecutionError` is emitted with the message `'Anonymous function at line {jsStartLine}'`, where `{jsStartLine}` is the JS start line from the corresponding `FunctionBoundary`. No `MeasurementPoint` is produced. The pipeline continues with the next InputSet.

### 3.7 Parent Thread Timeout Enforcement

The parent thread uses an event-driven model to collect results and enforce the timeout:

```typescript
export async function executeAll(
  instrumentedJs: string,
  inputSets:      InputSet[],
  boundaries:     FunctionBoundary[],
  timeoutMs:      number,
): Promise<ExecutionResult> {

  // Fast path: no inputs means no work.
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
      if (finished) return;  // guard against double-finish
      finished = true;
      clearTimeout(timer);
      worker.terminate();
      resolve({ measurements, errors, timedOut });
    }

    const payload: WorkerPayload = {
      instrumentedJs,
      inputSets,
      functionIdToName,
    };

    const worker = new Worker(WORKER_SCRIPT_STRING, {
      eval: true,
      workerData: payload,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      finish();  // measurements collected so far are included; timedOut is true
    }, timeoutMs);

    worker.on('message', (msg: WorkerMessage) => {
      if (finished) return;

      if (msg.type === 'measurement') {
        measurements.push({
          functionId: msg.functionId,
          n: msg.n,
          opCount: msg.opCount,
          nodeCounters: msg.nodeCounters,
        });
      }

      if (msg.type === 'error') {
        // Deduplicate: keep only the first error per functionId.
        const alreadyRecorded = errors.some((e) => e.functionId === msg.functionId);
        if (!alreadyRecorded) {
          errors.push({ functionId: msg.functionId, message: msg.message });
        }
      }

      if (msg.type === 'fatalError') {
        errors.push({
          functionId: '__global__',
          message: msg.message,
        });
        finish();
      }

      if (msg.type === 'done') {
        finish();
      }
    });

    worker.on('error', (err: Error) => {
      errors.push({
        functionId: '__global__',
        message: err.message,
      });
      finish();
    });

    worker.on('exit', () => {
      // Worker may exit without sending 'done' (e.g., after terminate()).
      // finish() is idempotent — the first call resolves the promise; subsequent calls are no-ops.
      finish();
    });
  });
}
```

**Key behaviors:**
- `finish()` is idempotent: the first call resolves the promise and terminates the worker; subsequent calls are no-ops.
- `worker.terminate()` is always called — either by timeout or by normal completion. The worker is never left running.
- The `timer` is always cleared inside `finish()` — no timer leak regardless of outcome.
- `timedOut` is set to `true` only by the timeout path, before `finish()` is called, so it is captured in the resolved value.

### 3.8 Worker Message Types

Messages from the worker to the parent conform to one of four shapes:

```typescript
type WorkerMessage =
  | { type: 'measurement'; functionId: string; n: number; opCount: number; nodeCounters: Record<string, number> }
  | { type: 'error'; functionId: string; message: string }
  | { type: 'fatalError'; message: string }
  | { type: 'done' };
```

These are not formally typed via `interface-contracts` — they are internal to S4's worker protocol. The parent converts `measurement` messages to `MeasurementPoint` and `error` messages to `ExecutionError` as defined in `interface-contracts`.

### 3.9 Security Boundary (v1)

The worker runs in the same Node.js process space as the extension host. `worker_threads.Worker` provides thread-level isolation (separate V8 isolate, separate event loop) but NOT process-level sandboxing. In v1:

- **Network access is NOT blocked.** User code can make HTTP requests from inside the worker.
- **File system access is NOT blocked.** User code can read/write files.
- **`require()` is NOT blocked.** User code can load Node.js built-in modules and any installed npm packages.
- **`process.exit()` is available.** User code could terminate the worker (and by extension potentially disrupt the extension host).

**v1 assumption:** The user is running the extension on their own code in their own editor. Their code is trusted. This is a developer tool, not a code execution sandbox for untrusted third-party code.

**v2 plan (documented, not implemented):** Replace `eval()` in the worker with `vm.runInNewContext()` using a restricted context object that excludes `require`, `process`, `fs`, `net`, and other dangerous globals. This would provide defense-in-depth without changing the public interface.

## 4. Data Model & Logic

### 4.1 Worker Script Structure

The worker script is a single JavaScript string constant (`WORKER_SCRIPT_STRING`) defined at module scope in the S4 source file. It is not read from a file at runtime. The string contains:

1. `require('worker_threads')` import for `workerData` and `parentPort`.
2. A `try/catch` wrapping the entire execution (catches top-level eval failures).
3. The `eval(instrumentedJs)` call.
4. The for-loop over `inputSets` with counter reset, function lookup, execution, and measurement extraction.
5. The `parentPort.postMessage({ type: 'done' })` call.

### 4.2 Counter Reset Between InputSet Runs

Before each (functionId, n) pair is executed, the worker calls `__counters.clear()`. This is the `Map.prototype.clear()` method on the `__counters` Map defined in S2's preamble. After `clear()`:

- `__counters.size === 0`
- All previous nodeId-to-count entries are removed.
- The next `__op(nodeId)` call starts the count at 1 for that nodeId.

This ensures that each `MeasurementPoint` reflects only the operations from a single (functionId, n) execution, not accumulated state from prior runs.

### 4.3 opCount Aggregation Formula

```
opCount = sum of all values in __counters
        = [...__counters.values()].reduce((accumulator, count) => accumulator + count, 0)
```

- If `__counters` is empty (no `__op()` calls fired), `opCount` is `0`.
- Each value in `__counters` is a positive integer >= 1 (the `__op` function initializes to 1 on first call and increments thereafter).

### 4.4 nodeCounters Extraction

```
nodeCounters = Object.fromEntries(__counters)
```

This converts the `Map<string, number>` to a `Record<string, number>`. Keys are nodeId strings (8-character hex hashes). Values are positive integers >= 1. Nodes that were never hit during execution do not appear in the record (they were never added to the Map by `__op()`).

### 4.5 Worked Example: bubbleSort with Two Input Sizes

**Input:**

```typescript
// instrumentedJs (produced by S2, shown in abbreviated form):
const __counters = new Map();
const __op = (id) => __counters.set(id, (__counters.get(id) || 0) + 1);
function bubbleSort(arr) {
  __op('aa11bb22');  // function entry
  for (let i = 0; i < arr.length; i++) {
    __op('cc33dd44');  // outer loop
    for (let j = 0; j < arr.length - i - 1; j++) {
      __op('ee55ff66');  // inner loop
      if (arr[j] > arr[j + 1]) {
        let tmp = arr[j]; arr[j] = arr[j+1]; arr[j+1] = tmp;
      }
    }
  }
}

// inputSets:
[
  { functionId: 'aa11bb22', n: 10,  args: [[5, 2, 8, 1, 9, 3, 7, 4, 6, 0]] },
  { functionId: 'aa11bb22', n: 100, args: [[...100 random integers...]] }
]

// functionIdToName:
{ 'aa11bb22': 'bubbleSort' }

// timeoutMs: 5000
```

**Execution trace for n=10:**

1. `__counters.clear()` -- Map is empty.
2. `fn = eval('bubbleSort')` -- retrieves the function reference.
3. `fn([5, 2, 8, 1, 9, 3, 7, 4, 6, 0])` executes:
   - `__op('aa11bb22')` fires 1 time (function entry).
   - Outer loop runs 10 iterations: `__op('cc33dd44')` fires 10 times.
   - Inner loop runs `sum(9+8+7+6+5+4+3+2+1+0) = 45` iterations: `__op('ee55ff66')` fires 45 times.
4. `__counters` state: `{ 'aa11bb22': 1, 'cc33dd44': 10, 'ee55ff66': 45 }`.
5. `opCount = 1 + 10 + 45 = 56`.
6. `nodeCounters = { 'aa11bb22': 1, 'cc33dd44': 10, 'ee55ff66': 45 }`.
7. Worker posts: `{ type: 'measurement', functionId: 'aa11bb22', n: 10, opCount: 56, nodeCounters: { 'aa11bb22': 1, 'cc33dd44': 10, 'ee55ff66': 45 } }`.

**Execution trace for n=100:**

1. `__counters.clear()` -- Map is empty again.
2. `fn = eval('bubbleSort')` -- same function reference.
3. `fn([...100 random integers...])` executes:
   - `__op('aa11bb22')` fires 1 time.
   - Outer loop: 100 iterations, `__op('cc33dd44')` fires 100 times.
   - Inner loop: `sum(99+98+...+1+0) = 4950` iterations, `__op('ee55ff66')` fires 4950 times.
4. `__counters` state: `{ 'aa11bb22': 1, 'cc33dd44': 100, 'ee55ff66': 4950 }`.
5. `opCount = 1 + 100 + 4950 = 5051`.
6. Worker posts: `{ type: 'measurement', functionId: 'aa11bb22', n: 100, opCount: 5051, nodeCounters: { 'aa11bb22': 1, 'cc33dd44': 100, 'ee55ff66': 4950 } }`.

**Final ExecutionResult:**

```typescript
{
  measurements: [
    { functionId: 'aa11bb22', n: 10,  opCount: 56,   nodeCounters: { 'aa11bb22': 1, 'cc33dd44': 10, 'ee55ff66': 45 } },
    { functionId: 'aa11bb22', n: 100, opCount: 5051, nodeCounters: { 'aa11bb22': 1, 'cc33dd44': 100, 'ee55ff66': 4950 } }
  ],
  timedOut: false,
  errors: []
}
```

### 4.6 Worked Example: Function That Throws

**Input:**

```typescript
// instrumentedJs contains a function that throws for large inputs:
function riskyDivide(arr) {
  __op('dd112233');
  for (let i = 0; i < arr.length; i++) {
    __op('ff445566');
    if (arr[i] === 0) throw new Error("Division by zero");
    // ... some computation
  }
}

// inputSets:
[
  { functionId: 'dd112233', n: 10,  args: [[1, 2, 3, 4, 5, 6, 7, 8, 9, 0]] },  // 0 at index 9
  { functionId: 'dd112233', n: 100, args: [[...100 numbers, 0 at index 50...]] }
]

// functionIdToName:
{ 'dd112233': 'riskyDivide' }
```

**Execution trace for n=10:**

1. `__counters.clear()`.
2. `fn = eval('riskyDivide')`.
3. `fn([1,2,3,4,5,6,7,8,9,0])` -- throws `Error("Division by zero")` on iteration 10 (when `arr[9] === 0`).
4. Catch block fires. `message = "Division by zero"`. Length is 16, under 500, no truncation.
5. Worker posts: `{ type: 'error', functionId: 'dd112233', message: 'Division by zero' }`.
6. `continue` -- proceed to n=100.

**Execution trace for n=100:**

1. `__counters.clear()`.
2. `fn([...])` -- throws at index 50.
3. Worker posts: `{ type: 'error', functionId: 'dd112233', message: 'Division by zero' }`.

**Final ExecutionResult:**

Note: The interface-contracts spec states "One ExecutionError per function, capturing the first error encountered (subsequent errors for the same function at larger n values are discarded)." S4 posts all errors from the worker; the **deduplication** (keeping only the first error per functionId) is performed in the parent thread's message handler. When a `type: 'error'` message arrives, the parent checks whether `errors` already contains an entry for that `functionId`. If so, the duplicate is discarded.

```typescript
{
  measurements: [],
  timedOut: false,
  errors: [
    { functionId: 'dd112233', message: 'Division by zero' }
  ]
}
```

## 5. Edge Cases & Error Handling

### 5.1 Empty inputSets

**Input condition:** `inputSets` is `[]` (empty array).

**Behavior:** `executeAll()` resolves immediately without spawning a worker.

**Result:** `{ measurements: [], timedOut: false, errors: [] }`.

**State after:** No worker was created. No timer was started. No resources to clean up.

### 5.2 Function Throws at Runtime

**Input condition:** A function called via `fn(...args)` throws an exception (e.g., `TypeError`, `RangeError`, user-defined `Error`).

**Behavior:** The worker catches the error in the `try/catch` around `fn(...args)`. It extracts the message:
- If `err instanceof Error`: use `err.message`.
- If `err` is a string: use the string directly.
- Otherwise: use `String(err)`.

If the message exceeds 500 characters, it is truncated to 497 characters followed by `'...'` (total 500).

The worker posts `{ type: 'error', functionId, message }`. The `__counters` map may be partially populated from `__op()` calls that fired before the throw. These partial counts are discarded — no `MeasurementPoint` is produced for this (functionId, n) pair. The worker proceeds to the next InputSet in the loop.

**Result fields for this (functionId, n) pair:**
- `measurements`: no entry added.
- `timedOut`: `false` (timeout did not fire).
- `errors`: one `ExecutionError { functionId, message }` added (subject to per-functionId deduplication).

### 5.3 Worker Timeout (5s Default Exceeded)

**Input condition:** The worker has not posted `{ type: 'done' }` within `timeoutMs` milliseconds of worker creation.

**Behavior:** The `setTimeout` callback fires in the parent thread. It sets `timedOut = true` and calls `finish()`, which calls `worker.terminate()` to forcibly stop the worker thread and resolves the promise with `timedOut: true`. All `MeasurementPoint` objects posted by the worker before the timeout are included in `measurements`. All `ExecutionError` objects posted before the timeout are included in `errors`. InputSets that had not yet been processed by the worker produce neither a `MeasurementPoint` nor an `ExecutionError` — they are simply absent from the result.

**Result:**
- `measurements`: contains all measurements posted before the kill.
- `timedOut`: `true`.
- `errors`: contains all errors posted before the kill.

### 5.4 Top-Level Syntax Error in instrumentedJs

**Input condition:** `eval(instrumentedJs)` throws a `SyntaxError` because the instrumented JS is not valid JavaScript (e.g., S2 produced malformed output, or S1 produced an empty `compiledJs` that S2 passed through).

**Behavior:** The worker's top-level `try/catch` catches the `SyntaxError`. It posts `{ type: 'fatalError', message: 'SyntaxError: {details}' }`. The parent thread receives this message and calls `finish()`.

**Result:**
- `measurements`: `[]` (no measurements were collected before the eval failure).
- `timedOut`: `false`.
- `errors`: `[{ functionId: '__global__', message: 'SyntaxError: {details}' }]`. // `'__global__'` is the sentinel defined in interface-contracts — means worker-level failure, not a per-function error

### 5.5 Worker Crashes Unexpectedly

**Input condition:** The worker thread terminates due to an uncaught exception that escapes the top-level `try/catch`, or due to a fatal V8 error (e.g., out-of-memory).

**Behavior:** The `worker.on('error', callback)` handler fires in the parent thread with the error object. The parent adds an `ExecutionError` with `functionId: '__global__'` and `message: err.message`, then calls `finish()`.

**Result:**
- `measurements`: `[]` (or any measurements posted before the crash).
- `timedOut`: `false`.
- `errors`: `[{ functionId: '__global__', message: '{error message}' }]`. // `'__global__'` is the sentinel defined in interface-contracts — means worker-level failure, not a per-function error

### 5.6 Anonymous Function (No Callable Name)

**Input condition:** `functionIdToName[functionId]` returns a string matching the pattern `<anonymous>_L{digits}` (e.g., `'<anonymous>_L42'`). This name does not correspond to any variable in the eval scope.

**Behavior:** The worker detects that the name matches the anonymous pattern `<anonymous>_L{digits}` before attempting `eval()`, and posts:

```javascript
{ type: 'error', functionId, message: 'Anonymous function at line 42' }
```

Where `42` is the JS start line from the `FunctionBoundary` (stored in `functionIdToName` as the numeric suffix of the pattern). No `MeasurementPoint` is produced for any InputSet referencing this functionId. The worker continues with the next InputSet.

**Result for each (functionId, n) pair with this anonymous function:**
- `measurements`: no entry.
- `errors`: one `ExecutionError { functionId, message: 'Anonymous function at line 42' }` (deduplicated to one per functionId).

### 5.7 Function Name Not in eval Scope

**Input condition:** `functionIdToName[functionId]` returns a name (e.g., `'myHelper'`) that is not a `FunctionDeclaration` — it was a `FunctionExpression` assigned to a `const`/`let`/`var` inside a block scope, or the name was resolved from a `VariableDeclarator` that is not accessible in the top-level eval scope.

**Behavior:** `eval('myHelper')` throws a `ReferenceError: myHelper is not defined`. The worker catches this and posts:

```javascript
{ type: 'error', functionId, message: 'ReferenceError: myHelper is not defined' }
```

**Result:** Same pattern as Section 5.6 — `ExecutionError` recorded, no `MeasurementPoint`, pipeline continues.

### 5.8 functionIdToName Has No Entry for a functionId

**Input condition:** An `InputSet` references a `functionId` that does not exist in the `functionIdToName` map.

**Behavior:** `functionIdToName[functionId]` returns `undefined`. The worker detects this and posts:

```javascript
{ type: 'error', functionId, message: 'No function found for id: {functionId}' }
```

**Result:** `ExecutionError` recorded, no `MeasurementPoint`, pipeline continues.

### 5.9 Error Message Exceeds 500 Characters

**Input condition:** A caught error's `message` property (or `String(err)` for non-Error throws) is longer than 500 characters.

**Behavior:** The message is truncated to 497 characters followed by `'...'` (total length: 500). The truncated string is used in the `ExecutionError.message` field.

**Result:** `ExecutionError` with the truncated message. No data loss beyond the truncation — the error is still attributable to the correct `functionId`.

### 5.10 Worker Posts Multiple Errors for Same functionId

**Input condition:** A function throws at multiple input sizes (e.g., n=10 and n=100 both produce errors).

**Behavior:** The worker posts a `{ type: 'error' }` message for each failure. The parent thread's message handler deduplicates: it checks whether `errors` already contains an entry with the same `functionId`. If an entry already exists, the new error message is discarded. Only the first error per functionId is retained.

**Result:** `errors` contains at most one `ExecutionError` per unique `functionId`.

## 6. Dependencies

### Upstream (S4 depends on):

- **s2-ast-instrumenter**: S4 receives `instrumentedJs` (a `string`) as its primary code payload. S4 depends on S2's contract that `instrumentedJs` contains the `__counters` and `__op` preamble, and that named functions are declared at the top level via `function` keyword (making them accessible in the eval scope). S4 also depends on the instrumented code producing deterministic counter state when executed.
- **s3-input-generator**: S4 receives `InputSet[]` as its input payload. Each `InputSet` contains `functionId`, `n`, and `args` (JSON-serializable). S4 depends on `args` being structured-clone-compatible (guaranteed by the InputSet JSON-serializable constraint in `interface-contracts`).
- **interface-contracts**: S4 imports `InputSet`, `MeasurementPoint`, `ExecutionError`, `ExecutionResult`, and `FunctionBoundary` type definitions from `src/types.ts`. `FunctionBoundary` is used as the `boundaries` parameter to `executeAll()` to build the `functionIdToName` mapping. `ExecutionResult` must not be redeclared locally — the single authoritative definition in `src/types.ts` is required because it crosses the S4→Orchestrator boundary.

### Downstream (components that depend on S4):

- **s5-complexity-analyzer**: Consumes `ExecutionResult.measurements` (an array of `MeasurementPoint`) for curve fitting. Also consumes `ExecutionResult.errors` to classify functions that threw as `RUNTIME_ERROR`. Consumes `ExecutionResult.timedOut` to classify functions with no measurements as `TIMEOUT`.
- **extension-orchestrator**: receives `ExecutionResult` from `executeAll()`, reads `.measurements`, `.errors`, and `.timedOut` to construct `FunctionStatus[]` and pass data to S5.

### External Dependencies:

- **worker_threads** (Node.js built-in, `node:worker_threads`): Provides the `Worker` class for spawning isolated threads. Used with `eval: true` to execute an embedded script string. No npm package required — this is part of the Node.js standard library available in all Node.js versions >= 12.

No third-party npm dependencies. S4 uses only Node.js built-in modules.

## 7. Configuration

| Key | Type | Default | Valid Range | Effect |
|-----|------|---------|-------------|--------|
| `tsComplexity.timeoutMs` | `integer` (milliseconds) | `5000` | `1000–30000` | Maximum wall-clock time the worker is allowed to run before being forcibly terminated via `worker.terminate()`. If the worker has not posted `{ type: 'done' }` within this duration, the parent resolves with `timedOut: true` and includes all measurements collected before the kill. Lower values trade measurement completeness for responsiveness (large-n inputs may not finish). Higher values allow more data points but risk blocking the annotation pipeline on expensive functions. |

**Not configurable (and why):**

- **Worker pooling**: v1 spawns a fresh worker per `executeAll()` call. No pooling. This is a design decision, not a tuning parameter. Pooling would require a counter-reset protocol to guarantee zero state leakage between runs. The ~50ms worker spawn overhead is within the 400ms S4 target budget. A pooling option may be introduced in v1.1 behind a `tsComplexity.workerPooling` flag, but it is not implemented in v1.
- **Worker concurrency**: v1 runs one worker at a time (one per save event). Concurrent workers for multiple files are not supported. The orchestrator is responsible for queuing/debouncing save events.
- **eval vs vm.runInNewContext**: v1 uses `eval()`. The switch to `vm.runInNewContext()` is a v2 security hardening change, not a user-configurable option.

## 8. Acceptance Criteria

### Functional Criteria

- [ ] **AC-1: Fresh worker per call.** Two consecutive calls to `executeAll()` with different `instrumentedJs` strings each spawn a new `Worker` instance. No `Worker` instance is reused across calls. Verified by instrumenting the `Worker` constructor (or mocking `worker_threads.Worker`) and asserting two distinct constructor calls.

- [ ] **AC-2: Worker always terminated.** After `executeAll()` resolves, the spawned `Worker` has been terminated (either via `worker.terminate()` on timeout, or via `worker.terminate()` after receiving `done`/`fatalError`, or via `worker.terminate()` after `error` event). Verified by asserting that `worker.terminate()` was called exactly once per invocation, regardless of outcome.

- [ ] **AC-3: Timeout fires correctly.** Given `instrumentedJs` containing `function spin() { while(true) {} }` and `inputSets: [{ functionId: 'x', n: 1, args: [] }]` with `functionIdToName: { 'x': 'spin' }` and `timeoutMs: 200`, when `executeAll()` is called, then it resolves within 400ms (200ms timeout + 200ms tolerance for worker spawn/teardown), and the result has `timedOut === true` and `measurements === []`.

- [ ] **AC-4: Function throw produces ExecutionError.** Given `instrumentedJs` containing `function thrower() { __op('t1'); throw new Error('boom'); }` and `inputSets: [{ functionId: 't1', n: 1, args: [] }]` with `functionIdToName: { 't1': 'thrower' }`, when `executeAll()` is called, then the result has `errors.length === 1`, `errors[0].functionId === 't1'`, `errors[0].message === 'boom'`, `measurements.length === 0`, and `timedOut === false`.

- [ ] **AC-5: Counter state extracted correctly.** Given `instrumentedJs` containing the bubbleSort example from Section 4.5 and `inputSets: [{ functionId: 'aa11bb22', n: 10, args: [[5,2,8,1,9,3,7,4,6,0]] }]` with `functionIdToName: { 'aa11bb22': 'bubbleSort' }`, when `executeAll()` is called, then `measurements.length === 1`, `measurements[0].opCount === 56`, `measurements[0].nodeCounters['aa11bb22'] === 1`, `measurements[0].nodeCounters['cc33dd44'] === 10`, and `measurements[0].nodeCounters['ee55ff66'] === 45`.

- [ ] **AC-6: Empty inputSets returns immediately.** Given any `instrumentedJs` string and `inputSets: []`, when `executeAll()` is called, then it resolves in less than 5ms with `{ measurements: [], timedOut: false, errors: [] }`. No `Worker` constructor is called.

- [ ] **AC-7: Counter reset between runs.** Given `instrumentedJs` with a function that increments counters, and two InputSets for the same functionId at n=10 and n=100, when `executeAll()` is called, then `measurements[0].opCount` reflects only the n=10 execution and `measurements[1].opCount` reflects only the n=100 execution. The n=100 measurement does not include counts from the n=10 run. Verified by checking that `measurements[1].opCount > measurements[0].opCount` (for a super-linear function) and that neither value equals the sum of both.

- [ ] **AC-8: Partial measurements preserved on timeout.** Given `instrumentedJs` with two functions (`fast` and `slow`), where `fast` completes in <10ms and `slow` runs an infinite loop, and `inputSets` ordered `[fast_input, slow_input]` with `timeoutMs: 500`, when `executeAll()` is called, then the result has `timedOut === true`, `measurements.length === 1` (only `fast`'s measurement), and `measurements[0].functionId` matches `fast`'s functionId.

### Error Handling Criteria

- [ ] **AC-9: Top-level eval SyntaxError.** Given `instrumentedJs: 'function {{{invalid'` and any non-empty `inputSets`, when `executeAll()` is called, then the result has `errors.length === 1`, `errors[0].functionId === '__global__'`, `errors[0].message` starts with `'SyntaxError'`, `measurements === []`, and `timedOut === false`.

- [ ] **AC-10: Anonymous function error.** Given a `FunctionBoundary` with `functionId: 'x1'`, `name: '<anonymous>_L5'`, and `jsStartLine: 5`, and an InputSet referencing functionId `'x1'`, when `executeAll()` is called, then `errors` contains one entry with `functionId === 'x1'` and `message === 'Anonymous function at line 5'`. No `MeasurementPoint` is produced for functionId `'x1'`.

- [ ] **AC-11: Error deduplication.** Given a function that throws at both n=10 and n=100, when `executeAll()` is called, then `errors` contains exactly one `ExecutionError` for that functionId (the first error), not two.

- [ ] **AC-12: Error message truncation.** Given a function that throws an `Error` whose `message` property is 600 characters long, when `executeAll()` is called, then `errors[0].message.length === 500` and `errors[0].message` ends with `'...'`.

### Performance Criteria

- [ ] **AC-13: S4 budget.** Given `instrumentedJs` containing a single bubbleSort function and 7 InputSets (n = 10, 30, 100, 300, 1000, 3000, 10000), when `executeAll()` is called on a machine with 4+ CPU cores and 8+ GB RAM, then it resolves in less than 400ms (target) and always in less than 5000ms (hard limit / timeout).

- [ ] **AC-14: Worker spawn overhead.** The time between `executeAll()` being called and the worker posting its first `measurement` or `error` message is less than 100ms for a trivially small `instrumentedJs` and a single InputSet. This measures the overhead of worker creation + eval, not the user function's execution time.

### Structural Criteria

- [ ] **AC-15: Promise never rejects.** For any combination of valid/invalid `instrumentedJs`, empty/non-empty `inputSets`, and any `timeoutMs` within range, the promise returned by `executeAll()` always resolves (never rejects). All error conditions are captured in the `ExecutionResult.errors` array or the `timedOut` flag.

- [ ] **AC-16: No state leakage.** Two sequential calls to `executeAll()` with different `instrumentedJs` strings produce independent results. The second call's measurements are not influenced by the first call's execution. Verified by running a function that modifies a global variable in the first call, then checking that the global variable does not exist in the second call's worker scope.
