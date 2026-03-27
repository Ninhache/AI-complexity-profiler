/**
 * @file src/extension.ts
 *
 * Extension Orchestrator — Layer 6 (Integration)
 *
 * VS Code lifecycle entry point. Wires S1 through S6 into a sequential pipeline
 * triggered by file save. Manages cancellation, status bar state, output channel
 * logging, and command registration.
 *
 * Exports:
 *   activate(context)  — called by VS Code on extension activation
 *   deactivate()       — called by VS Code on extension deactivation
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { compileFile, resetCache as resetS1Cache } from './s1-compiler-bridge';
import { instrumentCode } from './s2-ast-instrumenter';
import { generateInputs } from './s3-input-generator';
import { executeAll } from './s4-runtime-executor';
import { analyzeComplexity } from './s5-complexity-analyzer';
import {
  applyAnnotations,
  clearAnnotations,
  registerS6Hooks,
  disposeDecorationTypes,
} from './s6-annotation-engine';
import { CompilerBridgeError, CompilerBridgeResult, FunctionStatus } from './types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

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

/** Reads configuration fresh from VS Code settings on every call. Never cached. */
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

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** AbortControllers keyed by filePath — one per in-flight pipeline. */
const runningPipelines = new Map<string, AbortController>();

/** Single output channel for all pipeline logging. Created in activate(). */
let outputChannel: vscode.OutputChannel;

/** Single status bar item. Created in activate(). */
let statusBar: vscode.StatusBarItem;

// ---------------------------------------------------------------------------
// Status bar helpers
// ---------------------------------------------------------------------------

function setStatusIdle(): void {
  statusBar.text = '$(beaker) Complexity';
  statusBar.tooltip = 'TypeScript Complexity Profiler';
}

function setStatusRunning(): void {
  statusBar.text = '$(sync~spin) Analyzing...';
  statusBar.tooltip = 'Analyzing complexity...';
}

function setStatusRunningSlow(elapsedMs: number): void {
  statusBar.text = `$(sync~spin) Analyzing... ${elapsedMs}ms`;
  statusBar.tooltip = 'Analysis in progress';
}

function setStatusSuccess(elapsedMs: number, count: number): void {
  statusBar.text = `$(check) Complexity ${elapsedMs}ms`;
  statusBar.tooltip = `Last analysis: ${count} functions classified`;
}

function setStatusTimeout(): void {
  statusBar.text = '$(warning) Complexity: timeout';
  statusBar.tooltip = 'Worker timed out -- try reducing file size';
}

function setStatusCompilerError(): void {
  statusBar.text = '$(error) Complexity: compile error';
  statusBar.tooltip = 'TypeScript compilation failed';
}

function setStatusAnalysisError(): void {
  statusBar.text = '$(error) Complexity: error';
  statusBar.tooltip = 'See Output panel for details';
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string): void {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function runPipeline(
  filePath: string,
  editor: vscode.TextEditor | undefined,
  context: vscode.ExtensionContext,
): Promise<void> {
  // Step 1: Cancel any existing run for this file.
  const existing = runningPipelines.get(filePath);
  if (existing) {
    existing.abort();
  }
  const controller = new AbortController();
  runningPipelines.set(filePath, controller);

  // Step 2: Read configuration.
  const config = getConfig();

  // Step 3: Set status bar to Running.
  setStatusRunning();

  // Step 4: Start timer.
  const startTime = Date.now();

  // Step 5: Log start.
  log(`tsComplexity: analyzing ${filePath}`);

  try {
    // Step 6: Resolve tsConfigPath.
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const candidatePath = workspaceRoot ? path.join(workspaceRoot, 'tsconfig.json') : null;
    const tsConfigPath = (candidatePath && fs.existsSync(candidatePath)) ? candidatePath : null;

    // Step 7: S1 — Compile.
    const s1Start = Date.now();
    let s1Result: CompilerBridgeResult;
    try {
      s1Result = await compileFile(filePath, tsConfigPath);
    } catch (err) {
      if (err instanceof CompilerBridgeError) {
        setStatusCompilerError();
        log(`S1 compile: FAILED — ${err.message}`);
        // Surface as a diagnostic on line 1 of the file.
        const diagCollection = vscode.languages.createDiagnosticCollection('tsComplexity');
        diagCollection.clear();
        const uri = vscode.Uri.file(filePath);
        const diag = new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 0),
          err.message,
          vscode.DiagnosticSeverity.Error,
        );
        diag.source = 'tsComplexity';
        diagCollection.set(uri, [diag]);
        if (runningPipelines.get(filePath) === controller) {
          runningPipelines.delete(filePath);
        }
        return;
      }
      throw err;
    }
    log(`S1 compile: ${Date.now() - s1Start}ms`);

    // Step 8: Abort check.
    if (controller.signal.aborted) return;

    // Step 9: Elapsed check — update status bar if slow.
    const elapsedSoFar = Date.now() - startTime;
    if (elapsedSoFar > 2000) {
      setStatusRunningSlow(elapsedSoFar);
    }

    // Step 10: S2 — Instrument.
    const s2Start = Date.now();
    const s2Result = instrumentCode(s1Result.compiledJs);
    log(
      `S2 instrument: ${Date.now() - s2Start}ms ` +
      `(${s2Result.functionBoundaries.length} functions, ${s2Result.nodeRegistry.size} nodes)`,
    );

    // Step 11: Abort check.
    if (controller.signal.aborted) return;

    // Step 12: S3 — Generate inputs.
    const s3Start = Date.now();
    const inputSets = generateInputs(
      s2Result.functionBoundaries,
      s1Result.sourceMap,
      filePath,
      config.inputSizes,
    );
    log(`S3 generate: ${Date.now() - s3Start}ms (${inputSets.length} InputSets)`);

    // Step 13: Abort check.
    if (controller.signal.aborted) return;

    // Step 14: S4 — Execute.
    const s4Start = Date.now();
    const s4Result = await executeAll(
      s2Result.instrumentedJs,
      inputSets,
      s2Result.functionBoundaries,
      config.timeoutMs,
    );
    log(`S4 execute: ${Date.now() - s4Start}ms`);

    // Step 15: Abort check.
    if (controller.signal.aborted) return;

    // Step 15a: Timeout status bar — only when ALL functions timed out.
    if (s4Result.timedOut && s4Result.measurements.length === 0) {
      setStatusTimeout();
    }

    // Step 16: Build FunctionStatus array.
    const functionStatuses: FunctionStatus[] = s2Result.functionBoundaries.map((fb) => {
      const hasAnyMeasurement = s4Result.measurements.some(
        (m) => m.functionId === fb.functionId,
      );
      if (s4Result.timedOut && !hasAnyMeasurement) {
        return { functionId: fb.functionId, status: 'timeout' };
      }
      if (s4Result.errors.some((e) => e.functionId === fb.functionId)) {
        return { functionId: fb.functionId, status: 'runtime_error' };
      }
      return { functionId: fb.functionId, status: 'ok' };
    });

    // Step 17: S5 — Analyze.
    const s5Start = Date.now();
    const results = analyzeComplexity(
      s4Result.measurements,
      s2Result.nodeRegistry,
      s1Result.sourceMap,
      s2Result.functionBoundaries,
      functionStatuses,
      config.minConfidence,
    );
    log(`S5 analyze: ${Date.now() - s5Start}ms`);

    // Step 18: Abort check.
    if (controller.signal.aborted) return;

    // Step 19: Verify editor is still open.
    if (!editor || editor.document.isClosed) {
      log('S6 skipped: editor closed');
      const totalElapsed = Date.now() - startTime;
      setStatusSuccess(totalElapsed, results.length);
      if (runningPipelines.get(filePath) === controller) {
        runningPipelines.delete(filePath);
      }
      return;
    }

    // Step 20: S6 — Annotate.
    const s6Start = Date.now();
    applyAnnotations(results, editor, context);
    log(`S6 annotate: ${Date.now() - s6Start}ms`);

    // Step 21: Log summary and set status to Success.
    const totalElapsed = Date.now() - startTime;
    const summary = results
      .filter((r) => r.complexity !== 'INSUFFICIENT_DATA')
      .map((r) => `${r.functionName}: ${r.complexity}`)
      .join(', ');
    log(`total: ${totalElapsed}ms — ${summary}`);
    setStatusSuccess(totalElapsed, results.length);

    // Step 22: Clean up map entry (identity check).
    if (runningPipelines.get(filePath) === controller) {
      runningPipelines.delete(filePath);
    }
  } catch (err) {
    // Outer error handler.
    const error = err as Error;
    setStatusAnalysisError();
    log(`tsComplexity: pipeline failed — ${error.message}\n${error.stack ?? ''}`);
    if (runningPipelines.get(filePath) === controller) {
      runningPipelines.delete(filePath);
    }
  }
}

// ---------------------------------------------------------------------------
// Save handler
// ---------------------------------------------------------------------------

async function onSave(
  document: vscode.TextDocument,
  context: vscode.ExtensionContext,
): Promise<void> {
  if (document.languageId !== 'typescript') return;
  if (document.uri.scheme !== 'file') return;

  const config = getConfig();
  if (!config.enabled) return;
  if (!config.triggerOnSave) return;

  await runPipeline(document.uri.fsPath, vscode.window.activeTextEditor, context);
}

// ---------------------------------------------------------------------------
// VS Code lifecycle hooks
// ---------------------------------------------------------------------------

/**
 * Called by VS Code when the extension activates (triggered by onLanguage:typescript).
 */
export function activate(context: vscode.ExtensionContext): void {
  // 1. Create output channel.
  outputChannel = vscode.window.createOutputChannel('TypeScript Complexity Profiler');

  // 2. Create status bar item.
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'tsComplexity.analyzeFile';
  setStatusIdle();
  statusBar.show();

  // 3. Register tsComplexity.analyzeFile command.
  const analyzeCmd = vscode.commands.registerCommand('tsComplexity.analyzeFile', () => {
    const editor = vscode.window.activeTextEditor;
    if (
      editor &&
      editor.document.languageId === 'typescript' &&
      editor.document.uri.scheme === 'file'
    ) {
      runPipeline(editor.document.uri.fsPath, editor, context);
    }
  });

  // 4. Register tsComplexity.clearAnnotations command.
  const clearCmd = vscode.commands.registerCommand('tsComplexity.clearAnnotations', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      clearAnnotations(editor);
      setStatusIdle();
    }
  });

  // 5. Register save listener.
  const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
    onSave(document, context);
  });

  // 6. Push all disposables.
  context.subscriptions.push(outputChannel, statusBar, analyzeCmd, clearCmd, saveListener);

  // Register S6 activation-time hooks (showFunction command, selection listener, config listener).
  registerS6Hooks(context);

  log('tsComplexity: extension activated');
}

/**
 * Called by VS Code when the extension deactivates.
 */
export function deactivate(): void {
  // Abort all in-flight pipelines.
  for (const [, controller] of runningPipelines) {
    controller.abort();
  }
  runningPipelines.clear();

  // Dispose cached decoration types.
  disposeDecorationTypes();

  // Clear S1 cache.
  resetS1Cache();
}
