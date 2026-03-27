/**
 * @file src/s6-annotation-engine.ts
 *
 * S6 — Annotation Engine
 *
 * Terminal subsystem in the pipeline. Translates ComplexityResult[] into:
 *   - Inline end-of-line text decorations on function declaration lines
 *   - Diagnostics in the VS Code Problems panel
 *   - A WebView side panel with a log-log Canvas chart
 *
 * Public API:
 *   applyAnnotations(results, editor, context)  — atomic decoration + diagnostic update
 *   clearAnnotations(editor)                    — remove all decorations + diagnostics
 *   updateWebView(result, panel)                — send data to WebView
 *   registerS6Hooks(context)                    — activation-time VS Code registrations
 */

import * as vscode from 'vscode';
import { ComplexityResult, ComplexityClass } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Ordered list used for threshold comparison (index = ordinal severity). */
const MATH_COMPLEXITY_ORDER: Record<string, number> = {
  'O(1)':       0,
  'O(log n)':   1,
  'O(n)':       2,
  'O(n log n)': 3,
  'O(n^2)':     4,
  'O(n^3)':     5,
  'O(2^n)':     6,
};

/** Decoration labels per ComplexityClass (spec §3.2). */
const DECORATION_LABELS: Partial<Record<ComplexityClass, string>> = {
  'O(1)':           '  \u0398(1) \u2713',
  'O(log n)':       '  \u0398(log n) \u2713',
  'O(n)':           '  \u0398(n)',
  'O(n log n)':     '  \u0398(n log n)',
  'O(n^2)':         '  \u0398(n\u00b2) \u26a0',
  'O(n^3)':         '  \u0398(n\u00b3) \u2717',
  'O(2^n)':         '  \u0398(2\u207f) \u2717\u2717',
  'LOW_CONFIDENCE': '  ~\u0398(?) \u00b7',
  'TIMEOUT':        '  TIMEOUT',
  'RUNTIME_ERROR':  '  ERROR',
  // INSUFFICIENT_DATA → no decoration
};

/** Dark-theme colors per ComplexityClass (spec §3.2). */
const DARK_COLORS: Partial<Record<ComplexityClass, string>> = {
  'O(1)':           '#4ec994',
  'O(log n)':       '#4ec994',
  'O(n)':           '#4fc1ff',
  'O(n log n)':     '#4fc1ff',
  'O(n^2)':         '#e5c07b',
  'O(n^3)':         '#e06c75',
  'O(2^n)':         '#e06c75',
  'LOW_CONFIDENCE': '#7a7a7a',
  'TIMEOUT':        '#e06c75',
  'RUNTIME_ERROR':  '#e06c75',
};

/** Light-theme colors per ComplexityClass (spec §3.2). */
const LIGHT_COLORS: Partial<Record<ComplexityClass, string>> = {
  'O(1)':           '#1a7f4b',
  'O(log n)':       '#1a7f4b',
  'O(n)':           '#0070c1',
  'O(n log n)':     '#0070c1',
  'O(n^2)':         '#bf8803',
  'O(n^3)':         '#c72e2e',
  'O(2^n)':         '#c72e2e',
  'LOW_CONFIDENCE': '#8a8a8a',
  'TIMEOUT':        '#c72e2e',
  'RUNTIME_ERROR':  '#c72e2e',
};

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Cached decoration types — created once on first applyAnnotations() call. */
let decorationTypeCache: Map<ComplexityClass, vscode.TextEditorDecorationType> | null = null;

/** Stores the last ComplexityResult[] per document URI string for panel lookups. */
const lastResults: Map<string, ComplexityResult[]> = new Map();

/** Active WebView panel, if one exists and has not been disposed. */
let activePanel: vscode.WebviewPanel | undefined;

/** The DiagnosticCollection — created once during activation. */
let diagnosticCollection: vscode.DiagnosticCollection | undefined;

// ---------------------------------------------------------------------------
// Decoration type cache management
// ---------------------------------------------------------------------------

/**
 * Returns the cached decoration type map, creating it on first call.
 * Creates one TextEditorDecorationType per ComplexityClass (except INSUFFICIENT_DATA).
 */
function getDecorationTypeCache(): Map<ComplexityClass, vscode.TextEditorDecorationType> {
  if (decorationTypeCache !== null) {
    return decorationTypeCache;
  }

  decorationTypeCache = new Map();

  const classes: ComplexityClass[] = [
    'O(1)', 'O(log n)', 'O(n)', 'O(n log n)',
    'O(n^2)', 'O(n^3)', 'O(2^n)',
    'LOW_CONFIDENCE', 'TIMEOUT', 'RUNTIME_ERROR',
  ];

  for (const cls of classes) {
    const label = DECORATION_LABELS[cls];
    if (!label) continue;

    const darkColor = DARK_COLORS[cls] ?? '#7a7a7a';
    const lightColor = LIGHT_COLORS[cls] ?? '#8a8a8a';

    const decorationType = vscode.window.createTextEditorDecorationType({
      after: {
        contentText: label,
        color: new vscode.ThemeColor(`tsComplexity.${cls.replace(/[^a-zA-Z0-9]/g, '_')}.foreground`),
        fontStyle: 'italic',
        margin: '0 0 0 1em',
      },
      dark: {
        after: { color: darkColor },
      },
      light: {
        after: { color: lightColor },
      },
      isWholeLine: false,
    });

    decorationTypeCache.set(cls, decorationType);
  }

  return decorationTypeCache;
}

// ---------------------------------------------------------------------------
// Severity computation
// ---------------------------------------------------------------------------

/**
 * Computes the VS Code DiagnosticSeverity for a ComplexityResult given the
 * configured warnThreshold and errorThreshold settings (spec §3.5).
 *
 * Returns null if no diagnostic should be emitted for this result.
 */
function computeSeverity(
  complexity: ComplexityClass,
  warnThreshold: string,
  errorThreshold: string,
): vscode.DiagnosticSeverity | null {
  // Non-mathematical outcomes use fixed severities.
  if (complexity === 'INSUFFICIENT_DATA') return null;
  if (complexity === 'LOW_CONFIDENCE')   return vscode.DiagnosticSeverity.Hint;
  if (complexity === 'TIMEOUT')          return vscode.DiagnosticSeverity.Error;
  if (complexity === 'RUNTIME_ERROR')    return vscode.DiagnosticSeverity.Error;

  const order = MATH_COMPLEXITY_ORDER[complexity];
  if (order === undefined) return null;

  const warnOrder = MATH_COMPLEXITY_ORDER[warnThreshold]  ?? MATH_COMPLEXITY_ORDER['O(n^2)'];
  const errorOrder = MATH_COMPLEXITY_ORDER[errorThreshold] ?? MATH_COMPLEXITY_ORDER['O(n^3)'];

  if (order >= errorOrder) return vscode.DiagnosticSeverity.Error;
  if (order >= warnOrder)  return vscode.DiagnosticSeverity.Warning;
  if (order >= 2)          return vscode.DiagnosticSeverity.Information; // O(n) or above
  return null; // O(1) and O(log n) produce no diagnostic
}

// ---------------------------------------------------------------------------
// Diagnostic message formatting
// ---------------------------------------------------------------------------

/**
 * Formats the diagnostic message for a ComplexityResult (spec §3.3).
 */
function formatDiagnosticMessage(
  result: ComplexityResult,
  severity: vscode.DiagnosticSeverity,
): string {
  const { functionName, complexity, confidence } = result;
  const pct = (confidence * 100).toFixed(0);

  switch (complexity) {
    case 'TIMEOUT':
      return `TIMEOUT — '${functionName}' timed out during complexity analysis`;
    case 'RUNTIME_ERROR':
      return `RUNTIME_ERROR — '${functionName}' threw an error during complexity analysis`;
    case 'LOW_CONFIDENCE':
      return `~O(?) — '${functionName}' complexity is ambiguous (best fit R\u00b2: ${pct}%)`;
    default:
      if (severity === vscode.DiagnosticSeverity.Error) {
        return `${complexity} — '${functionName}' consider refactoring`;
      }
      return `${complexity} — '${functionName}' (confidence: ${pct}%)`;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Applies inline decorations, diagnostics, and updates module-level state for
 * panel focus lookups. All VS Code state changes are applied atomically.
 *
 * @param results  Complexity classification for every function in the file.
 * @param editor   The active TextEditor for the analyzed file.
 * @param context  Extension context (subscriptions, stored state).
 */
export function applyAnnotations(
  results: ComplexityResult[],
  editor: vscode.TextEditor,
  _context: vscode.ExtensionContext,
): void {
  const config = vscode.workspace.getConfiguration('tsComplexity');
  if (config.get<boolean>('enabled') === false) {
    return;
  }

  // Store for panel focus lookups.
  lastResults.set(editor.document.uri.toString(), results);

  const cache = getDecorationTypeCache();
  const collection = getOrCreateDiagnosticCollection();

  // Step 1: Compute all new decoration ranges.
  const pendingDecorations = new Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>();

  for (const result of results) {
    if (result.complexity === 'INSUFFICIENT_DATA') continue;

    const decorationType = cache.get(result.complexity);
    if (!decorationType) continue;

    let lineIndex = result.tsLine - 1;
    if (lineIndex < 0) lineIndex = 0;
    if (lineIndex >= editor.document.lineCount) lineIndex = editor.document.lineCount - 1;

    // Anchor at end-of-line so the `after` text appears after the last character.
    const lineLength = editor.document.lineAt(lineIndex).text.length;
    const decoration: vscode.DecorationOptions = {
      range: new vscode.Range(lineIndex, lineLength, lineIndex, lineLength),
    };

    const existing = pendingDecorations.get(decorationType);
    if (existing) {
      existing.push(decoration);
    } else {
      pendingDecorations.set(decorationType, [decoration]);
    }
  }

  // Step 2: Compute all new diagnostics.
  const warnThreshold  = config.get<string>('warnThreshold')  ?? 'O(n^2)';
  const errorThreshold = config.get<string>('errorThreshold') ?? 'O(n^3)';
  const diagnostics: vscode.Diagnostic[] = [];

  for (const result of results) {
    const severity = computeSeverity(result.complexity, warnThreshold, errorThreshold);
    if (severity === null) continue;

    const lineIndex = Math.max(0, result.tsLine - 1);
    const range = new vscode.Range(lineIndex, 0, lineIndex, Number.MAX_SAFE_INTEGER);
    const message = formatDiagnosticMessage(result, severity);

    const diag = new vscode.Diagnostic(range, message, severity);
    diag.source = 'tsComplexity';
    diagnostics.push(diag);
  }

  // Step 3: Apply atomically — no await between any of these calls.
  for (const [, type] of cache) {
    editor.setDecorations(type, []);
  }
  for (const [type, ranges] of pendingDecorations) {
    editor.setDecorations(type, ranges);
  }
  collection.set(editor.document.uri, diagnostics);
}

/**
 * Removes all complexity decorations and diagnostics for the given editor's document.
 *
 * @param editor The VS Code TextEditor to clear.
 */
export function clearAnnotations(editor: vscode.TextEditor): void {
  if (decorationTypeCache) {
    for (const [, type] of decorationTypeCache) {
      editor.setDecorations(type, []);
    }
  }
  const collection = getOrCreateDiagnosticCollection();
  collection.delete(editor.document.uri);
}

/**
 * Sends a ComplexityResult to the WebView panel for chart rendering.
 * No-op if the panel has been disposed.
 *
 * @param result The ComplexityResult to visualize.
 * @param panel  The WebviewPanel (may be disposed).
 */
export function updateWebView(result: ComplexityResult, panel: vscode.WebviewPanel): void {
  try {
    panel.webview.postMessage({
      type: 'update',
      result: {
        functionName: result.functionName,
        complexity:   result.complexity,
        confidence:   result.confidence,
        dataPoints:   result.dataPoints,
      },
    });
  } catch {
    // Panel is disposed — swallow the error, this is expected.
  }
}

// ---------------------------------------------------------------------------
// Activation-time registrations
// ---------------------------------------------------------------------------

/**
 * Registers all VS Code hooks that S6 owns. Must be called once during extension activation.
 *
 * Registers:
 *   - tsComplexity.showFunction command
 *   - onDidChangeTextEditorSelection listener
 *   - onDidChangeConfiguration listener
 *
 * @param context Extension context — returned Disposables are pushed to context.subscriptions.
 */
export function registerS6Hooks(context: vscode.ExtensionContext): void {
  // Command: open/refresh WebView for the function at the given tsLine.
  const showFunctionCmd = vscode.commands.registerCommand(
    'tsComplexity.showFunction',
    (args: { tsLine: number }) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const results = lastResults.get(editor.document.uri.toString());
      if (!results) return;

      const result = results.find((r) => r.tsLine === args.tsLine);
      if (!result) return;

      // Create or reuse the WebView panel.
      if (!activePanel) {
        activePanel = vscode.window.createWebviewPanel(
          'tsComplexity',
          `Complexity: ${result.functionName}`,
          vscode.ViewColumn.Beside,
          {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [],
          },
        );
        activePanel.onDidDispose(() => {
          activePanel = undefined;
        });
        activePanel.webview.html = getWebViewContent();
      } else {
        activePanel.title = `Complexity: ${result.functionName}`;
        activePanel.reveal(vscode.ViewColumn.Beside, true);
      }

      updateWebView(result, activePanel);
    },
  );
  context.subscriptions.push(showFunctionCmd);

  // Listener: fire showFunction when the cursor moves to a decorated line.
  const selectionListener = vscode.window.onDidChangeTextEditorSelection((event) => {
    const editor = event.textEditor;
    const results = lastResults.get(editor.document.uri.toString());
    if (!results || results.length === 0) return;

    const selectedLine = event.selections[0]?.active.line; // 0-indexed
    if (selectedLine === undefined) return;

    const tsLine = selectedLine + 1; // convert to 1-indexed
    const match = results.find((r) => r.tsLine === tsLine);
    // Only open the panel when the line actually has a visible decoration.
    // INSUFFICIENT_DATA produces no annotation, so clicking that line does nothing.
    if (!match || match.complexity === 'INSUFFICIENT_DATA') return;

    vscode.commands.executeCommand('tsComplexity.showFunction', { tsLine });
  });
  context.subscriptions.push(selectionListener);

  // Listener: clear annotations when the extension is disabled via settings.
  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('tsComplexity.enabled')) return;
    const enabled = vscode.workspace.getConfiguration('tsComplexity').get<boolean>('enabled');
    if (enabled === false) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        clearAnnotations(editor);
      }
    }
  });
  context.subscriptions.push(configListener);
}

/**
 * Disposes all cached decoration types. Call from the extension's deactivate() function.
 */
export function disposeDecorationTypes(): void {
  if (decorationTypeCache) {
    for (const [, type] of decorationTypeCache) {
      type.dispose();
    }
    decorationTypeCache = null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns (or lazily creates) the module-level DiagnosticCollection. */
function getOrCreateDiagnosticCollection(): vscode.DiagnosticCollection {
  if (!diagnosticCollection) {
    diagnosticCollection = vscode.languages.createDiagnosticCollection('tsComplexity');
  }
  return diagnosticCollection;
}

/** Returns the static WebView HTML (chart UI). All dynamic data arrives via postMessage. */
function getWebViewContent(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <style>
    body {
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
    }
    canvas {
      width: 100%;
      height: 100%;
      display: block;
    }
  </style>
</head>
<body>
  <canvas id="chart"></canvas>
  <script>
    const canvas = document.getElementById('chart');
    const ctx = canvas.getContext('2d');

    const COMPLEXITY_COLORS = {
      'O(1)':       '#4ec994',
      'O(log n)':   '#4ec994',
      'O(n)':       '#4fc1ff',
      'O(n log n)': '#4fc1ff',
      'O(n^2)':     '#e5c07b',
      'O(n^3)':     '#e06c75',
      'O(2^n)':     '#e06c75',
    };

    const TRANSFORMS = [
      { cls: 'O(1)',       fn: (n) => 1 },
      { cls: 'O(log n)',   fn: (n) => Math.log2(n) },
      { cls: 'O(n)',       fn: (n) => n },
      { cls: 'O(n log n)', fn: (n) => n * Math.log2(n) },
      { cls: 'O(n^2)',     fn: (n) => n * n },
      { cls: 'O(n^3)',     fn: (n) => n * n * n },
      { cls: 'O(2^n)',     fn: (n) => Math.pow(2, n) },
    ];

    let currentResult = null;

    function fitModel(transform, ns, ops, expCap) {
      let fitNs = ns, fitOps = ops;
      if (expCap) {
        const idx = ns.map((n, i) => i).filter(i => ns[i] <= 30);
        if (idx.length < 2) return null;
        fitNs = idx.map(i => ns[i]);
        fitOps = idx.map(i => ops[i]);
      }
      const xs = fitNs.map(transform);
      let sumXY = 0, sumX2 = 0;
      for (let i = 0; i < xs.length; i++) { sumXY += xs[i] * fitOps[i]; sumX2 += xs[i] * xs[i]; }
      const c = sumX2 === 0 ? 0 : sumXY / sumX2;
      const meanY = fitOps.reduce((a, b) => a + b, 0) / fitOps.length;
      let ssRes = 0, ssTot = 0;
      for (let i = 0; i < xs.length; i++) {
        ssRes += (fitOps[i] - c * xs[i]) ** 2;
        ssTot += (fitOps[i] - meanY) ** 2;
      }
      if (ssTot === 0) return (expCap ? null : 1.0);
      return Math.max(0, Math.min(1, 1 - ssRes / ssTot));
    }

    function computeAllFits(ns, ops) {
      return TRANSFORMS.map(({ cls, fn }) => {
        const isExp = cls === 'O(2^n)';
        const r2 = fitModel(fn, ns, ops, isExp);
        return { cls, fn, r2 };
      }).filter(m => m.r2 !== null).sort((a, b) => b.r2 - a.r2);
    }

    function renderChart(result) {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.scale(dpr, dpr);

      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      const margin = { top: 60, right: 20, bottom: 50, left: 70 };
      const plotW = W - margin.left - margin.right;
      const plotH = H - margin.top - margin.bottom;

      const bg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background') || '#1e1e1e';
      const fg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-foreground') || '#d4d4d4';

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      // Title
      ctx.fillStyle = fg;
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(result.functionName, W / 2, 22);

      const clsColor = COMPLEXITY_COLORS[result.complexity] || '#7a7a7a';
      ctx.fillStyle = clsColor;
      ctx.font = '13px sans-serif';
      const subtitle = (COMPLEXITY_COLORS[result.complexity])
        ? result.complexity + '  R\u00b2 = ' + result.confidence.toFixed(4)
        : result.complexity;
      ctx.fillText(subtitle, W / 2, 42);

      const dp = result.dataPoints;
      if (!dp || dp.length === 0) {
        ctx.fillStyle = fg;
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No data available', W / 2, margin.top + plotH / 2);
        return;
      }

      const ns = dp.map(p => p[0]);
      const ops = dp.map(p => p[1]);

      const xMin = Math.min(...ns), xMax = Math.max(...ns);
      let yMin = Math.min(...ops), yMax = Math.max(...ops);
      if (yMin === yMax) { yMin = yMax === 0 ? 0.5 : yMax / 2; yMax = yMax === 0 ? 2 : yMax * 2; }

      const log2XMin = Math.log2(xMin), log2XMax = Math.log2(xMax);
      const log2YMin = Math.log2(Math.max(yMin, 1)), log2YMax = Math.log2(Math.max(yMax, 1));
      const xRange = log2XMax - log2XMin || 1;
      const yRange = log2YMax - log2YMin || 1;

      function toX(v) { return margin.left + ((Math.log2(v) - log2XMin) / xRange) * plotW; }
      function toY(v) { return margin.top + plotH - ((Math.log2(Math.max(v, 1)) - log2YMin) / yRange) * plotH; }

      // Axes
      ctx.strokeStyle = fg;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(margin.left, margin.top);
      ctx.lineTo(margin.left, margin.top + plotH);
      ctx.lineTo(margin.left + plotW, margin.top + plotH);
      ctx.stroke();

      // X tick marks + labels
      ctx.fillStyle = fg;
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      for (const n of ns) {
        const px = toX(n);
        ctx.beginPath();
        ctx.moveTo(px, margin.top + plotH);
        ctx.lineTo(px, margin.top + plotH + 4);
        ctx.stroke();
        ctx.fillText(n >= 1000 ? (n / 1000) + 'K' : String(n), px, margin.top + plotH + 16);
      }

      // Y tick marks + labels (4 evenly spaced in log space)
      ctx.textAlign = 'right';
      const numYTicks = 5;
      for (let i = 0; i <= numYTicks; i++) {
        const logV = log2YMin + (i / numYTicks) * yRange;
        const v = Math.pow(2, logV);
        const py = toY(v);
        ctx.beginPath();
        ctx.moveTo(margin.left, py);
        ctx.lineTo(margin.left - 4, py);
        ctx.stroke();
        let label;
        if (v >= 1e9) label = (v / 1e9).toFixed(0) + 'G';
        else if (v >= 1e6) label = (v / 1e6).toFixed(0) + 'M';
        else if (v >= 1e3) label = (v / 1e3).toFixed(0) + 'K';
        else label = Math.round(v).toString();
        ctx.fillText(label, margin.left - 8, py + 4);
      }

      // Competing candidate curves (top 3 non-best)
      const fits = computeAllFits(ns, ops);
      const bestCls = result.complexity;
      const competitors = fits.filter(f => f.cls !== bestCls).slice(0, 3);

      for (const comp of competitors) {
        ctx.strokeStyle = '#555555';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        let first = true;
        for (let i = 0; i <= 50; i++) {
          const logN = log2XMin + (i / 50) * xRange;
          const n = Math.pow(2, logN);
          const xs = ns.map(comp.fn);
          let sumXY = 0, sumX2 = 0;
          for (let j = 0; j < xs.length; j++) { sumXY += xs[j] * ops[j]; sumX2 += xs[j] * xs[j]; }
          const c = sumX2 === 0 ? 0 : sumXY / sumX2;
          const y = c * comp.fn(n);
          if (y <= 0) continue;
          const px = toX(n), py = toY(y);
          if (first) { ctx.moveTo(px, py); first = false; }
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Best-fit curve
      if (COMPLEXITY_COLORS[bestCls]) {
        const bestFit = fits.find(f => f.cls === bestCls);
        if (bestFit) {
          const xs = ns.map(bestFit.fn);
          let sumXY = 0, sumX2 = 0;
          for (let i = 0; i < xs.length; i++) { sumXY += xs[i] * ops[i]; sumX2 += xs[i] * xs[i]; }
          const c = sumX2 === 0 ? 0 : sumXY / sumX2;

          ctx.strokeStyle = clsColor;
          ctx.lineWidth = 2;
          ctx.beginPath();
          let first = true;
          for (let i = 0; i <= 50; i++) {
            const logN = log2XMin + (i / 50) * xRange;
            const n = Math.pow(2, logN);
            const y = c * bestFit.fn(n);
            if (y <= 0) continue;
            const px = toX(n), py = toY(y);
            if (first) { ctx.moveTo(px, py); first = false; }
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
      }

      // Data points
      ctx.fillStyle = '#4fc1ff';
      for (const [n, op] of dp) {
        ctx.beginPath();
        ctx.arc(toX(n), toY(op), 4, 0, 2 * Math.PI);
        ctx.fill();
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      if (currentResult) renderChart(currentResult);
    });
    resizeObserver.observe(canvas);

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'update') {
        currentResult = message.result;
        renderChart(currentResult);
      }
    });
  </script>
</body>
</html>`;
}
