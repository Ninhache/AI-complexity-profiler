# S1 — Compiler Bridge

> **Status**: APPROVED
> **Author**: architect
> **Created**: 2026-03-26
> **Priority**: MVP
> **Layer**: 2 (Foundation — parallel-safe from Day 0)

## 1. Overview

S1 is the entry point of the analysis pipeline. It takes an absolute path to a `.ts` file, compiles it to JavaScript using the TypeScript Compiler API (`ts.transpileModule()`), and extracts an inline source map that maps JS positions back to TS positions. The compiled JavaScript feeds S2 (AST Instrumenter) and the source map feeds S3 (Input Generator) and S5 (Complexity Analyzer) for line-number attribution. S1 operates entirely in-memory — no files are written to disk at any point. A compilation cache keyed on file and tsconfig modification times eliminates redundant compilations on repeated saves of unchanged files.

## 2. User Value

When a developer saves a `.ts` file, the complexity analysis pipeline must begin within milliseconds. S1 is the first link in that chain. If S1 is fast and correct, the developer sees complexity annotations appear promptly after each save. If S1 fails, the entire pipeline halts and the developer gets no annotations at all. S1 also preserves the developer's ability to see compiler diagnostics (type errors, syntax warnings) as part of the complexity analysis output — these appear in the extension's diagnostic channel even when the pipeline continues with partial results. The developer never has to manually compile or configure anything; S1 resolves tsconfig settings automatically and falls back to sensible defaults when no tsconfig exists.

## 3. Detailed Design

### 3.1 Public API

```typescript
export async function compileFile(
  filePath: string,
  tsConfigPath?: string | null,
): Promise<CompilerBridgeResult>
// throws CompilerBridgeError on fatal failure
// Note: both `undefined` and `null` mean "no tsconfig provided"; the function treats them identically.

/** Clears the compilation cache. Exported for unit tests only. */
export function resetCache(): void
```

The function is `async` to accommodate the file-read I/O (`fs.promises.readFile`). The compilation itself (`ts.transpileModule`) is synchronous.

### 3.2 Return Type

```typescript
export interface CompilerBridgeResult {
  compiledJs:  string;          // transpiled JavaScript source
  sourceMap:   SourceMap;       // mapping from JS positions to TS positions
  diagnostics: TSDiagnostic[];  // compiler errors/warnings (non-fatal)
}
```

`SourceMap` satisfies the `interface-contracts` definition:

```typescript
interface SourceMap {
  jsToTs(jsLine: number, jsCol: number): { tsLine: number; tsCol: number };
}
```

`TSDiagnostic` is a simplified representation of TypeScript compiler diagnostics:

```typescript
interface TSDiagnostic {
  message:  string;
  line:     number;   // 1-indexed TS source line
  col:      number;   // 1-indexed TS source column
  severity: 'error' | 'warning' | 'suggestion';
}
```

### 3.3 Compiler Options

Five options are set explicitly. All others remain at TypeScript defaults.

| Option | Value | Rationale |
|--------|-------|-----------|
| `target` | `ts.ScriptTarget.ES2020` | Modern enough to preserve `async`/`await` and optional chaining without down-leveling. Old enough to avoid top-level-await ambiguity. |
| `module` | `ts.ModuleKind.CommonJS` | Worker execution in S4 uses `require`-style module loading. CommonJS avoids ESM complication in the worker sandbox. |
| `strict` | `false` | The extension analyzes user code, not its own. Strict mode would cause spurious diagnostics on user files that do not enable strict. |
| `inlineSourceMap` | `true` | Embeds the source map as a base64-encoded JSON comment at the end of the compiled output. Eliminates file I/O for a separate `.js.map` file. |
| `inlineSources` | `false` | The original TS source is not embedded in the source map. S1 already has the source in memory; embedding it would inflate the source map payload for no benefit. |

Options explicitly **not** set (remain at default / off):
- `emitDecoratorMetadata`: not needed; decorator metadata inflates the JS output with reflection calls that add noise to instrumentation.
- `experimentalDecorators`: not needed for the same reason.
- `declaration`: not needed; `.d.ts` files serve no purpose in the analysis pipeline.

### 3.4 tsconfig Resolution Algorithm

1. If `tsConfigPath` is provided and is a non-empty string, proceed to step 2. Otherwise, skip to step 5.
2. Attempt to read the file at `tsConfigPath` using `ts.readConfigFile(tsConfigPath, ts.sys.readFile)`.
3. If `ts.readConfigFile` returns an `error` property (file not found, read failure, or invalid JSON):
   - Push one `TSDiagnostic` to the diagnostics array:
     - `message`: `"tsconfig.json could not be loaded: {error.messageText}"`
     - `line`: 0
     - `col`: 0
     - `severity`: `'warning'`
   - Fall back to the five default compiler options from Section 3.3.
   - Proceed to compilation (step 6).
4. If `ts.readConfigFile` succeeds, call `ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(tsConfigPath))`. Merge the resulting `options` with the five mandatory options from Section 3.3. **The five mandatory options always win** — they override any conflicting values from tsconfig. This ensures `inlineSourceMap` is always `true` regardless of user tsconfig.
5. Use the five default compiler options from Section 3.3 with no tsconfig overrides.
6. Proceed to compilation.

### 3.5 Compilation Procedure

1. Compute the file's modification time using `fs.promises.stat(filePath)` for `mtimeMs`. If `tsConfigPath` is provided, also compute its `mtimeMs`; if `stat(tsConfigPath)` throws ENOENT, set `tsConfigMtimeMs` to the string `'none'`. Do not throw — a missing tsconfig is not a fatal error.
2. Construct the cache key: `${filePath}:${fileMtimeMs}:${tsConfigMtimeMs}` (see Section 4.1 for details). Check the cache. On hit, return the cached `CompilerBridgeResult` immediately.
3. Read the file at `filePath` using `fs.promises.readFile(filePath, 'utf-8')`. If this throws (ENOENT, EACCES, or any other filesystem error), throw a `CompilerBridgeError` with `message: "Cannot read file: {filePath}: {error.message}"` and `filePath` as the second argument.
4. Resolve compiler options via the tsconfig resolution algorithm (Section 3.4).
5. Call `ts.transpileModule(sourceText, { compilerOptions, fileName: filePath, reportDiagnostics: true })`.
6. Convert `transpileOutput.diagnostics` (if any) to `TSDiagnostic[]` by mapping each `ts.Diagnostic` to `{ message: ts.flattenDiagnosticMessageText(d.messageText, '\n'), line: <computed from d.start>, col: <computed from d.start>, severity: mapCategory(d.category) }`. To compute `line` and `col`: call `ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.ES2020)` (using the same `sourceText` that was passed to `ts.transpileModule()`) to obtain a `sourceFile`, then call `ts.getLineAndCharacterOfPosition(sourceFile, d.start)` to get `{ line, character }` where both are 0-indexed. Convert to 1-indexed: `tsLine = pos.line + 1`, `tsCol = pos.character + 1`.
   - `ts.DiagnosticCategory.Error` maps to `'error'`
   - `ts.DiagnosticCategory.Warning` maps to `'warning'`
   - `ts.DiagnosticCategory.Suggestion` maps to `'suggestion'`
   - `ts.DiagnosticCategory.Message` maps to `'suggestion'` (fallback for informational)
7. Extract the source map from `transpileOutput.outputText` (Section 3.6).
8. Construct `CompilerBridgeResult`, store it in the cache, and return it.

### 3.6 Source Map Construction Algorithm

1. Let `outputText` = the string returned by `ts.transpileModule().outputText`.
2. Find the last line of `outputText` that starts with `//# sourceMappingURL=data:application/json;base64,`.
3. **If no such line exists**: construct a no-op `SourceMap` where `jsToTs(line, col)` returns `{ tsLine: 1, tsCol: 0 }` (constant fallback). Do not push any diagnostic — this is a silent fallback.
4. If the line exists, extract the substring after the `base64,` prefix.
5. Decode the base64 string to a UTF-8 JSON string using `Buffer.from(base64String, 'base64').toString('utf-8')`.
6. Parse the JSON string to obtain a raw source map object (`{ version, sources, mappings, ... }`).
7. Create a `SourceMapConsumer` from the `source-map` npm package using `await new SourceMapConsumer(rawSourceMap)`. In `source-map` 0.7.x, `SourceMapConsumer` constructor returns a Promise and must be awaited.

   **Memory management**: `SourceMapConsumer` allocates WASM-backed memory that must be released via `consumer.destroy()`. To avoid leaking the consumer: (1) extract all needed mapping data into a plain JavaScript closure immediately after construction, (2) call `consumer.destroy()` before the constructor returns. The `SourceMap` object returned stores the closure, not the live consumer. Pseudocode:

   ```javascript
   const consumer = await new SourceMapConsumer(rawSourceMap);
   const jsToTs = (jsLine, jsCol) => {
     const pos = consumer.originalPositionFor({ line: jsLine, column: jsCol });
     if (pos.line == null) return { tsLine: 1, tsCol: 0 };
     return { tsLine: pos.line, tsCol: pos.column ?? 0 };
   };
   consumer.destroy();
   return { jsToTs };
   ```

8. The object returned by the factory (`{ jsToTs }`) satisfies the `SourceMap` interface. The live `SourceMapConsumer` is not stored in `CompilerBridgeResult` or the cache.
9. Strip the `//# sourceMappingURL=...` line from `compiledJs` before returning it. S2 does not need the source map comment in the JS it parses — it receives the `SourceMap` object separately.

### 3.7 Error Contract

`compileFile` throws `CompilerBridgeError` (defined in `interface-contracts`) only for infrastructure failures:

| Condition | Thrown? | Error message format |
|-----------|---------|---------------------|
| File cannot be read | Yes | `"Cannot read file: {filePath}: {os error message}"` |
| TypeScript module cannot be loaded (`require('typescript')` fails) | Yes | `"TypeScript is not installed. Run npm install typescript."` |
| TS type errors / syntax warnings in user code | No — diagnostics[] | N/A |
| TS syntax error so severe no JS is produced | No — empty compiledJs + diagnostics[] | N/A |
| tsconfig invalid or missing | No — diagnostics[] + fallback | N/A |

`CompilerBridgeError` extends `Error` and is defined in `interface-contracts`. Its constructor takes three arguments: `new CompilerBridgeError(message, filePath, cause)`. The `filePath` argument is the absolute path of the file being processed at the time of failure.

## 4. Data Model & Logic

### 4.1 Cache Structure

```typescript
type CacheKey = string;  // format: "${filePath}:${fileMtimeMs}:${tsConfigMtimeMs}"
const cache: Map<CacheKey, CompilerBridgeResult> = new Map();
```

- `fileMtimeMs`: the value of `(await fs.promises.stat(filePath)).mtimeMs`, converted to integer via `Math.floor()`. This is milliseconds since epoch.
- `tsConfigMtimeMs`: the value of `(await fs.promises.stat(tsConfigPath)).mtimeMs` converted to integer via `Math.floor()`. If `tsConfigPath` is not provided or the file does not exist, use the string `"none"`.
- Cache entries are never evicted. The extension's lifetime is bounded by the VS Code window session — memory is reclaimed when the window closes.
- The cache is a module-scoped `Map`, not exported. There is no public API to clear or inspect it. (A `resetCache()` function is exported solely for unit testing.)

**Cache key examples:**

| filePath | fileMtimeMs | tsConfigMtimeMs | Key |
|----------|-------------|-----------------|-----|
| `/project/src/foo.ts` | `1711500000000` | `1711400000000` | `/project/src/foo.ts:1711500000000:1711400000000` |
| `/project/src/foo.ts` | `1711500000000` | (no tsconfig) | `/project/src/foo.ts:1711500000000:none` |

### 4.2 Source Map Parsing Algorithm

**Variables:**

| Variable | Type | Source |
|----------|------|--------|
| `outputText` | `string` | Return value of `ts.transpileModule().outputText` |
| `base64Prefix` | `string` (constant) | `"//# sourceMappingURL=data:application/json;base64,"` |
| `lastLine` | `string` | Last line of `outputText` that starts with `base64Prefix` |
| `base64Payload` | `string` | `lastLine.substring(base64Prefix.length)` |
| `rawJson` | `string` | `Buffer.from(base64Payload, 'base64').toString('utf-8')` |
| `rawSourceMap` | `RawSourceMap` | `JSON.parse(rawJson)` — has fields `version`, `sources`, `mappings`, `names` |
| `consumer` | `SourceMapConsumer` | Created from `rawSourceMap` via `source-map` library |

**Steps:**

1. Split `outputText` on `\n`.
2. Iterate lines in reverse. Find the first line starting with `base64Prefix`.
3. If not found: return a no-op `SourceMap` where `jsToTs(line, col)` always returns `{ tsLine: 1, tsCol: 0 }` (constant fallback).
4. Extract `base64Payload`.
5. Decode: `rawJson = Buffer.from(base64Payload, 'base64').toString('utf-8')`.
6. Parse: `rawSourceMap = JSON.parse(rawJson)`.
7. Create consumer: `consumer = await new SourceMapConsumer(rawSourceMap)`.
   - Note: In `source-map` 0.7.x, `SourceMapConsumer` constructor returns a Promise and must be awaited. Use `await new SourceMapConsumer(rawSourceMap)`. The source-map construction function must be `async`.
   - **Memory management**: Immediately after construction, extract all mapping logic into a closure, call `consumer.destroy()`, and return the closure wrapped in a `SourceMap` adapter. The live consumer must not be stored in `CompilerBridgeResult` or the cache. See Section 3.6, step 7 for the pseudocode.
8. Wrap in `SourceMap` interface adapter (see Section 3.6, step 7–8).

### 4.3 tsconfig Resolution Algorithm

See Section 3.4 for the full algorithm. Summary of merge precedence:

```
finalOptions = { ...defaultOptions, ...tsconfigOptions, ...mandatoryOptions }
```

Where `mandatoryOptions` are the five options from Section 3.3. They always override tsconfig.

### 4.4 Worked Example

**Input file**: `/project/src/foo.ts` (3 lines)

```typescript
function add(a: number, b: number): number {
  return a + b;
}
```

**Step 1**: `fs.promises.stat('/project/src/foo.ts')` returns `mtimeMs = 1711500000000`. No tsconfig provided, so `tsConfigMtimeMs = 'none'`.

**Step 2**: Cache key = `/project/src/foo.ts:1711500000000:none`. Cache miss (first run).

**Step 3**: `fs.promises.readFile('/project/src/foo.ts', 'utf-8')` returns the source text above.

**Step 4**: Compiler options = `{ target: ES2020, module: CommonJS, strict: false, inlineSourceMap: true, inlineSources: false }`.

**Step 5**: `ts.transpileModule(source, options)` returns:

```javascript
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function add(a, b) {
    return a + b;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZm9vLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZm9vLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLEdBQUcsQ0FBQyxDQUFTLEVBQUUsQ0FBUztJQUM3QixPQUFPLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDakIsQ0FBQyJ9
```

**Step 6**: `transpileOutput.diagnostics` is empty (no errors). `diagnostics = []`.

**Step 7**: Source map extraction:
- Last line starts with `//# sourceMappingURL=data:application/json;base64,`.
- Extract base64 payload, decode to JSON.
- Decoded JSON (approximate): `{"version":3,"file":"foo.js","sourceRoot":"","sources":["foo.ts"],"names":[],"mappings":"..."}`.
- `await new SourceMapConsumer(rawSourceMap)` to create the consumer.

**Step 8**: Return value:

```typescript
{
  compiledJs: '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nfunction add(a, b) {\n    return a + b;\n}\n',
  sourceMap: <SourceMap adapter wrapping SourceMapConsumer>,
  diagnostics: []
}
```

Note: `compiledJs` has the `//# sourceMappingURL=...` line stripped.

**Source map queries:**

| Call | Result | Explanation |
|------|--------|-------------|
| `sourceMap.jsToTs(3, 0)` | `{ tsLine: 1, tsCol: 0 }` | JS line 3 (`function add(a, b) {`) maps to TS line 1 (`function add(a: number, b: number): number {`) |
| `sourceMap.jsToTs(4, 4)` | `{ tsLine: 2, tsCol: 2 }` | JS line 4 (`return a + b;`) maps to TS line 2 (`return a + b;`) |
| `sourceMap.jsToTs(1, 0)` | `{ tsLine: 1, tsCol: 0 }` | JS line 1 (`"use strict";`) — TypeScript-generated preamble, maps to TS line 1 as best-effort |

### 4.5 Diagnostic Mapping Example

**Input file with error**: `/project/src/bad.ts`

```typescript
function broken(x: number): string {
  return x + ;  // syntax error
}
```

`ts.transpileModule` produces:
- `outputText`: `"use strict";\nfunction broken(x) {\n    return x + ;\n}\n` (partial output with syntax error preserved)
- `diagnostics`: one entry with `messageText: "Expression expected."`, `category: ts.DiagnosticCategory.Error`, position pointing to line 2, col 13 in the TS source.

S1 result:
- `compiledJs`: the partial JS output (may be syntactically invalid — S2 will handle this).
- `diagnostics`: `[{ message: "Expression expected.", line: 2, col: 14, severity: 'error' }]` (1-indexed: the error is on line 2, character 14 of the TS source).
- `sourceMap`: extracted from whatever source map TS produces, or the constant fallback (`jsToTs` always returns `{ tsLine: 1, tsCol: 0 }`) if none.

## 5. Edge Cases & Error Handling

### 5.1 File Has TS Type Errors or Syntax Warnings

- **Input condition**: The `.ts` source contains type errors (e.g., assigning `number` to `string`) or syntax warnings that TypeScript can still compile past.
- **Expected behavior**: `compiledJs` contains the transpiled JavaScript. `diagnostics[]` contains one entry per compiler diagnostic, each with `message`, `line`, `col`, and `severity` fields populated. The pipeline continues — S2 receives `compiledJs`.
- **Error returned**: None thrown. Diagnostics are informational.
- **State after handling**: Cache stores the result. Subsequent calls with the same cache key return the cached result including the diagnostics.

### 5.2 File Has Fatal Syntax Error (No JS Produced)

- **Input condition**: The `.ts` source has a syntax error so severe that `ts.transpileModule()` produces an empty or effectively empty `outputText`.
- **Expected behavior**: `compiledJs` is `''` (empty string). `diagnostics[]` contains the fatal error(s). `sourceMap.jsToTs(line, col)` returns `{ tsLine: 1, tsCol: 0 }` for all inputs (constant fallback, not identity, because there are no valid JS positions to map).
- **Error returned**: None thrown.
- **State after handling**: Cache stores this result. Downstream subsystems (S2) receive the empty `compiledJs` and must handle it (S2's spec defines its behavior on empty input).

### 5.3 File Cannot Be Read (ENOENT, EACCES)

- **Input condition**: `fs.promises.readFile(filePath)` throws an error (file does not exist, permission denied, or any other filesystem error).
- **Expected behavior**: `compileFile` throws `CompilerBridgeError`.
- **Error returned**: `CompilerBridgeError` with `message: "Cannot read file: {filePath}: {error.message}"`. Example: `"Cannot read file: /project/src/gone.ts: ENOENT: no such file or directory, open '/project/src/gone.ts'"`.
- **State after handling**: No cache entry is created. No `CompilerBridgeResult` is returned.

### 5.4 TypeScript Not Available

- **Input condition**: The `typescript` package cannot be loaded (`require('typescript')` or dynamic `import('typescript')` fails).
- **Expected behavior**: `compileFile` throws `CompilerBridgeError`.
- **Error returned**: `CompilerBridgeError` with `message: "TypeScript is not installed. Run npm install typescript."`.
- **State after handling**: No cache entry is created. This is a permanent failure until the dependency is installed. The extension should surface this in the status bar (S6/orchestrator responsibility).

### 5.5 tsconfig.json Has Invalid JSON

- **Input condition**: `tsConfigPath` points to a file that exists but contains invalid JSON (e.g., trailing commas, unquoted keys, or binary garbage).
- **Expected behavior**: One `TSDiagnostic` is pushed: `{ message: "tsconfig.json could not be loaded: {parse error details}", line: 0, col: 0, severity: 'warning' }`. Compiler options fall back to the five defaults from Section 3.3. Compilation proceeds normally.
- **Error returned**: None thrown.
- **State after handling**: Cache stores the result with the warning diagnostic. If the user fixes tsconfig and saves, the next call produces a different cache key (new tsconfig mtime) and recompiles with the corrected config.

Note: `line: 0` and `col: 0` are sentinel values for "no source location." Downstream consumers of `TSDiagnostic` must check for `line === 0` to detect "no location" diagnostics.

### 5.6 tsconfig.json Not Found at Provided Path

- **Input condition**: `tsConfigPath` is provided but `ts.readConfigFile` cannot read the file (ENOENT).
- **Expected behavior**: One `TSDiagnostic` is pushed: `{ message: "tsconfig.json could not be loaded: File not found: {tsConfigPath}", line: 0, col: 0, severity: 'warning' }`. Compiler options fall back to the five defaults from Section 3.3. Compilation proceeds.
- **Error returned**: None thrown.
- **State after handling**: Cache key uses `"none"` for tsConfigMtimeMs since the file does not exist for stat. If the user later creates the tsconfig file, the orchestrator must provide the path again and a new cache key is generated.

Note: `line: 0` and `col: 0` are sentinel values for "no source location." Downstream consumers of `TSDiagnostic` must check for `line === 0` to detect "no location" diagnostics.

### 5.7 Inline Source Map Missing from Compiled Output

- **Input condition**: `ts.transpileModule()` produces `outputText` that does not contain a `//# sourceMappingURL=data:application/json;base64,` line. This is unexpected given `inlineSourceMap: true` but must be handled.
- **Expected behavior**: A no-op `SourceMap` is constructed where `jsToTs(line, col)` returns `{ tsLine: 1, tsCol: 0 }` (constant fallback). No diagnostic is pushed (this is a silent fallback; the source map is a best-effort artifact).
- **Error returned**: None thrown.
- **State after handling**: Cache stores the result with the constant-fallback source map. Downstream S5 will produce slightly inaccurate TS line attributions, but the pipeline continues.

### 5.8 Empty File (0 bytes)

- **Input condition**: `filePath` points to a file that exists but is empty.
- **Expected behavior**: `ts.transpileModule('', options)` is called. It produces `compiledJs` containing only the `"use strict";` preamble (and possibly the source map comment). `diagnostics` is `[]`. `sourceMap` is extracted normally (or identity if no source map line is present).
- **Error returned**: None thrown.
- **State after handling**: Cache stores the result. S2 receives the minimal JS and finds no functions to instrument.

### 5.9 Very Large File (>10,000 lines)

- **Input condition**: The file is very large and `ts.transpileModule()` takes longer than 600ms.
- **Expected behavior**: S1 does not enforce its own timeout. The 600ms hard limit is enforced by the `extension-orchestrator`, which wraps the `compileFile` call in a `Promise.race` with a timeout. If the timeout fires, the orchestrator aborts the pipeline and surfaces a `TIMEOUT` decoration. S1 itself runs to completion or is garbage-collected when the promise is abandoned.
- **Error returned**: None from S1. The orchestrator is responsible for timeout behavior.
- **State after handling**: If S1 completes after the orchestrator timeout, the result is not used. The cache may or may not contain the entry depending on timing — this is acceptable because the next save will recompute if needed.

## 6. Dependencies

### Upstream (S1 depends on)

| Component | What S1 consumes | Interface |
|-----------|------------------|-----------|
| **interface-contracts** | `SourceMap` interface definition, `CompilerBridgeError` class, `TSDiagnostic` type, `CompilerBridgeResult` type (imported from `src/types.ts`) | Type imports only — no runtime dependency |
| **VS Code TextDocument** (runtime) | `filePath` — the absolute path to the active `.ts` file, provided by the orchestrator from `document.uri.fsPath` | `string` passed as argument to `compileFile()` |

### Downstream (components that depend on S1)

| Component | What it consumes from S1 | Interface |
|-----------|--------------------------|-----------|
| **s2-ast-instrumenter** | `compiledJs` — the transpiled JavaScript source text | `CompilerBridgeResult.compiledJs` (string) |
| **s3-input-generator** | `sourceMap` — used for correlating JS function positions back to TS source for type extraction | `CompilerBridgeResult.sourceMap` (SourceMap) |
| **s5-complexity-analyzer** | `sourceMap` — used to translate JS line numbers in `MeasurementPoint` back to TS line numbers in `ComplexityResult` | `CompilerBridgeResult.sourceMap` (SourceMap) |
| **extension-orchestrator** | All three fields of `CompilerBridgeResult` — routes them to the correct downstream subsystems | `CompilerBridgeResult` |

### External Dependencies

| Library | Version Constraint | Purpose |
|---------|-------------------|---------|
| **typescript** | `^5.0.0` | TypeScript Compiler API — `ts.transpileModule()`, `ts.readConfigFile()`, `ts.parseJsonConfigFileContent()`, `ts.ScriptTarget`, `ts.ModuleKind` |
| **source-map** | `^0.7.0` | `SourceMapConsumer` — decodes VLQ-encoded source map `mappings` field, provides `originalPositionFor()` lookup |

Both are listed as `dependencies` (not `devDependencies`) in the extension's `package.json` because they are required at runtime in the VS Code extension host.

## 7. Configuration

S1 has no user-facing configuration settings. All compiler options are fixed (Section 3.3) with tsconfig overrides applied transparently. The cache is not user-configurable.

The one external configuration value that affects S1:

| Key | Type | Default | Valid Range | Effect |
|-----|------|---------|-------------|--------|
| `tsComplexity.timeoutMs` | `integer` | `600` | `100–5000` | The orchestrator uses this value as the hard abort timeout when calling `compileFile()`. S1 does not read this setting itself — the orchestrator wraps the call in `Promise.race`. If the timeout fires, the orchestrator abandons the S1 promise and surfaces a TIMEOUT result. |

**Not configurable** (and why):
- Compiler target (`ES2020`): Changing the target alters the emitted JS structure, which changes what S2 instruments. A different target would require re-validating the entire pipeline. Fixed for v1.
- Cache eviction policy: The cache is never evicted. Extension lifetime is bounded by the VS Code window. Memory usage is negligible (each cached entry is the size of the compiled JS + source map for one file).
- `inlineSourceMap`: Must be `true` for the pipeline to function. Not configurable.

## 8. Acceptance Criteria

### Functional Criteria

- [ ] **Valid compilation**: Given a syntactically valid `.ts` file, `compileFile()` returns a `CompilerBridgeResult` where `compiledJs` is non-empty, parseable JavaScript and `diagnostics` is `[]`.
- [ ] **Source map accuracy**: Given a `.ts` file with a function declaration on line L, `sourceMap.jsToTs(jsLine, 0)` returns `{ tsLine: L, tsCol: 0 }` where `jsLine` is the line in `compiledJs` containing the corresponding function declaration.
- [ ] **Diagnostics passthrough**: Given a `.ts` file with a type error, `diagnostics[]` contains at least one entry with `severity: 'error'` and a non-empty `message` string. `compiledJs` is still populated (TypeScript produces JS output despite type errors).
- [ ] **tsconfig respected**: Given a `tsconfig.json` that sets `target: "ES5"`, `compileFile()` uses `ES2020` (mandatory override wins). Given a tsconfig that sets `moduleResolution: "node"`, that option is preserved in the merged options.
- [ ] **Cache hit**: Calling `compileFile(filePath)` twice without modifying the file returns the identical `CompilerBridgeResult` object reference on the second call.
- [ ] **Cache invalidation**: Modifying the `.ts` file (changing its `mtime`), then calling `compileFile()` again produces a fresh `CompilerBridgeResult` (not the cached one).
- [ ] **Source map comment stripped**: The returned `compiledJs` does not contain any line starting with `//# sourceMappingURL=`.

### Error Handling Criteria

- [ ] **ENOENT**: Given a `filePath` pointing to a non-existent file, `compileFile()` throws `CompilerBridgeError` with a message matching the pattern `"Cannot read file: {path}: ENOENT"`.
- [ ] **EACCES**: Given a `filePath` pointing to an unreadable file (permissions 000), `compileFile()` throws `CompilerBridgeError` with a message matching the pattern `"Cannot read file: {path}: EACCES"`.
- [ ] **Missing TypeScript**: When the `typescript` module cannot be loaded, `compileFile()` throws `CompilerBridgeError` with `message` containing `"TypeScript is not installed"`.
- [ ] **Invalid tsconfig**: Given a `tsConfigPath` pointing to a file with invalid JSON, `compileFile()` returns a `CompilerBridgeResult` (does not throw). `diagnostics[]` contains one entry with `severity: 'warning'` and a message containing `"tsconfig.json could not be loaded"`. `compiledJs` is produced using default options.
- [ ] **Missing tsconfig**: Given a `tsConfigPath` pointing to a non-existent file, `compileFile()` returns a `CompilerBridgeResult` (does not throw). `diagnostics[]` contains one entry with `severity: 'warning'`.
- [ ] **Fatal syntax error**: Given a `.ts` file with unparseable syntax (e.g., `function (`), `compiledJs` is `''` (empty string) and `diagnostics[]` contains at least one entry with `severity: 'error'`.
- [ ] **Empty file**: Given a `.ts` file with 0 bytes, `compileFile()` returns without throwing. `diagnostics` is `[]`.

### Performance Criteria

- [ ] **Compilation speed**: `compileFile()` completes in < 300ms for a `.ts` file of 1000 lines or fewer, measured as wall-clock time on a machine with 4+ CPU cores and 8+ GB RAM.
- [ ] **Cache hit speed**: On cache hit, `compileFile()` returns in < 5ms (wall-clock).
- [ ] **Hard limit**: `compileFile()` completes in < 600ms for a `.ts` file of 1000 lines or fewer. Exceeding 600ms on a file within this size is a test failure.

### Integrity Criteria

- [ ] **No disk writes**: During the entire execution of `compileFile()`, no call to `fs.writeFile`, `fs.writeFileSync`, `fs.appendFile`, `fs.appendFileSync`, `fs.open` with write flags, or `fs.createWriteStream` is made. Verified by mocking `fs` write methods and asserting zero invocations.
- [ ] **No network I/O**: `compileFile()` does not make any HTTP/HTTPS requests or open any network sockets. Verified by mocking `http.request`, `https.request`, and `net.Socket` and asserting zero invocations.
- [ ] **Deterministic output**: Calling `compileFile()` twice on the same file (after clearing cache) produces byte-identical `compiledJs` strings.
