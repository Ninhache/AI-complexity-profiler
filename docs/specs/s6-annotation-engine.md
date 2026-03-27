# S6 — Annotation Engine

> **Status**: APPROVED
> **Author**: architect
> **Created**: 2026-03-27
> **Priority**: MVP
> **Layer**: 5 (Presentation)

## 1. Overview

S6 is the terminal subsystem in the complexity profiler pipeline. It receives `ComplexityResult[]` from S5 and translates each result into three VS Code UI elements: an inline end-of-line text decoration on the function's declaration line, a diagnostic entry in the Problems panel (for complexity classes at or above warning level), and a WebView side panel that renders the function's complexity curve as a Canvas chart. S6 owns no computation and performs no analysis -- it is a pure rendering layer. Its sole responsibility is to present the complexity data that the upstream pipeline has already computed, positioned on the correct source line, with the correct severity, color, and label, atomically on each pipeline run so the editor never shows stale or partially-applied decorations.

## 2. User Value

When S6 works correctly, the developer sees complexity information exactly where it matters -- on the same line as the function signature, in a color and symbol that communicates severity at a glance. A green `Theta(1)` checkmark confirms the function is constant-time. A yellow `Theta(n^2)` warning flag draws the eye to a potential quadratic hotspot. A red `Theta(2^n)` double-cross makes it impossible to ignore an exponential function.

The Problems panel integrates with the developer's existing workflow: complexity warnings and errors appear alongside lint errors and TypeScript diagnostics, sorted by severity, filterable by file. A developer reviewing before commit can scan the Problems panel and catch quadratic regressions without opening every file.

The WebView side panel lets the developer inspect the raw evidence behind the classification. Clicking a decorated function line opens a log-log chart showing the measured data points overlaid with the best-fit curve and competing candidates. A developer who sees `Theta(n^2)` and doubts the classification can open the chart, verify the data visually, and decide whether to refactor. The chart turns the complexity label from an opaque verdict into a transparent, verifiable claim.

## 3. Detailed Design

### 3.1 Public Interface

```typescript
/**
 * Applies inline decorations, diagnostics, and optionally opens/updates the WebView
 * for all complexity results in the active editor.
 *
 * This function is called once per pipeline run (triggered by onDidSaveTextDocument).
 * It replaces all previous decorations and diagnostics for the editor's document
 * atomically -- no partial state is ever visible to the user.
 *
 * If the tsComplexity.enabled setting is false, this function returns immediately
 * without modifying any VS Code state.
 *
 * @param results  - The complexity classification for every function in the file.
 *                   May be empty (no functions detected). Must not be null/undefined.
 * @param editor   - The VS Code TextEditor for the file that was analyzed.
 *                   Must be an active, non-disposed editor.
 * @param context  - The extension context, used for storing state (cached decoration types,
 *                   ComplexityResult[] for panel focus lookup).
 */
export function applyAnnotations(
  results:  ComplexityResult[],
  editor:   vscode.TextEditor,
  context:  vscode.ExtensionContext,
): void

/**
 * Removes all complexity decorations and diagnostics for the given editor's document.
 * Clears every decoration type (iterates over all cached decoration types in the
 * module-level decorationTypeCache and calls editor.setDecorations(type, []) for each).
 * Removes the URI from the DiagnosticCollection entirely via diagnosticCollection.delete(uri).
 *
 * Note: `.delete(uri)` removes the URI from the collection entirely; `.set(uri, [])` retains
 * the key with an empty array. Both produce the same Problems panel appearance, but `.delete()`
 * is semantically cleaner for full removal and is what clearAnnotations() uses. In contrast,
 * the atomic update algorithm (§3.4 Step 3c) uses `.set(uri, diagnostics)` to replace the
 * entry in place, which is correct for mid-analysis updates.
 *
 * @param editor - The VS Code TextEditor to clear. Must be an active, non-disposed editor.
 */
export function clearAnnotations(editor: vscode.TextEditor): void

/**
 * Sends a ComplexityResult to the WebView panel for rendering as a complexity chart.
 * Uses panel.webview.postMessage() to send the data to the WebView's JavaScript.
 *
 * If the panel has been disposed (user closed it), this function is a no-op --
 * it does not throw and does not create a new panel.
 *
 * @param result - The ComplexityResult to visualize.
 * @param panel  - The VS Code WebviewPanel. May be disposed (in which case this is a no-op).
 */
export function updateWebView(result: ComplexityResult, panel: vscode.WebviewPanel): void
```

### 3.1.1 Activation-Time Registrations

During extension activation, S6 is responsible for registering the following VS Code API hooks (in addition to creating the `DiagnosticCollection` and initialising module-level state):

- **`tsComplexity.showFunction` command** — registered via `vscode.commands.registerCommand('tsComplexity.showFunction', handler)`. The handler receives a `{ tsLine: number }` argument, looks up the matching `ComplexityResult` in the module-level `lastResults` map, and opens or reuses the WebView panel (see Section 3.6, Panel Focus Interaction).
- **`onDidChangeTextEditorSelection` listener** — registered via `vscode.window.onDidChangeTextEditorSelection(handler)`. The handler converts the 0-indexed selected line to a 1-indexed `tsLine` and fires `tsComplexity.showFunction` if the line corresponds to a decorated function (see Section 3.6, Panel Focus Interaction, step 3).
- **`vscode.workspace.onDidChangeConfiguration` listener** — registered to call `clearAnnotations()` immediately when `tsComplexity.enabled` changes from `true` to `false`. This listener is owned by S6, not the orchestrator.

Both registrations must push their returned `Disposable` objects into `context.subscriptions` so VS Code disposes them automatically on extension deactivation.

### 3.2 Decoration Type Table

One `vscode.TextEditorDecorationType` is created per complexity class the first time `applyAnnotations()` is called and cached in the module-level `decorationTypeCache` variable (see Section 4.2). Decoration types are never recreated -- they persist for the lifetime of the extension host process. The mapping from `ComplexityClass` to decoration type is stored in this module-level `Map<ComplexityClass, vscode.TextEditorDecorationType>`.

| ComplexityClass | Inline Label (contentText) | Diagnostic Severity | Color (dark theme) | Color (light theme) |
|----------------|---------------------------|--------------------|--------------------|---------------------|
| `'O(1)'` | `"  \u0398(1) \u2713"` | None | `#4ec994` (green) | `#1a7f4b` |
| `'O(log n)'` | `"  \u0398(log n) \u2713"` | None | `#4ec994` (green) | `#1a7f4b` |
| `'O(n)'` | `"  \u0398(n)"` | `DiagnosticSeverity.Information` | `#4fc1ff` (blue) | `#0070c1` |
| `'O(n log n)'` | `"  \u0398(n log n)"` | `DiagnosticSeverity.Information` | `#4fc1ff` (blue) | `#0070c1` |
| `'O(n^2)'` | `"  \u0398(n\u00b2) \u26a0"` | `DiagnosticSeverity.Warning` | `#e5c07b` (yellow) | `#bf8803` |
| `'O(n^3)'` | `"  \u0398(n\u00b3) \u2717"` | `DiagnosticSeverity.Error` | `#e06c75` (red) | `#c72e2e` |
| `'O(2^n)'` | `"  \u0398(2\u207f) \u2717\u2717"` | `DiagnosticSeverity.Error` | `#e06c75` (red) | `#c72e2e` |
| `'LOW_CONFIDENCE'` | `"  ~\u0398(?) \u00b7"` | `DiagnosticSeverity.Hint` | `#7a7a7a` (gray) | `#8a8a8a` |
| `'INSUFFICIENT_DATA'` | *(no decoration created)* | None | -- | -- |
| `'TIMEOUT'` | `"  TIMEOUT"` | `DiagnosticSeverity.Error` | `#e06c75` (red) | `#c72e2e` |
| `'RUNTIME_ERROR'` | `"  ERROR"` | `DiagnosticSeverity.Error` | `#e06c75` (red) | `#c72e2e` |

> **Note**: The Diagnostic Severity column in this table reflects **default values only** (based on the default `warnThreshold='O(n^2)'` and `errorThreshold='O(n^3)'`). At runtime, Section 3.5's threshold algorithm governs the actual diagnostic severity assigned to each result. Decoration colors (the `DecorationRenderOptions`) are **fixed** and do not change when thresholds are reconfigured — only the `DiagnosticSeverity` changes. This is an intentional design choice: inline colors use semantic meaning (yellow=warning-class, red=error-class) while the Problems panel severity is user-configurable.

Each `TextEditorDecorationType` is created with `vscode.window.createTextEditorDecorationType()` using:

```typescript
{
  after: {
    contentText: <label from table>,
    color: new vscode.ThemeColor('tsComplexity.<class>.foreground'),
    // Fallback if theme color not registered:
    // dark: { color: <dark color> }, light: { color: <light color> }
    fontStyle: 'italic',
    margin: '0 0 0 1em',
  },
  isWholeLine: false,
}
```

The `INSUFFICIENT_DATA` class does not produce a decoration type. No `TextEditorDecorationType` is allocated for it. Results with `complexity === 'INSUFFICIENT_DATA'` are skipped entirely during decoration application.

### 3.3 Diagnostic Message Formats

Diagnostics are collected in a `vscode.DiagnosticCollection` created once via `vscode.languages.createDiagnosticCollection('tsComplexity')` and stored in extension state.

Diagnostic messages are formatted as follows, with no variation:

**Warning** (for complexity classes where the table above specifies `DiagnosticSeverity.Warning`):
```
Function '${functionName}' has ${complexity} complexity (confidence: ${(confidence * 100).toFixed(0)}%)
```
Example: `Function 'bubbleSort' has O(n^2) complexity (confidence: 100%)`

**Error** (for complexity classes where the table above specifies `DiagnosticSeverity.Error`, excluding `TIMEOUT` and `RUNTIME_ERROR`):
```
Function '${functionName}' has ${complexity} complexity -- consider refactoring
```
Example: `Function 'powerset' has O(2^n) complexity -- consider refactoring`

**Error for TIMEOUT**:
```
Function '${functionName}' timed out during complexity analysis
```
Example: `Function 'infiniteLoop' timed out during complexity analysis`

**Error for RUNTIME_ERROR**:
```
Function '${functionName}' threw an error during complexity analysis
```
Example: `Function 'brokenFunction' threw an error during complexity analysis`

**Hint** (for `LOW_CONFIDENCE`):
```
Function '${functionName}' complexity is ambiguous (best fit R^2: ${(confidence * 100).toFixed(0)}%)
```
Example: `Function 'mysteriousSort' complexity is ambiguous (best fit R^2: 74%)`

**Information** (for `O(n)` and `O(n log n)`):
```
Function '${functionName}' has ${complexity} complexity (confidence: ${(confidence * 100).toFixed(0)}%)
```
Example: `Function 'linearScan' has O(n) complexity (confidence: 99%)`

Each `vscode.Diagnostic` is constructed with:
- `range`: A `vscode.Range` spanning the entire line at `tsLine - 1` (converting from 1-indexed to 0-indexed). Specifically: `new vscode.Range(tsLine - 1, 0, tsLine - 1, Number.MAX_SAFE_INTEGER)`.
- `message`: The formatted string from above.
- `severity`: From the table in Section 3.2.
- `source`: The string `'tsComplexity'`.

### 3.4 Atomic Decoration Update Algorithm

On each pipeline run, all decorations and diagnostics are replaced atomically. The following algorithm prevents flickering (a frame where decorations are cleared but not yet re-applied):

```
Step 1: Compute all new decoration ranges (do not call setDecorations yet)
  For each ComplexityResult in results[]:
    a. If complexity === 'INSUFFICIENT_DATA', skip this result.
    b. Look up the TextEditorDecorationType for this ComplexityClass from the cached Map.
    c. Convert tsLine to VS Code line index: lineIndex = tsLine - 1.
    d. If lineIndex < 0, set lineIndex = 0.
    e. If lineIndex >= editor.document.lineCount, set lineIndex = editor.document.lineCount - 1.
    f. Create a DecorationOptions: { range: new Range(lineIndex, 0, lineIndex, 0) }.
    g. Append to a Map<TextEditorDecorationType, DecorationOptions[]>.

Step 2: Compute all new diagnostics
  For each ComplexityResult in results[]:
    a. If the Diagnostic Severity column in Section 3.2 is "None", skip this result.
    b. Create a vscode.Diagnostic with the message format from Section 3.3.
    c. Append to a Diagnostic[] array.

Step 3: Apply atomically (all calls in a single synchronous block -- no await between them)
  a. For EVERY TextEditorDecorationType in the cached Map (all 10 types that exist):
     Call editor.setDecorations(type, [])   // clear
  b. For each entry in the Map<TextEditorDecorationType, DecorationOptions[]>:
     Call editor.setDecorations(type, ranges)  // apply new
  c. Call diagnosticCollection.set(editor.document.uri, diagnostics)
     // Atomically replaces the full diagnostic list for this URI with the newly computed diagnostics array.
     // This is distinct from clearAnnotations() which uses .delete(uri) to remove
     // the URI key entirely. Both produce the same Problems panel appearance;
     // .set() is used here for atomic replacement, .delete() in clearAnnotations()
     // for full removal.

Step 3a-3c must execute in a single synchronous block with no yielding to the event loop
(no await, no setTimeout, no setImmediate between them).
```

### 3.5 Configurable Severity Thresholds

The severity assigned to each complexity class is further controlled by two user-configurable settings:

- `tsComplexity.warnThreshold`: The minimum complexity class that triggers a `Warning` diagnostic. Default: `'O(n^2)'`. Valid values: any of the 7 mathematical `ComplexityClass` strings.
- `tsComplexity.errorThreshold`: The minimum complexity class that triggers an `Error` diagnostic. Default: `'O(n^3)'`. Valid values: any of the 7 mathematical `ComplexityClass` strings.

The 7 mathematical complexity classes have a total ordering for threshold comparison:

```
O(1) < O(log n) < O(n) < O(n log n) < O(n^2) < O(n^3) < O(2^n)
```

Mapped to ordinal values for comparison:
```typescript
const COMPLEXITY_ORDER: Record<string, number> = {
  'O(1)':       0,
  'O(log n)':   1,
  'O(n)':       2,
  'O(n log n)': 3,
  'O(n^2)':     4,
  'O(n^3)':     5,
  'O(2^n)':     6,
};
```

When determining severity for a mathematical complexity class:
1. If `COMPLEXITY_ORDER[complexity] >= COMPLEXITY_ORDER[errorThreshold]`: severity is `Error`.
2. Else if `COMPLEXITY_ORDER[complexity] >= COMPLEXITY_ORDER[warnThreshold]`: severity is `Warning`.
3. Else if `COMPLEXITY_ORDER[complexity] >= 2` (i.e., `O(n)` or above): severity is `Information`.
4. Else: no diagnostic (severity is `None`).

Non-mathematical classes (`LOW_CONFIDENCE`, `TIMEOUT`, `RUNTIME_ERROR`) always use the fixed severity from the table in Section 3.2, regardless of threshold settings. `INSUFFICIENT_DATA` never produces a diagnostic.

**Invalid threshold values**: If `warnThreshold` or `errorThreshold` is not a recognized `ComplexityClass` string (e.g., the user manually edits settings to an unrecognized value), fall back to the configured default: `'O(n^2)'` for `warnThreshold` and `'O(n^3)'` for `errorThreshold`. Optionally surface a hint-level diagnostic: `DiagnosticSeverity.Hint` with message `'tsComplexity: invalid threshold value "<value>" — using default'` on line 1 of the file.

### 3.6 WebView Side Panel

#### Panel Creation

A `vscode.WebviewPanel` is created with:
```typescript
vscode.window.createWebviewPanel(
  'tsComplexity',                    // viewType
  'Complexity: ${functionName}',     // title (updated on each function focus)
  vscode.ViewColumn.Beside,         // column
  {
    enableScripts: true,             // required for Canvas rendering
    retainContextWhenHidden: true,   // preserve chart state when panel is backgrounded
    localResourceRoots: [],          // no local resources needed -- all inline
  }
)
```

The panel is created lazily on first invocation of the `tsComplexity.showFunction` command. If the panel already exists and is not disposed, it is reused (title updated, data re-sent). If the panel has been disposed by the user, a new panel is created on the next invocation.

A reference to the active panel is stored in a module-level variable (e.g., `let activePanel: vscode.WebviewPanel | undefined`). It is not stored in `context.workspaceState` because `WebviewPanel` is not serializable and does not survive VS Code restarts.

#### Panel Focus Interaction

1. After each pipeline run, `applyAnnotations()` stores the `ComplexityResult[]` array in the module-level `lastResults` map (see Section 4.3), keyed by the document URI string.
2. A VS Code command `tsComplexity.showFunction` is registered during extension activation (see Section 3.1.1). This command receives a `{ tsLine: number }` argument.
3. When the user clicks on a decorated function line in the editor, the extension's `onDidChangeTextEditorSelection` listener fires (registered during activation per Section 3.1.1). The listener searches `lastResults.get(editor.document.uri.toString())` linearly for a `ComplexityResult` where `result.tsLine === selectedLine + 1` (converting 0-indexed VS Code selection line to 1-indexed tsLine). If found, it fires `tsComplexity.showFunction` with that result. With a typical file containing ≤ 100 functions, the O(n) linear search is acceptable.
4. The `tsComplexity.showFunction` handler:
   a. Retrieves `ComplexityResult[]` from the module-level `lastResults` map using `activeEditor.document.uri.toString()` as the key.
   b. Finds the result where `result.tsLine === tsLine`. If no match, does nothing (no panel opened, no error thrown).
   c. If the WebView panel does not exist or is disposed, creates a new panel (per the creation spec above).
   d. Updates the panel title to `'Complexity: ${result.functionName}'`.
   e. Calls `updateWebView(result, panel)`.

#### postMessage Protocol

`updateWebView()` sends data to the WebView via:
```typescript
panel.webview.postMessage({
  type: 'update',
  result: {
    functionName: result.functionName,
    complexity:   result.complexity,
    confidence:   result.confidence,
    dataPoints:   result.dataPoints,  // [number, number][]
  }
});
```

The WebView's `<script>` listens with:
```javascript
window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'update') {
    renderChart(message.result);
  }
});
```

#### Chart Rendering Specification

The WebView HTML content is a single HTML string set via `panel.webview.html = getWebViewContent()`. It contains:
- A `<canvas>` element that fills the panel viewport.
- An inline `<script>` tag with all rendering logic.
- No external CDN dependencies, no external scripts, no external stylesheets.

**Canvas sizing**: The canvas size is set to `canvas.width = canvas.clientWidth * devicePixelRatio` and `canvas.height = canvas.clientHeight * devicePixelRatio`, then scaled back with `ctx.scale(devicePixelRatio, devicePixelRatio)`. CSS sets `canvas { width: 100%; height: 100%; display: block; }`. A `ResizeObserver` on the canvas element re-renders the chart when the panel is resized.

**Axes**:
- X axis: input size `n`. Log base-2 scale. Tick marks and labels at each `n` value present in `dataPoints` (e.g., 10, 30, 100, 300, 1000, 3000, 10000). Pixel position for value `v`: `(log2(v) - log2(xMin)) / (log2(xMax) - log2(xMin)) * plotWidth + leftMargin`.
- Y axis: operation count. Log base-2 scale. Auto-ranged: `yMin = min(opCounts)`, `yMax = max(opCounts)`. If `yMin === yMax` (all op counts identical), set `yMin = yMax / 2` and `yMax = yMax * 2` (or `yMin = 0.5`, `yMax = 2` if all zeros). 4-6 tick marks, evenly spaced in log-space, labeled with SI suffixes (1K, 10K, 1M, etc.).
- Axes drawn as solid lines, 1px, using CSS variable `var(--vscode-editor-foreground)` for color.
- Tick marks: 4px outward from axis line. Labels in 11px font using `var(--vscode-editor-foreground)`.

**Measured data points**: Filled circles at each `(n, opCount)` from `dataPoints`. Color: `#4fc1ff` (blue). Radius: 4px (in CSS pixels, not canvas pixels).

**Best-fit curve**: A solid line connecting 50 evenly-log-spaced points between `xMin` and `xMax`, computed from the complexity model. Color: the same color as the complexity class decoration (from the color column in the decoration table). Line width: 2px. For non-mathematical classes (`LOW_CONFIDENCE`, `TIMEOUT`, `RUNTIME_ERROR`), no best-fit curve is drawn.

**Top-3 competing candidate curves**: For each of the top 3 complexity classes by R-squared (excluding the best-fit), draw a dashed line (dash pattern `[5, 5]`), color `#555555`, line width 1px, connecting 50 evenly-log-spaced points. These curves are only drawn for mathematical complexity classes. If `dataPoints` is empty, no competing curves are drawn.

**Chart title**: The function name, centered horizontally, 16px font, bold, positioned at `y = 20px` from the top of the canvas. Color: `var(--vscode-editor-foreground)`.

**Chart subtitle**: Below the title, centered, 13px font, normal weight. Format: `Theta(n^2)  R^2 = 0.9997` (using the result's complexity and confidence, confidence formatted to 4 decimal places). Color: the complexity class decoration color. For non-mathematical classes, the subtitle shows the class name only (e.g., `LOW_CONFIDENCE`).

**Layout margins**: `top: 60px` (for title + subtitle), `right: 20px`, `bottom: 50px` (for X axis labels), `left: 70px` (for Y axis labels). Plot area fills the remaining space.

**Theme support**: All text, axis lines, and background colors use VS Code CSS variables:
- Background: `var(--vscode-editor-background)`
- Foreground (text, axes): `var(--vscode-editor-foreground)`
- The canvas is cleared with `ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background')` before each render.

**Empty data handling**: If `dataPoints` is an empty array (`[]`), the chart area displays the text `"No data available"` centered horizontally and vertically in the plot area, 16px font, color `var(--vscode-editor-foreground)`. No axes, no curves, no data points are drawn.

### 3.7 Decoration Color Mapping for Chart

The chart best-fit curve color matches the decoration color. The mapping is:

```typescript
const COMPLEXITY_COLORS: Record<string, string> = {
  'O(1)':       '#4ec994',
  'O(log n)':   '#4ec994',
  'O(n)':       '#4fc1ff',
  'O(n log n)': '#4fc1ff',
  'O(n^2)':     '#e5c07b',
  'O(n^3)':     '#e06c75',
  'O(2^n)':     '#e06c75',
};
```

## 4. Data Model & Logic

### 4.1 tsLine to VS Code Range Conversion

`ComplexityResult.tsLine` is 1-indexed (line 1 is the first line of the file). VS Code's `Range` and `Position` are 0-indexed (line 0 is the first line).

**Conversion formula**:
```
lineIndex = result.tsLine - 1
```

**Boundary clamping**:
- If `lineIndex < 0` (should not occur unless `tsLine` is 0 or negative due to a bug): set `lineIndex = 0`.
- If `lineIndex >= editor.document.lineCount` (tsLine beyond end of file): set `lineIndex = editor.document.lineCount - 1`.

**Worked example**: A function declared on TypeScript line 5 has `tsLine = 5`. The VS Code decoration is applied at `lineIndex = 4`, which is `new vscode.Range(4, 0, 4, 0)`.

### 4.2 Decoration Type Cache

Decoration types are stored in a module-level variable (not in `workspaceState`, because `TextEditorDecorationType` is not serializable):

```typescript
let decorationTypeCache: Map<string, vscode.TextEditorDecorationType> | null = null;
```

On first call to `applyAnnotations()`:
1. If `decorationTypeCache` is `null`, create all 10 decoration types (one per ComplexityClass except `INSUFFICIENT_DATA`) using `vscode.window.createTextEditorDecorationType()` with the configuration from Section 3.2.
2. Store them in `decorationTypeCache` keyed by the `ComplexityClass` string literal.
3. On subsequent calls, reuse the existing cache.

**Disposal**: When the extension deactivates, the `deactivate()` function iterates `decorationTypeCache` and calls `.dispose()` on each `TextEditorDecorationType`. This prevents resource leaks.

**Why not recreate**: VS Code has a soft limit on the number of decoration types an extension can create. Recreating types on every save would exhaust this limit after ~100 saves. Caching avoids this.

### 4.3 Stored Results for Panel Lookup

After each pipeline run, `applyAnnotations()` stores the results for later panel focus lookups:

```typescript
// Module-level state
let lastResults: Map<string, ComplexityResult[]> = new Map();
// Keyed by document URI string
```

On each call to `applyAnnotations(results, editor, context)`:
1. `lastResults.set(editor.document.uri.toString(), results)`.
2. When the `tsComplexity.showFunction` command fires, it retrieves results from `lastResults.get(activeEditor.document.uri.toString())`.
3. It finds the matching result by searching `lastResults.get(editor.document.uri.toString())` linearly for a `ComplexityResult` where `result.tsLine === selectedLine + 1` (converting 0-indexed VS Code selection line to 1-indexed tsLine). With a typical file containing ≤ 100 functions, the O(n) linear search is acceptable.

### 4.4 WebView HTML/JS Data Flow

```
Extension Host Process                 WebView (sandboxed iframe)
    |                                       |
    |  panel.webview.html = getContent()    |
    |-------------------------------------->|  (initial load, empty chart)
    |                                       |
    |  panel.webview.postMessage(           |
    |    { type: 'update', result: {...} }) |
    |-------------------------------------->|  window.onmessage fires
    |                                       |  renderChart(result) executes
    |                                       |  Canvas draws axes, points, curves
```

The `getWebViewContent()` function returns a single HTML string. It does not vary between calls (the HTML is static). All dynamic data arrives via `postMessage`. The HTML structure:

```html
<!DOCTYPE html>
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
    // ... inline rendering logic (renderChart function, resize observer, message listener)
  </script>
</body>
</html>
```

**Content Security Policy**: `script-src 'unsafe-inline'` is required because the rendering logic is an inline `<script>`. No external scripts are loaded. `default-src 'none'` blocks all other resource loads (images, fonts, iframes, etc.).

### 4.5 Log-Scale Chart Computation

For the log-log chart, positions are computed as follows:

**Given**: `dataPoints` array of `[n, opCount]` tuples.

**X axis computation**:
```
xMin = min(dataPoints.map(d => d[0]))
xMax = max(dataPoints.map(d => d[0]))
log2XMin = Math.log2(xMin)
log2XMax = Math.log2(xMax)
xRange = log2XMax - log2XMin

For a data point with n-value v:
  xPixel = ((Math.log2(v) - log2XMin) / xRange) * plotWidth + leftMargin
```

**Y axis computation**:
```
yMin = min(dataPoints.map(d => d[1]))
yMax = max(dataPoints.map(d => d[1]))

If yMin === yMax:
  If yMax === 0: yMin = 0.5, yMax = 2
  Else: yMin = yMax / 2, yMax = yMax * 2

log2YMin = Math.log2(Math.max(yMin, 1))   // clamp to 1 to avoid log(0)
log2YMax = Math.log2(Math.max(yMax, 1))
yRange = log2YMax - log2YMin

For a data point with opCount-value v:
  yPixel = plotHeight - ((Math.log2(Math.max(v, 1)) - log2YMin) / yRange) * plotHeight + topMargin
```

**Worked example (bubble sort)**:
- `dataPoints = [[10, 56], [100, 5051], [1000, 500501]]`
- `log2XMin = log2(10) = 3.32`, `log2XMax = log2(1000) = 9.97`
- For n=100: `xPixel = ((6.64 - 3.32) / 6.65) * plotWidth + leftMargin = 0.50 * plotWidth + leftMargin` (midpoint)
- `log2YMin = log2(56) = 5.81`, `log2YMax = log2(500501) = 18.93`
- For opCount=5051: `yPixel = plotHeight - ((12.30 - 5.81) / 13.12) * plotHeight + topMargin`

On a log-log plot, an O(n^2) function produces a straight line with slope 2, which is the visual confirmation that the classification is correct.

### 4.6 Competing Curves Data

The `ComplexityResult` type from `interface-contracts` does not include R-squared scores for all 7 candidate models -- only the best-fit `confidence` score. To render the top-3 competing curves, one of two approaches is used:

**Approach (chosen)**: The `updateWebView` message includes only the `complexity` and `dataPoints`. The WebView JavaScript itself computes the best-fit constant `c` for each of the 7 candidate models using the OLS formula from the S5 spec (`c = sum(x_i * y_i) / sum(x_i^2)`), computes R-squared for each, ranks them, and selects the top 3 non-best candidates.

This avoids modifying the `ComplexityResult` type. The computation is lightweight (7 models x 7 data points = 49 multiplications) and runs in the WebView's JavaScript context.

The WebView JavaScript must apply these linearization transforms before computing R-squared for each candidate model. Using `dataPoints: [n, opCount][]`:

| Model | x_i | y_i | Note |
|---|---|---|---|
| O(1) | 1 | opCount | Constant: R² = 1 - SS_res/SS_tot where predicted = mean(opCount) |
| O(log n) | log2(n) | opCount | — |
| O(n) | n | opCount | — |
| O(n log n) | n·log2(n) | opCount | — |
| O(n²) | n² | opCount | — |
| O(n³) | n³ | opCount | — |
| O(2^n) | Only use points where n ≤ 30 | opCount | Skip if fewer than 2 points qualify |

For each model: `c = Σ(x_i · opCount_i) / Σ(x_i²)`, `predicted_i = c · x_i`, `R² = 1 - Σ(opCount_i - predicted_i)² / Σ(opCount_i - mean)²`. Select the top 3 by descending R².

## 5. Edge Cases & Error Handling

### INSUFFICIENT_DATA result

**Trigger**: A `ComplexityResult` has `complexity === 'INSUFFICIENT_DATA'`.

**Behavior**: No `TextEditorDecorationType` is applied for this result. No `vscode.Diagnostic` is created. The result is stored in `lastResults` for the document, but clicking that function's line does not open the WebView panel (no matching decorated line triggers the selection listener).

**State after**: The editor line for this function has no inline decoration and no Problems panel entry. The function is invisible to the annotation engine.

### TIMEOUT result

**Trigger**: A `ComplexityResult` has `complexity === 'TIMEOUT'`.

**Behavior**: A decoration with label `"  TIMEOUT"` in red (`#e06c75`) is placed on the function's line. A diagnostic with severity `Error` and message `"Function '${functionName}' timed out during complexity analysis"` is added to the Problems panel. The WebView, if opened for this function, shows the chart title and subtitle `"TIMEOUT"` with a `"No data available"` message in the plot area (since `dataPoints` is `[]`).

**State after**: The editor shows a red `TIMEOUT` label. The Problems panel shows an error diagnostic. The WebView panel shows an empty chart with the TIMEOUT label.

### RUNTIME_ERROR result

**Trigger**: A `ComplexityResult` has `complexity === 'RUNTIME_ERROR'`.

**Behavior**: A decoration with label `"  ERROR"` in red (`#e06c75`) is placed on the function's line. A diagnostic with severity `Error` and message `"Function '${functionName}' threw an error during complexity analysis"` is added to the Problems panel. The WebView behavior is identical to TIMEOUT (empty chart, `"No data available"`).

**State after**: The editor shows a red `ERROR` label. The Problems panel shows an error diagnostic.

### Editor closed mid-run

**Trigger**: Between the time the pipeline starts (on save) and the time `applyAnnotations()` is called, the user closes the editor tab.

**Behavior**: Before applying any decorations, `applyAnnotations()` checks `editor.document.isClosed`. If `true`, the function returns immediately without applying decorations or diagnostics. No error is thrown. The results are not stored in `lastResults` for this document.

**State after**: No decorations, no diagnostics. The closed document has no stale annotations.

### WebView panel disposed by user

**Trigger**: The user closes the WebView side panel manually (clicks the X on the panel tab). Subsequently, the user clicks a decorated function line.

**Behavior**: The stored panel reference's `panel.visible` is `false` and `panel.dispose()` has been called by VS Code. The `tsComplexity.showFunction` command handler detects the disposed state (by checking if the panel reference's `onDidDispose` callback has fired -- a boolean flag `isPanelDisposed` is set in the callback). It creates a new `WebviewPanel` with the same parameters as Section 3.6 and updates the stored reference.

**State after**: A new WebView panel opens beside the editor with the selected function's chart.

### dataPoints empty in WebView

**Trigger**: `updateWebView()` sends a result where `dataPoints` is `[]`.

**Behavior**: The WebView's `renderChart()` function detects `result.dataPoints.length === 0`. It clears the canvas with the background color, draws the title and subtitle, then renders the text `"No data available"` centered in the plot area (horizontally: `leftMargin + plotWidth / 2`, vertically: `topMargin + plotHeight / 2`), 16px font, color `var(--vscode-editor-foreground)`. No axes, tick marks, data points, or curves are drawn.

**State after**: The WebView displays the function name, complexity class, and a `"No data available"` message. No JavaScript error is thrown.

### tsLine out of document range

**Trigger**: A `ComplexityResult` has a `tsLine` value that, when converted to 0-indexed (`tsLine - 1`), exceeds `editor.document.lineCount - 1`. This could occur if the source map returned a fallback value for a file that was edited between the pipeline start and annotation application.

**Behavior**: The line index is clamped: `lineIndex = Math.min(tsLine - 1, editor.document.lineCount - 1)`. If `tsLine - 1 < 0`, the line index is clamped to `0`. The decoration and diagnostic are placed at the clamped line. No error is thrown.

**State after**: The annotation appears on the last line of the document (or line 0) instead of the intended line. This is a degraded-accuracy scenario, not a failure.

### Two functions on the same tsLine

**Trigger**: Two `ComplexityResult` entries share the same `tsLine` value.

**Behavior**: This is documented as not expected in valid TypeScript (a single line cannot contain two function declarations). If it occurs, both decorations are applied to the same line. VS Code renders only the last `setDecorations` call for a given decoration type on a given line. If the two functions have different complexity classes (different decoration types), both decorations appear on the line (concatenated visually as separate `after` pseudo-elements). If they have the same complexity class, only one decoration is visible (the last range in the array for that type).

**Assumption**: This case does not occur in valid TypeScript and is not actively defended against. If it does occur, it indicates a bug in S2's boundary detection or S1's source map.

### results array is empty

**Trigger**: `applyAnnotations()` receives `results = []` (the file contains no functions, or all functions were `INSUFFICIENT_DATA`).

**Behavior**: All existing decorations are cleared (Step 3a of the atomic update algorithm runs, clearing every decoration type). The diagnostic collection is set to an empty array for this document URI: `diagnosticCollection.set(uri, [])`. This removes any previously-displayed diagnostics.

**State after**: The editor has no complexity decorations. The Problems panel has no complexity diagnostics for this file. Any previously-shown annotations are gone.

### tsComplexity.enabled is false

**Trigger**: The user changes `tsComplexity.enabled` to `false` in VS Code settings (detected via `onDidChangeConfiguration`).

**Behavior**: The extension immediately calls `clearAnnotations()` on all open editors and clears the `DiagnosticCollection`. From that point forward, `applyAnnotations()` reads the setting via `vscode.workspace.getConfiguration('tsComplexity').get<boolean>('enabled', true)` and returns immediately if `false`, so file saves do not trigger analysis.

**State after**: All decorations and diagnostics are immediately removed when the setting is toggled to `false`. No stale decorations remain in the editor when the extension is disabled. This is consistent with the atomicity guarantee in §3.1, which states decorations must never be stale.

## 6. Dependencies

### Upstream (this component depends on)

| Component | Interface Used | Data Flowing In |
|-----------|---------------|----------------|
| **s5-complexity-analyzer** | `ComplexityResult[]` returned by `analyzeComplexity()` | `functionName`, `tsLine`, `complexity`, `confidence`, `dominantNodeId`, `dominantLine`, `dataPoints` per function |
| **interface-contracts** | `ComplexityResult` type, `ComplexityClass` type | Type definitions for runtime data |
| **VS Code Extension API** | `vscode.TextEditor`, `vscode.ExtensionContext`, `vscode.TextEditorDecorationType`, `vscode.DiagnosticCollection`, `vscode.WebviewPanel`, `vscode.commands.registerCommand('tsComplexity.showFunction', ...)`, `vscode.window.onDidChangeTextEditorSelection(...)`, `vscode.workspace.getConfiguration` | Editor state, decoration API, diagnostics API, WebView API, command registration (jump-to-function on annotation click), selection listener (cursor-position-to-panel update), settings access |

### Downstream (components that depend on this)

| Component | Interface They Consume | Data Flowing Out |
|-----------|----------------------|-----------------|
| **extension-orchestrator** | Calls `applyAnnotations(results, editor, context)` at the end of each pipeline run. Calls `clearAnnotations(editor)` on extension deactivation or file close. | None -- S6 produces VS Code UI state, not data structures consumed by other subsystems |

### External Dependencies

| Dependency | Why Needed | Version Constraint |
|-----------|-----------|-------------------|
| `vscode` (extension API) | All VS Code UI operations: decoration types, diagnostics, WebView panels, commands, configuration | Defined by `engines.vscode` in `package.json` (target: `^1.85.0`) |

No npm packages are used for chart rendering. The Canvas chart is pure inline JavaScript using the browser's Canvas 2D API (available in VS Code's WebView, which runs Chromium).

### Bidirectional Reference Status

- `s5-complexity-analyzer` spec must list `s6-annotation-engine` in its Downstream section (S5 produces the `ComplexityResult[]` that S6 consumes).
- `extension-orchestrator` spec (not yet written) must list `s6-annotation-engine` in its Dependencies section as a component it calls.

## 7. Configuration

| Key | Type | Default | Valid Values | Effect |
|-----|------|---------|-------------|--------|
| `tsComplexity.enabled` | `boolean` | `true` | `true`, `false` | When changed to `false`, the extension immediately calls `clearAnnotations()` on all open editors and clears the `DiagnosticCollection`, so no stale decorations remain. Subsequent file saves do not trigger analysis while `false`. When changed back to `true`, the next file save triggers a full pipeline run and re-applies annotations. |
| `tsComplexity.warnThreshold` | `string` | `'O(n^2)'` | `'O(1)'`, `'O(log n)'`, `'O(n)'`, `'O(n log n)'`, `'O(n^2)'`, `'O(n^3)'`, `'O(2^n)'` | The minimum mathematical complexity class that triggers a `Warning`-severity diagnostic in the Problems panel. Classes below this threshold receive `Information` severity (if `O(n)` or above) or no diagnostic. Setting this to `'O(1)'` causes all mathematical classes to produce at least a warning. |
| `tsComplexity.errorThreshold` | `string` | `'O(n^3)'` | `'O(1)'`, `'O(log n)'`, `'O(n)'`, `'O(n log n)'`, `'O(n^2)'`, `'O(n^3)'`, `'O(2^n)'` | The minimum mathematical complexity class that triggers an `Error`-severity diagnostic. Classes at or above this threshold always produce an error, overriding `warnThreshold`. Setting this to `'O(n^2)'` causes quadratic and above to be errors. Must be >= `warnThreshold` in the complexity ordering; if the user sets `errorThreshold` below `warnThreshold`, `errorThreshold` is silently raised to equal `warnThreshold`. |
| `tsComplexity.showSidePanel` | `boolean` | `true` | `true`, `false` | When `true`, clicking a decorated function line opens the WebView side panel with the complexity chart. When `false`, the `onDidChangeTextEditorSelection` listener does not fire the `tsComplexity.showFunction` command, and the panel is never created or updated automatically. The user can still manually invoke `tsComplexity.showFunction` via the command palette. |

All settings are read from `vscode.workspace.getConfiguration('tsComplexity')` at the time they are needed (not cached at activation time). This means settings changes take effect on the next save/pipeline run without requiring an extension reload.

## 8. Acceptance Criteria

### Functional Criteria

- [ ] **AC-1: Atomic decoration update.** Given a file with 3 functions previously annotated, when the file is saved and the pipeline produces new `ComplexityResult[]`, then between the start of Step 3a (clear) and the end of Step 3b (apply) in the atomic update algorithm, no event loop tick occurs. Verified by: wrapping Step 3a-3c in a synchronous block with no `await`, `setTimeout`, `setImmediate`, or `Promise.then` between `setDecorations` calls. Code review confirms no yielding.

- [ ] **AC-2: Panel focus on click.** Given a file with a decorated function on line 10, when the user places the cursor on line 10, then the WebView side panel opens (or is reused if already open) and displays the complexity chart for the function on line 10. Verified by: selecting line 10 in the editor, observing that a WebView panel appears with the correct function name in the title and a chart rendered on the canvas.

- [ ] **AC-3: Theme support.** Given VS Code running with a dark theme and then switched to a light theme, the WebView chart text, axes, and background update to use the new theme's CSS variable values (`--vscode-editor-background`, `--vscode-editor-foreground`). Verified by: switching themes and observing that the chart background and text colors change to match. No hardcoded colors are used for text, axes, or background in the WebView HTML/JS (only the data point and curve colors are hardcoded as specified).

- [ ] **AC-4: Diagnostics in Problems panel only.** Given a function classified as `O(n^2)`, a `Warning`-severity diagnostic appears in the Problems panel with the message format from Section 3.3. The diagnostic does not produce a gutter icon in the editor (VS Code's `Diagnostic` renders in the Problems panel; gutter icons are controlled separately via `DiagnosticSeverity` display settings which the extension does not override).

- [ ] **AC-5: clearAnnotations removes everything.** Given a file with 5 decorated functions and 3 diagnostics, when `clearAnnotations(editor)` is called, then `editor.setDecorations(type, [])` is called for every decoration type in the cache, and `diagnosticCollection.delete(editor.document.uri)` is called. After the call, the editor shows no inline complexity labels and the Problems panel shows no complexity diagnostics for this file.

- [ ] **AC-6: INSUFFICIENT_DATA produces nothing.** Given a `ComplexityResult` with `complexity === 'INSUFFICIENT_DATA'`, no `TextEditorDecorationType` range is created for this result, no `vscode.Diagnostic` is created, and the function's line in the editor is visually unchanged.

- [ ] **AC-7: Log-scale axes.** Given a bubble sort function with `dataPoints = [[10, 56], [30, 496], [100, 5051], [300, 45151], [1000, 500501], [3000, 4501501], [10000, 50005001]]`, the WebView chart renders all 7 data points as filled blue circles. On the log-log axes, the points form a straight line (visually verifiable). The X axis tick labels include `10`, `30`, `100`, `300`, `1000`, `3000`, `10000`. The Y axis tick labels use log-scale spacing.

- [ ] **AC-8: Empty dataPoints renders "No data".** Given a `ComplexityResult` with `dataPoints === []` (e.g., a TIMEOUT result), the WebView renders the function name as the chart title, the complexity class as the subtitle, and the text `"No data available"` centered in the plot area. No axes, curves, or data points are drawn. No JavaScript error is thrown (verified by checking the WebView's developer tools console).

- [ ] **AC-9: Decoration types created once.** Given 50 consecutive file saves triggering 50 pipeline runs, `vscode.window.createTextEditorDecorationType()` is called exactly 10 times total (once per ComplexityClass that produces a decoration, on the first pipeline run). On runs 2-50, the cached decoration types are reused. Verified by: adding a counter in the decoration type creation code and asserting it equals 10 after 50 runs.

- [ ] **AC-10: tsLine off-by-one correctness.** Given a `ComplexityResult` with `tsLine = 5`, the inline decoration is applied at VS Code line index `4` (0-indexed). Given `tsLine = 1`, the decoration is at line index `0`. Verified by: a unit test that asserts `new vscode.Range(result.tsLine - 1, 0, result.tsLine - 1, 0)` for each result, and a visual test confirming the decoration appears on the same line as the function signature in the editor.

### Error Handling Criteria

- [ ] **AC-E1: Editor closed mid-run.** Given that `editor.document.isClosed` returns `true` when `applyAnnotations()` is called, the function returns immediately. No `setDecorations` call is made. No diagnostic is created. No error is thrown.

- [ ] **AC-E2: WebView panel disposed.** Given that the user previously closed the WebView panel, when the user clicks a decorated function line, a new WebView panel is created (not reused), the chart for the selected function is rendered, and no error is thrown.

- [ ] **AC-E3: tsLine out of range.** Given a `ComplexityResult` with `tsLine = 999` for a file with 50 lines, the decoration is applied at line index `49` (the last line, 0-indexed). No error is thrown, no exception propagates.

### Performance Criteria

- [ ] **AC-P1: Decoration render time.** Given a file with 20 functions, `applyAnnotations()` completes in under 50ms (target) and under 200ms (hard limit). Measured from function entry to function return, excluding WebView panel creation. Timed with `performance.now()`.

### Configuration Criteria

- [ ] **AC-C1: Enabled toggle.** Given `tsComplexity.enabled = false`, `applyAnnotations()` returns immediately without calling `setDecorations` or `diagnosticCollection.set`. Given the setting is changed back to `true` and the file is saved, decorations and diagnostics appear on the next pipeline run.

- [ ] **AC-C2: Warn threshold.** Given `tsComplexity.warnThreshold = 'O(n)'`, a function classified as `O(n)` produces a `Warning`-severity diagnostic (instead of the default `Information`). A function classified as `O(log n)` produces no diagnostic.

- [ ] **AC-C3: Error threshold.** Given `tsComplexity.errorThreshold = 'O(n^2)'`, a function classified as `O(n^2)` produces an `Error`-severity diagnostic (instead of the default `Warning`). A function classified as `O(n)` still produces `Warning` (if `warnThreshold` is `'O(n)'`) or `Information` (if `warnThreshold` is `'O(n^2)'`).

- [ ] **AC-C4: Show side panel toggle.** Given `tsComplexity.showSidePanel = false`, clicking a decorated function line does not open or update the WebView panel. The `onDidChangeTextEditorSelection` listener does not fire the `tsComplexity.showFunction` command.
