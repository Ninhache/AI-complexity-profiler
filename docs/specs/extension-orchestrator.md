# Extension Orchestrator

> **Status**: APPROVED
> **Author**: architect
> **Created**: 2026-03-27
> **Priority**: MVP
> **Layer**: 6 (Integration)

## 1. Overview

The extension orchestrator is the integration layer of the TypeScript Complexity Profiler. It lives in `src/extension.ts` and exports the two lifecycle hooks required by the VS Code Extension API (`activate` and `deactivate`). Its sole purpose is to wire the six analysis subsystems (S1 through S6) into a single sequential pipeline triggered by file save, manage cancellation when a new save arrives before the previous run completes, own the VS Code status bar item that communicates pipeline state to the user, read user configuration fresh on every run, and register the two user-facing commands (`tsComplexity.analyzeFile` and `tsComplexity.clearAnnotations`). It contains no analysis logic of its own -- every computation is delegated to S1 through S6. If this component did not exist, the six subsystems would be disconnected libraries with no trigger, no lifecycle management, and no way to surface results in the editor.

## 2. User Value

When a developer saves a `.ts` file, the orchestrator is the component that makes something happen. Within one second for a typical file, the developer sees a spinner in the status bar, then a completion message showing how many functions were classified and how long it took. If the file has a compilation error, the status bar changes to an error state and the developer sees a diagnostic in the Problems panel -- immediately, without opening a terminal or running a separate tool. If the developer saves again before the first analysis finishes (common during rapid editing), the first run is silently cancelled and a fresh analysis starts -- the developer never sees stale or conflicting results. The orchestrator also respects the `tsComplexity.enabled` setting: when disabled, saving a `.ts` file produces no analysis, no status bar change, and no worker spawn, so the developer incurs zero performance cost when the extension is installed but not needed.

## 3. Detailed Design

### 3.1 VS Code Lifecycle Hooks

```typescript
export function activate(context: vscode.ExtensionContext): void
```

`activate` is called by VS Code when the extension activates (triggered by `onLanguage:typescript`). It performs the following operations in order:

1. Create an `OutputChannel` named `"TypeScript Complexity Profiler"` via `vscode.window.createOutputChannel()`.
2. Create a `StatusBarItem` via `vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)`. Set its initial state to Idle (see Section 3.5). Set its `command` property to `'tsComplexity.analyzeFile'`. Call `statusBar.show()`.
3. Register the `tsComplexity.analyzeFile` command (see Section 3.6).
4. Register the `tsComplexity.clearAnnotations` command (see Section 3.6).
5. Register a `vscode.workspace.onDidSaveTextDocument` listener that calls `onSave(document)` (see Section 3.3).
6. Push all five disposables (output channel, status bar item, two command registrations, save listener) into `context.subscriptions`.

```typescript
export function deactivate(): void
```

`deactivate` is called by VS Code when the extension deactivates (window close, extension disable, or extension host restart). It performs:

1. Iterate over all entries in the `runningPipelines` map. For each entry, call `controller.abort()`.
2. Clear the `runningPipelines` map.

All VS Code disposables (status bar, listeners, commands, output channel) are disposed automatically by VS Code because they were registered in `context.subscriptions` during `activate`. `deactivate` does not manually dispose them.

### 3.2 Pipeline Cancellation

A module-scoped `Map` stores the active `AbortController` for each file currently being analyzed:

```typescript
const runningPipelines = new Map<string, AbortController>();
```

**On new save for `filePath`:**

1. Retrieve any existing controller: `const existing = runningPipelines.get(filePath);`
2. If `existing` is defined, call `existing.abort()`. This sets the `signal.aborted` flag to `true` on the existing controller.
3. Create a new controller: `const controller = new AbortController();`
4. Store it: `runningPipelines.set(filePath, controller);`

**At each checkpoint inside the pipeline (between every subsystem call):**

```typescript
if (controller.signal.aborted) return;
```

If aborted, the pipeline function returns immediately without updating the status bar (the new run owns the status bar now). No error is logged -- cancellation is a normal, expected event.

**On pipeline completion (success or error):**

```typescript
if (runningPipelines.get(filePath) === controller) {
  runningPipelines.delete(filePath);
}
```

The identity check (`=== controller`) prevents a completed old run from deleting a newer run's entry. If the controller in the map is not the same object, a newer run has started and the old run must not touch the map.

### 3.3 The `onSave` Handler

```typescript
async function onSave(document: vscode.TextDocument): Promise<void>
```

Called by the `onDidSaveTextDocument` listener. Performs:

1. If `document.languageId !== 'typescript'`: return immediately. No status bar change, no log.
2. If `document.uri.scheme !== 'file'`: return immediately. (Filters out untitled, virtual, and git-diff documents.)
3. Read configuration via `getConfig()` (see Section 3.7).
4. If `config.enabled === false`: return immediately.
5. If `config.triggerOnSave === false`: return immediately.
6. Call `runPipeline(document.uri.fsPath, vscode.window.activeTextEditor)`.

### 3.4 The Pipeline Function

```typescript
async function runPipeline(filePath: string, editor: vscode.TextEditor | undefined): Promise<void>
```

This is the core orchestration function. It wires S1 through S6 sequentially with cancellation checks between each stage.

**Steps:**

1. **Cancel previous run.** Retrieve any existing controller for this `filePath` from `runningPipelines`. If one exists, call `abort()` on it. Create a new `AbortController`, store it in the map.

2. **Read configuration** via `getConfig()`.

3. **Set status bar to Running state.** Text: `"$(sync~spin) Analyzing..."`, tooltip: `"Analyzing complexity..."`.

4. **Start timer.** `const startTime = Date.now();`

5. **Log pipeline start.** Write to output channel: `[{timestamp}] tsComplexity: analyzing {filePath}`

6. **Resolve tsConfigPath.** Before invoking S1, the orchestrator determines the TypeScript configuration path:
   ```
   const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
   const candidatePath = workspaceRoot ? path.join(workspaceRoot, 'tsconfig.json') : null;
   const tsConfigPath = (candidatePath && fs.existsSync(candidatePath)) ? candidatePath : null;
   ```
   If no `tsconfig.json` exists at the workspace root, `tsConfigPath` is `null` and S1 uses a default set of compiler options: `{ strict: true, target: ts.ScriptTarget.ES2020 }`. There is no `tsComplexity.tsConfigPath` user setting; discovery is automatic in v1 and requires no user configuration.

7. **S1: Compile.**

   The return value of `compileFile()` is typed as `CompilerBridgeResult`. After the call, the fields are destructured for use by downstream stages:
   ```typescript
   const s1Result: CompilerBridgeResult = await compileFile(filePath, tsConfigPath);
   const { compiledJs, sourceMap, diagnostics } = s1Result;
   ```

   Full stage block:
   ```
   const s1Start = Date.now();
   let s1Result: CompilerBridgeResult;
   try {
     s1Result = await compileFile(filePath, tsConfigPath);
   } catch (err) {
     if (err instanceof CompilerBridgeError) {
       // Set status bar to Compiler Error state
       // Log to output channel: "[{timestamp}] S1 compile: FAILED — {err.message}"
       // Surface the compiler error as a VS Code diagnostic (see §5.1 for full contract):
       // Call S6's diagnostic collection with a vscode.Diagnostic at range = new vscode.Range(0, 0, 0, 0)
       // (line 1, column 0), severity = vscode.DiagnosticSeverity.Error, message = err.message.
       // First call .clear() on the DiagnosticCollection so no stale complexity annotations appear
       // alongside the compiler error, then set the error diagnostic on the file's URI.
       // Delete this controller from runningPipelines (if still current)
       return;
     }
     throw err; // unexpected error — rethrow, caught by outer try/catch
   }
   const s1Elapsed = Date.now() - s1Start;
   outputChannel.appendLine(`[{timestamp}] S1 compile: ${s1Elapsed}ms`);
   ```
   If `s1Result.diagnostics.length > 0`, pass them to S6 for display in the Problems panel. The pipeline continues -- diagnostics are non-fatal.

8. **Abort check.** `if (controller.signal.aborted) return;`

9. **Elapsed check.** If `Date.now() - startTime > 2000`: update status bar text to `"$(sync~spin) Analyzing... ${Date.now() - startTime}ms"`. Also update the tooltip: `statusBar.tooltip = 'Analysis in progress';` to match the Running (slow) state in the §3.5 state machine table.

10. **S2: Instrument.**
    ```
    const s2Start = Date.now();
    const s2Result = instrumentCode(s1Result.compiledJs);
    const s2Elapsed = Date.now() - s2Start;
    outputChannel.appendLine(
      `[{timestamp}] S2 instrument: ${s2Elapsed}ms (${s2Result.functionBoundaries.length} functions, ${s2Result.nodeRegistry.size} nodes)`
    );
    ```

11. **Abort check.** `if (controller.signal.aborted) return;`

12. **S3: Generate inputs.**
    ```
    const s3Start = Date.now();
    const inputSets = generateInputs(
      s2Result.functionBoundaries,
      s1Result.sourceMap,
      config.inputSizes
    );
    const s3Elapsed = Date.now() - s3Start;
    outputChannel.appendLine(`[{timestamp}] S3 generate: ${s3Elapsed}ms (${inputSets.length} InputSets)`);
    ```

13. **Abort check.** `if (controller.signal.aborted) return;`

14. **S4: Execute.**
    ```
    const functionIdToName: Record<string, string> = {};
    for (const fb of s2Result.functionBoundaries) {
      functionIdToName[fb.functionId] = fb.name;
    }

    const s4Start = Date.now();
    const s4Result = await executeAll(
      s2Result.instrumentedJs,
      inputSets,
      functionIdToName,
      config.timeoutMs
    );
    const s4Elapsed = Date.now() - s4Start;
    outputChannel.appendLine(`[{timestamp}] S4 execute: ${s4Elapsed}ms`);
    ```

15. **Abort check.** `if (controller.signal.aborted) return;`

15a. **Timeout status bar transition.** If `s4Result.timedOut === true` AND `s4Result.measurements.length === 0` (all functions timed out): set status bar to Timeout state (`$(warning) All functions timed out`). The pipeline continues to S5 and S6, which will render TIMEOUT decorations for all functions.

16. **Build FunctionStatus array** from S4 result:
    ```
    const functionStatuses: FunctionStatus[] = s2Result.functionBoundaries.map(fb => {
      if (s4Result.timedOut && s4Result.measurements.filter(m => m.functionId === fb.functionId).length === 0) {
        return { functionId: fb.functionId, status: 'timeout' };
      }
      if (s4Result.errors.some(e => e.functionId === fb.functionId)) {
        return { functionId: fb.functionId, status: 'runtime_error' };
      }
      return { functionId: fb.functionId, status: 'ok' };
    });
    ```

17. **S5: Analyze.**
    ```
    const s5Start = Date.now();
    const results = analyzeComplexity(
      s4Result.measurements,
      s2Result.nodeRegistry,
      s1Result.sourceMap,
      s2Result.functionBoundaries,
      functionStatuses,
      config.minConfidence,   // ← add this
    );
    const s5Elapsed = Date.now() - s5Start;
    outputChannel.appendLine(`[{timestamp}] S5 analyze: ${s5Elapsed}ms`);
    ```

18. **Abort check.** `if (controller.signal.aborted) return;`

19. **Verify editor is still open.** If `editor` is `undefined` or `editor.document.isClosed === true`, log `"[{timestamp}] S6 skipped: editor closed"` to the output channel and set the status bar to the Success state (the analysis succeeded even though the annotation target is gone). Skip S6. Jump to step 21.

20. **S6: Annotate.**
    ```
    const s6Start = Date.now();
    applyAnnotations(results, editor, context, {
      warnThreshold:  config.warnThreshold,
      errorThreshold: config.errorThreshold,
      showSidePanel:  config.showSidePanel,
    });
    const s6Elapsed = Date.now() - s6Start;
    outputChannel.appendLine(`[{timestamp}] S6 annotate: ${s6Elapsed}ms`);
    ```

21. **Log summary and set status bar to Success.**
    ```
    const totalElapsed = Date.now() - startTime;
    const summary = results
      .filter(r => !['INSUFFICIENT_DATA'].includes(r.complexity))
      .map(r => `${r.functionName}: ${r.complexity}`)
      .join(', ');
    outputChannel.appendLine(`[{timestamp}] total: ${totalElapsed}ms — ${summary}`);
    ```
    Set status bar text: `"$(check) Complexity ${totalElapsed}ms"`, tooltip: `"Last analysis: ${results.length} functions classified"`.

22. **Clean up map entry.**
    ```
    if (runningPipelines.get(filePath) === controller) {
      runningPipelines.delete(filePath);
    }
    ```

**Outer error handler:** The entire pipeline (steps 6-22) is wrapped in a `try/catch`. If any uncaught error reaches the catch block:

- Set status bar to Analysis Error state: text `"$(error) Complexity: error"`, tooltip `"See Output panel for details"`.
- Log the full error to the output channel: `"[{timestamp}] tsComplexity: pipeline failed — {error.message}\n{error.stack}"`.
- Clean up the map entry (same identity check as step 22).

### 3.5 Status Bar State Machine

One `vscode.StatusBarItem` is created at activation. It transitions through these states:

| State | Text | Tooltip | Trigger |
|-------|------|---------|---------|
| Idle | `$(beaker) Complexity` | `TypeScript Complexity Profiler` | Activation (initial state), or after `clearAnnotations` command |
| Running | `$(sync~spin) Analyzing...` | `Analyzing complexity...` | Pipeline step 3 |
| Running (slow) | `$(sync~spin) Analyzing... [N]ms` | `Analysis in progress` | Pipeline step 9, when elapsed > 2000ms |
| Success | `$(check) Complexity [elapsed]ms` | `Last analysis: [N] functions classified` | Pipeline step 21 |
| Timeout | `$(warning) Complexity: timeout` | `Worker timed out -- try reducing file size` | S4 returns `timedOut: true` AND all functions have 0 measurements |
| Compiler Error | `$(error) Complexity: compile error` | `TypeScript compilation failed` | Pipeline step 7 catches `CompilerBridgeError` |
| Analysis Error | `$(error) Complexity: error` | `See Output panel for details` | Outer error handler catches any uncaught error |

**State transitions:**

- Idle -> Running: on pipeline start (step 3)
- Running -> Running (slow): elapsed > 2000ms at step 9
- Running -> Success: pipeline completes without error
- Running -> Timeout: S4 returns `timedOut: true` with no measurements for any function
- Running -> Compiler Error: S1 throws `CompilerBridgeError`
- Running -> Analysis Error: any uncaught error in the pipeline
- Any state -> Running: new save triggers a new pipeline run
- Any state -> Idle: `clearAnnotations` command executed

Clicking the status bar item in any state fires the `tsComplexity.analyzeFile` command.

**Timeout vs. Success disambiguation:** When `s4Result.timedOut === true` but some measurement points exist (partial results -- some input sizes completed before the timeout), the pipeline continues through S5 and S6 with the partial data. The status bar shows Success state, not Timeout. The Timeout status bar state is reserved for the case where `timedOut === true` AND `s4Result.measurements.length === 0`.

### 3.6 Command Registrations

Two commands are registered during `activate`:

**`tsComplexity.analyzeFile`**

Manually triggers the analysis pipeline for the active editor's file.

```typescript
vscode.commands.registerCommand('tsComplexity.analyzeFile', () => {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === 'typescript' && editor.document.uri.scheme === 'file') {
    runPipeline(editor.document.uri.fsPath, editor);
  }
});
```

If no active editor, or the active editor is not a TypeScript file, or the URI scheme is not `file`: the command does nothing. No error message, no status bar change, no output channel log.

**`tsComplexity.clearAnnotations`**

Clears all complexity annotations from the active editor.

```typescript
vscode.commands.registerCommand('tsComplexity.clearAnnotations', () => {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    clearAnnotations(editor);
    // Set status bar to Idle state
  }
});
```

`clearAnnotations` is an S6 function. After clearing, the status bar reverts to Idle state.

### 3.7 Configuration Access

```typescript
function getConfig(): OrchestratorConfig {
  const cfg = vscode.workspace.getConfiguration('tsComplexity');
  return {
    enabled:        cfg.get<boolean>('enabled', true),
    triggerOnSave:  cfg.get<boolean>('triggerOnSave', true),
    timeoutMs:      cfg.get<number>('timeoutMs', 5000),
    inputSizes:     cfg.get<number[]>('inputSizes', [10, 30, 100, 300, 1000, 3000, 10000]),
    minConfidence:  cfg.get<number>('minConfidence', 0.92),
    warnThreshold:  cfg.get<string>('warnThreshold', 'O(n^2)'),
    errorThreshold: cfg.get<string>('errorThreshold', 'O(n^3)'),
    showSidePanel:  cfg.get<boolean>('showSidePanel', true),
  };
}
```

```typescript
interface OrchestratorConfig {
  enabled:        boolean;
  triggerOnSave:  boolean;
  timeoutMs:      number;
  inputSizes:     number[];
  minConfidence:  number;
  warnThreshold:  string;
  errorThreshold: string;
  showSidePanel:  boolean;
}
```

Configuration is read fresh on every call to `getConfig()`. It is never cached at the module level. Changes made by the user in VS Code settings take effect on the very next save or manual `analyzeFile` invocation, without reloading or restarting the extension.

### 3.8 Output Channel

An `OutputChannel` named `"TypeScript Complexity Profiler"` is created once in `activate`. All pipeline logging uses this channel exclusively. No calls to `console.log`, `console.error`, or `console.warn` are made anywhere in the extension host code. The output channel is pushed to `context.subscriptions` and disposed automatically on deactivation.

**Log format:**

```
[{ISO 8601 timestamp}] {message}
```

Example:

```
[2026-03-26T14:32:01.123Z] tsComplexity: analyzing /home/user/project/src/utils.ts
[2026-03-26T14:32:01.310Z] S1 compile: 187ms
[2026-03-26T14:32:01.333Z] S2 instrument: 23ms (3 functions, 7 nodes)
[2026-03-26T14:32:01.341Z] S3 generate: 8ms (21 InputSets)
[2026-03-26T14:32:01.653Z] S4 execute: 312ms
[2026-03-26T14:32:01.657Z] S5 analyze: 4ms
[2026-03-26T14:32:01.669Z] S6 annotate: 12ms
[2026-03-26T14:32:01.669Z] total: 546ms -- bubbleSort: O(n^2), binarySearch: O(log n), helper: O(1)
```

### 3.9 Activation Events

The extension activates on `onLanguage:typescript` (declared in `package.json` `activationEvents`). This means VS Code loads and calls `activate()` the first time any TypeScript file is opened.

The `onDidSaveTextDocument` listener registered during `activate` fires for all file saves in the workspace, but the `onSave` handler returns immediately for non-TypeScript files (step 1 of Section 3.3). This filter is in the handler, not in the VS Code registration, because `onDidSaveTextDocument` does not support language filtering at the registration level.

## 4. Data Model & Logic

### 4.1 The `runningPipelines` Map

```typescript
const runningPipelines = new Map<string, AbortController>();
```

**Key**: Absolute file path (`string`), obtained from `document.uri.fsPath`. Example: `"/home/user/project/src/utils.ts"`.

**Value**: The `AbortController` instance for the currently active pipeline run on that file.

**Invariants:**

- The map contains at most one entry per file path at any time.
- An entry exists in the map only while a pipeline is actively executing for that file.
- After pipeline completion (success, error, or cancellation), the entry is removed (with an identity check to avoid removing a newer run's entry).
- The map is never serialized, persisted, or exposed outside the module.

**Size bound**: The map can contain at most one entry per `.ts` file that has been saved while a previous save is still being analyzed. In practice, this is 1 in most workflows (user edits one file at a time). The theoretical maximum is the number of `.ts` files saved concurrently during a very slow analysis, bounded by the workspace file count. Memory overhead is negligible (one `AbortController` per entry).

### 4.2 AbortController Signal Checking

The `AbortController` pattern uses the built-in web/Node.js `AbortController` class. Each pipeline run creates one controller and checks `controller.signal.aborted` at five checkpoints:

| Checkpoint | Between | If aborted |
|------------|---------|------------|
| 1 | S1 and S2 | Return silently. S1 result is discarded. |
| 2 | S2 and S3 | Return silently. S2 result is discarded. |
| 3 | S3 and S4 | Return silently. InputSets are discarded. |
| 4 | S4 and S5 | Return silently. Worker has already completed or been killed by the new run. |
| 5 | S5 and editor-closed check | Return silently. ComplexityResult[] is discarded. |

When a checkpoint detects `aborted === true`, the pipeline function returns immediately with no status bar update, no output channel log, and no map cleanup (the new run owns both). The worker created by S4 for the aborted run may still be executing in a background thread; it will complete and its results will be ignored because no code holds a reference to the old promise's resolve callback (the `executeAll` promise is abandoned).

**v1 known limitation**: `executeAll()` does not expose a cancellation handle. When an abort is requested while S4 is executing, the orchestrator cannot terminate the worker externally. The orchestrator marks the run as cancelled (the promise chain is abandoned) and discards any results that arrive from S4, but the worker continues running until it completes or times out on its own. This limitation will be resolved in v1.1 when `executeAll()` returns a `{ result: Promise<ExecutionResult>, abort: () => void }` handle.

### 4.3 Per-Stage Timing Measurement

Each subsystem call is bracketed with `Date.now()` calls:

```
const stageStart = Date.now();
// ... call subsystem ...
const stageElapsed = Date.now() - stageStart;
```

`Date.now()` is used (not `performance.now()`) because:
- Wall-clock time is the user-relevant metric for status bar display.
- Millisecond precision is sufficient for the timing ranges involved (20ms to 5000ms).
- `Date.now()` is available in all Node.js versions without importing `perf_hooks`.

The `startTime` variable (set before S1) measures total pipeline wall-clock time and is displayed in the status bar on success.

### 4.4 Worked Timing Example

**Scenario:** User saves `src/utils.ts` containing `bubbleSort`, `binarySearch`, and `helper` (a constant-time function).

**Output channel log:**

```
[2026-03-26T14:32:01.123Z] tsComplexity: analyzing /home/user/project/src/utils.ts
[2026-03-26T14:32:01.310Z] S1 compile: 187ms
[2026-03-26T14:32:01.333Z] S2 instrument: 23ms (3 functions, 7 nodes)
[2026-03-26T14:32:01.341Z] S3 generate: 8ms (21 InputSets)
[2026-03-26T14:32:01.653Z] S4 execute: 312ms
[2026-03-26T14:32:01.657Z] S5 analyze: 4ms
[2026-03-26T14:32:01.669Z] S6 annotate: 12ms
[2026-03-26T14:32:01.669Z] total: 546ms -- bubbleSort: O(n^2), binarySearch: O(log n), helper: O(1)
```

**Status bar transitions during this run:**

1. `$(beaker) Complexity` (Idle -- before save)
2. `$(sync~spin) Analyzing...` (Running -- at pipeline step 3)
3. `$(check) Complexity 546ms` (Success -- at pipeline step 20)

The elapsed time of 546ms is below the 2000ms threshold, so the Running (slow) state is never entered.

### 4.5 Worked Timing Example: Slow File

**Scenario:** User saves a 400-line file. S4 execution takes 3200ms.

**Output channel log:**

```
[2026-03-26T14:35:00.000Z] tsComplexity: analyzing /home/user/project/src/heavy.ts
[2026-03-26T14:35:00.450Z] S1 compile: 450ms
[2026-03-26T14:35:00.520Z] S2 instrument: 70ms (12 functions, 31 nodes)
[2026-03-26T14:35:00.545Z] S3 generate: 25ms (84 InputSets)
[2026-03-26T14:35:03.745Z] S4 execute: 3200ms
[2026-03-26T14:35:03.760Z] S5 analyze: 15ms
[2026-03-26T14:35:03.790Z] S6 annotate: 30ms
[2026-03-26T14:35:03.790Z] total: 3790ms -- ...
```

**Status bar transitions:**

1. `$(beaker) Complexity` (Idle)
2. `$(sync~spin) Analyzing...` (Running)
3. `$(sync~spin) Analyzing... 2070ms` (Running slow -- at step 9 after S1 completes, elapsed > 2000ms)
4. `$(check) Complexity 3790ms` (Success)

Note: the elapsed-check in step 9 only fires once (after S1). It does not update continuously. The 2000ms threshold check uses `Date.now() - startTime` at that single checkpoint.

### 4.6 FunctionStatus Construction Algorithm

The orchestrator builds the `FunctionStatus[]` array that S5 requires, because S5 does not receive `ExecutionResult` directly.

**See §3.4 Step 16 for the canonical algorithm. The description here is illustrative only.**

For each `FunctionBoundary` in `s2Result.functionBoundaries`:

1. If `s4Result.timedOut === true` AND `s4Result.measurements.filter(m => m.functionId === fb.functionId).length === 0`: status is `'timeout'`.
2. Else if `s4Result.errors.some(e => e.functionId === fb.functionId)`: status is `'runtime_error'`.
3. Else: status is `'ok'`.

This logic ensures that:
- A function that timed out with no data is `'timeout'`.
- A function that threw for all input sizes is `'runtime_error'`.
- A function that threw for some input sizes but succeeded for others is `'ok'` (partial data is usable by S5).
- A function where the worker timed out mid-execution but some measurements were already collected is `'ok'` (partial data, not timeout).

## 5. Edge Cases & Error Handling

### 5.1 CompilerBridgeError from S1

**Trigger:** S1 throws `CompilerBridgeError` (file does not exist, file is not readable, TypeScript is not installed).

**Behavior:**
- Status bar is set to Compiler Error state: text `"$(error) Complexity: compile error"`, tooltip `"TypeScript compilation failed"`.
- Output channel logs: `"[{timestamp}] S1 compile: FAILED -- {err.message}"`.
- S6's diagnostic collection receives a diagnostic with the error message, positioned at line 1, column 0, severity Error.
- S2, S3, S4, S5, and S6 annotation rendering are **not** called.
- The `runningPipelines` entry for this file is deleted (with identity check).

**State after:** Status bar shows Compiler Error. Output channel contains the failure message. No workers were spawned.

### 5.2 S4 Timeout (Full)

**Trigger:** S4 returns `{ measurements: [], timedOut: true, errors: [] }` -- the worker was killed by the timeout and no measurement data was collected for any function.

**Behavior:**
- Status bar is set to Timeout state: text `"$(warning) Complexity: timeout"`, tooltip `"Worker timed out -- try reducing file size"`.
- Output channel logs: `"[{timestamp}] S4 execute: {elapsed}ms (TIMEOUT)"`.
- S5 is still called with the empty measurements array and `FunctionStatus[]` where all entries have `status: 'timeout'`. S5 returns `ComplexityResult[]` with `complexity: 'TIMEOUT'` for all functions.
- S6 is called to render the TIMEOUT decorations.

**State after:** Status bar shows Timeout. Each function has a `TIMEOUT` annotation. Output channel shows the full timing breakdown.

### 5.3 S4 Timeout (Partial)

**Trigger:** S4 returns `{ measurements: [...partial...], timedOut: true, errors: [] }` -- the worker was killed by the timeout but some input sizes for some functions completed before the kill.

**Behavior:**
- The orchestrator builds `FunctionStatus[]` using the algorithm in Section 4.6. Functions with measurements get `status: 'ok'`; functions without measurements get `status: 'timeout'`.
- S5 and S6 are called normally.
- Status bar shows Success state (not Timeout) because partial results were produced.
- Output channel logs: `"[{timestamp}] S4 execute: {elapsed}ms (partial -- timeout after {n} of {total} measurements)"`.

**State after:** Some functions have complexity annotations; others have TIMEOUT annotations.

### 5.4 S4 Execution Errors (Partial Results)

**Trigger:** S4 returns `{ measurements: [...some...], timedOut: false, errors: [{functionId: 'abc', message: 'Cannot read property of undefined'}] }` -- one or more functions threw during execution, but others succeeded.

**Behavior:**
- `FunctionStatus[]` marks the errored functions with `status: 'runtime_error'` (if they have no measurements) or `status: 'ok'` (if they have partial measurements).
- S5 classifies errored functions as `RUNTIME_ERROR` and successful functions normally.
- S6 renders appropriate decorations for each function.
- Status bar shows Success state.
- Output channel logs the error: `"[{timestamp}] S4: function {functionName} threw: {message}"`.

**State after:** Functions that succeeded have complexity annotations. Functions that threw have RUNTIME_ERROR annotations.

### 5.5 Editor Closed Between Save and Annotation

**Trigger:** The user saves a `.ts` file, then closes the editor tab before the pipeline reaches S6 (step 18).

**Behavior:**
- At step 18, the pipeline checks `editor === undefined || editor.document.isClosed === true`.
- If true: S6 is skipped. The output channel logs: `"[{timestamp}] S6 skipped: editor closed"`.
- The status bar still shows Success state with the elapsed time and function count, because the analysis itself succeeded.

**State after:** No decorations are applied (the editor is gone). The analysis results are logged but not visible. If the user reopens the file and saves again, a fresh pipeline run will apply annotations.

### 5.6 Save of Non-TypeScript File

**Trigger:** The `onDidSaveTextDocument` listener fires for a `.js`, `.json`, `.md`, or any non-`.ts` file.

**Behavior:** The `onSave` handler checks `document.languageId !== 'typescript'` at step 1 and returns immediately. No status bar change, no output channel log, no worker spawn, no entry in `runningPipelines`.

**State after:** Unchanged from before the save.

### 5.7 Rapid Successive Saves (Triple Save)

**Trigger:** User saves a `.ts` file three times in rapid succession (e.g., within 100ms).

**Behavior:**
- Save 1: Creates `AbortController A`. Pipeline starts running.
- Save 2 (arrives during S1 of Save 1): Calls `A.abort()`. Creates `AbortController B`. Pipeline for Save 2 starts. Pipeline for Save 1 hits its next abort check and returns silently.
- Save 3 (arrives during S1 of Save 2): Calls `B.abort()`. Creates `AbortController C`. Pipeline for Save 3 starts. Pipeline for Save 2 hits its next abort check and returns silently.
- Only pipeline for Save 3 runs to completion.

**Race condition analysis:** There is no race condition because:
- All code runs on the extension host's single-threaded event loop (save events are processed sequentially).
- Each save synchronously sets the new controller in the map before any `await` yields.
- The abort check in the old pipeline reads `signal.aborted` after the next `await` resumes, by which time the abort has already been called.

**State after:** Only the last save's results are displayed. The first two runs produced no output, no decorations, and no status bar artifacts.

### 5.8 Extension Host Process Killed Mid-Run

**Trigger:** VS Code kills the extension host process (crash, forced restart, window close) while a pipeline is running.

**Behavior:** The extension host process terminates. All `worker_threads` workers spawned by S4 die with the process (they are in-process threads, not separate OS processes). No cleanup is needed and no cleanup runs -- `deactivate` may or may not be called by VS Code depending on how the process was killed.

**State after:** All state is lost. On next activation, the extension starts fresh with an empty `runningPipelines` map and an Idle status bar.

### 5.9 `tsComplexity.enabled` Set to `false`

**Trigger:** User changes `tsComplexity.enabled` to `false` in VS Code settings.

**Behavior:** The next `onSave` call reads the configuration at step 3 and checks `config.enabled` at step 4. Since it is `false`, the handler returns immediately. No status bar change, no output channel log, no worker spawn.

**Important:** Already-running pipelines are NOT cancelled when `enabled` changes. The change only affects the next save. If a pipeline is mid-execution when `enabled` is set to `false`, that pipeline runs to completion and applies its results normally.

**State after:** The status bar retains whatever state it was in before the setting change. Subsequent saves produce no analysis.

### 5.10 S2 Throws (Acorn Parse Error)

**Trigger:** S2's `instrumentCode` throws because the compiled JavaScript from S1 is not valid ES2020 (e.g., S1 produced a partial or malformed JS output due to severe syntax errors in the source).

**Behavior:** The outer `try/catch` around the pipeline catches the error.
- Status bar is set to Analysis Error state: text `"$(error) Complexity: error"`, tooltip `"See Output panel for details"`.
- Output channel logs: `"[{timestamp}] tsComplexity: pipeline failed -- {error.message}\n{error.stack}"`.
- S3, S4, S5, S6 are not called.
- The `runningPipelines` entry is cleaned up.

**State after:** Status bar shows Analysis Error. The output channel contains the error details.

### 5.11 Empty File (No Functions)

**Trigger:** The saved `.ts` file contains no function declarations or expressions (e.g., only imports, type declarations, or empty content).

**Behavior:** S1 compiles successfully. S2 instruments successfully but returns `functionBoundaries: []` and `nodeRegistry` as an empty `Map`. S3 receives an empty boundaries array and returns `inputSets: []`. S4 receives no input sets and returns `{ measurements: [], timedOut: false, errors: [] }`. S5 receives no measurements and returns `results: []`. S6 receives an empty results array and renders no decorations.

- Status bar shows Success: `"$(check) Complexity {elapsed}ms"`, tooltip `"Last analysis: 0 functions classified"`.
- Output channel logs show 0 functions, 0 nodes, 0 InputSets, and `total: {N}ms -- (no functions)`.

**State after:** The pipeline completes successfully with no visible annotations.

## 6. Dependencies

### Upstream (this component depends on)

| Component | What the orchestrator consumes | Interface |
|-----------|-------------------------------|-----------|
| **interface-contracts** | All shared types (`CompilerBridgeResult`, `CompilerBridgeError`, `InputSet`, `MeasurementPoint`, `ComplexityResult`, `FunctionBoundary`, `NodeMeta`, `ExecutionResult`, `FunctionStatus`, `TSDiagnostic`, `ExecutionError`) | Type imports from `src/types.ts` |
| **s1-compiler-bridge** | `compileFile(filePath, tsConfigPath?)` | Async function returning `Promise<CompilerBridgeResult>`, or throwing `CompilerBridgeError` |
| **s2-ast-instrumenter** | `instrumentCode(compiledJs)` | Synchronous function returning `InstrumentResult` (`{ instrumentedJs, nodeRegistry, functionBoundaries }`) |
| **s3-input-generator** | `generateInputs(functionBoundaries, sourceMap, inputSizes?)` | Synchronous function returning `InputSet[]` |
| **s4-runtime-executor** | `executeAll(instrumentedJs, inputSets, functionIdToName, timeoutMs?)` | Async function returning `Promise<ExecutionResult>` (never rejects) |
| **s5-complexity-analyzer** | `analyzeComplexity(measurements, nodeRegistry, sourceMap, functionBoundaries, functionStatuses, minConfidence)` | Synchronous function returning `ComplexityResult[]` |
| **s6-annotation-engine** | `applyAnnotations(results, editor, context, { warnThreshold, errorThreshold, showSidePanel })`, `clearAnnotations(editor)` | Synchronous functions that mutate VS Code editor decorations. S6's `applyAnnotations()` receives `warnThreshold`, `errorThreshold`, and `showSidePanel` from the orchestrator — it does not read VS Code config independently. |
| **extension-manifest** | `package.json` `contributes.configuration` section defining all `tsComplexity.*` settings | Settings schema read via `vscode.workspace.getConfiguration('tsComplexity')` |
| **VS Code Extension API** | `vscode.ExtensionContext`, `vscode.TextDocument`, `vscode.TextEditor`, `vscode.StatusBarItem`, `vscode.OutputChannel`, `vscode.commands`, `vscode.workspace.onDidSaveTextDocument`, `vscode.workspace.getConfiguration` | Runtime API provided by the VS Code host |

### Downstream (components that depend on this)

| Component | What it consumes from the orchestrator |
|-----------|---------------------------------------|
| None | The orchestrator is the top of the dependency graph. No other component imports from it. VS Code calls `activate` and `deactivate` directly. |

### External Dependencies

| Library | Version Constraint | Purpose |
|---------|-------------------|---------|
| `vscode` (API) | `^1.80.0` | VS Code Extension API -- all editor integration (status bar, commands, output channel, save listener, diagnostics). This is a dev dependency (`@types/vscode`) and a runtime host API, not a bundled package. |

No third-party npm packages are imported by the orchestrator. All subsystem calls are in-process function calls to project-internal modules.

### Bidirectional Reference Status

Every subsystem spec (S1 through S6) must list `extension-orchestrator` as a downstream dependent. As of this writing, S1's spec lists it; S2-S6 specs should be verified and updated if missing.

## 7. Configuration

All configuration is read via `vscode.workspace.getConfiguration('tsComplexity')`. The orchestrator reads these values; the schema definition lives in `extension-manifest` (`package.json`).

| Key | Type | Default | Valid Range / Options | Effect on Pipeline |
|-----|------|---------|----------------------|--------------------|
| `tsComplexity.enabled` | `boolean` | `true` | `true` / `false` | When `false`, the `onSave` handler returns immediately at step 4. No subsystem is called. No status bar change occurs. |
| `tsComplexity.triggerOnSave` | `boolean` | `true` | `true` / `false` | When `false`, the `onSave` handler returns immediately at step 5. The user can still trigger analysis manually via the `tsComplexity.analyzeFile` command. |
| `tsComplexity.timeoutMs` | `number` | `5000` | `1000`--`30000` | Passed to S4 `executeAll()` as the `timeoutMs` parameter. Controls how long the worker is allowed to run before being killed. Lower values reduce maximum wait time but risk incomplete measurements for complex files. |
| `tsComplexity.inputSizes` | `number[]` | `[10, 30, 100, 300, 1000, 3000, 10000]` | Array of positive integers, minimum 3 elements | Passed to S3 `generateInputs()` as the `inputSizes` parameter. Each function is executed once per input size. Fewer sizes means faster execution but less data for curve fitting. S5 requires a minimum of 3 data points to attempt regression; fewer than 3 input sizes guarantees `INSUFFICIENT_DATA` for all functions. |
| `tsComplexity.minConfidence` | `number` | `0.92` | `0.0`--`1.0` | Read by the orchestrator and passed explicitly as the 6th argument to `analyzeComplexity()`. S5 does not read this value from VS Code config directly. Controls the R-squared threshold below which a function is classified as `LOW_CONFIDENCE`. |
| `tsComplexity.warnThreshold` | `string` | `'O(n^2)'` | Any `ComplexityClass` string | Read by the orchestrator and passed explicitly to `applyAnnotations()` for threshold comparison. S6 does not read this value from VS Code config directly. Determines which complexity classes receive Warning-level diagnostics. |
| `tsComplexity.errorThreshold` | `string` | `'O(n^3)'` | Any `ComplexityClass` string | Read by the orchestrator and passed explicitly to `applyAnnotations()` for threshold comparison. S6 does not read this value from VS Code config directly. Determines which complexity classes receive Error-level diagnostics. |
| `tsComplexity.showSidePanel` | `boolean` | `true` | `true` / `false` | Not directly used by the orchestrator. Consumed by S6 to decide whether to open the WebView side panel after annotation. |

**Configuration is read per-run, not cached at activation.** The `getConfig()` function calls `vscode.workspace.getConfiguration('tsComplexity')` on every invocation. This means:
- Changing `timeoutMs` from 5000 to 10000 in settings takes effect on the next save.
- Disabling the extension via `enabled: false` takes effect on the next save.
- No extension reload, restart, or reactivation is required.

## 8. Acceptance Criteria

### Functional Criteria

- [ ] **AC-1: Correct disposable registration.** `activate()` pushes exactly 5 disposables to `context.subscriptions`: 1 output channel, 1 status bar item, 2 command registrations, 1 `onDidSaveTextDocument` listener. After `deactivate()` is called and VS Code disposes the subscriptions, no references to VS Code API objects remain in module scope (verified by checking that `runningPipelines` is empty and the status bar, output channel, and listener variables are not accessed after disposal).

- [ ] **AC-2: Cancellation aborts previous run.** Given a `.ts` file `f` and two sequential saves S1 and S2 where S2 arrives while the S1 pipeline is between S2 (instrument) and S3 (generate): the S1 pipeline's abort signal is set to `true`, the S1 pipeline returns without calling S4/S5/S6, and the S2 pipeline runs to completion and applies its annotations. Verified by logging: the output channel contains a full timing breakdown for S2's run only; S1's run has no S4/S5/S6 log lines.

- [ ] **AC-3: `deactivate()` aborts all running pipelines.** Given two `.ts` files `a.ts` and `b.ts` with pipelines running concurrently (both in S4 execution): calling `deactivate()` sets the abort signal on both controllers. After `deactivate()` returns, `runningPipelines.size === 0`. No error is thrown by `deactivate()`.

- [ ] **AC-4: Disabled extension produces no side effects.** With `tsComplexity.enabled` set to `false`: saving a `.ts` file produces no status bar text change (status bar retains its previous state), no output channel log line, no worker thread spawn, and no call to any subsystem function (S1 through S6).

- [ ] **AC-5: CompilerBridgeError halts pipeline at S1.** Given a `.ts` file path that does not exist: the pipeline catches `CompilerBridgeError`, sets the status bar to `"$(error) Complexity: compile error"`, logs the error message to the output channel, and does not call `instrumentCode`, `generateInputs`, `executeAll`, `analyzeComplexity`, or `applyAnnotations`.

- [ ] **AC-6: Configuration changes take effect on next save.** Given `tsComplexity.timeoutMs` initially set to 5000: changing it to 10000 in VS Code settings and then saving a `.ts` file causes `executeAll` to be called with `timeoutMs = 10000`. No extension reload or restart is performed between the setting change and the save.

- [ ] **AC-7: Per-stage timing logged.** Every successful pipeline run produces exactly 8 log lines in the output channel: 1 "analyzing" line, 5 per-stage timing lines (S1 through S5), 1 S6 timing line, and 1 "total" summary line. Each timing line contains the stage name and elapsed milliseconds as an integer.

- [ ] **AC-8 (v1 known limitation — worker not terminable): Cancellation abandons first run without affecting second.** When a second save arrives while S4 is running, the pipeline promise for the first run is abandoned (the `AbortController.signal` is set to aborted). Verify that: (a) no S5 or S6 calls happen for the abandoned first run, and (b) the S4 worker from the first run completes execution independently in the background without affecting the second run's measurements. The worker is not forcibly terminated in v1 — this is an acknowledged limitation tracked for v2.

- [ ] **AC-9: Status bar visible and correct throughout lifecycle.** The status bar item is visible (`show()` called) from activation until deactivation. During a successful pipeline run, the status bar transitions through exactly: Idle (or previous state) -> Running -> Success. The Success state's text contains the elapsed time in milliseconds and the tooltip contains the function count.

- [ ] **AC-10: All disposables registered with context.subscriptions.** The following VS Code objects are all pushed to `context.subscriptions` during `activate()`: the `StatusBarItem`, the `OutputChannel`, the two `Disposable` objects returned by `vscode.commands.registerCommand`, and the `Disposable` returned by `vscode.workspace.onDidSaveTextDocument`. `deactivate()` does not call `.dispose()` on any of these objects manually -- VS Code handles disposal via the subscriptions array.
