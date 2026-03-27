# Extension Manifest

> **Status**: APPROVED
> **Author**: architect
> **Created**: 2026-03-27
> **Priority**: MVP
> **Layer**: 1 (Foundation)

## 1. Overview

The extension manifest is the set of static configuration files that define the VS Code extension to the editor runtime, the TypeScript compiler, and the VSIX packaging tool. It consists of three files: `package.json` (extension metadata, activation events, contributed commands, user-facing settings schema, dependency declarations, and build scripts), `tsconfig.json` (compiler configuration for the extension source), and `.vscodeignore` (exclusion rules for VSIX packaging). These files contain no TypeScript logic. They are the foundation that every other component depends on: `package.json` declares the activation contract that triggers the orchestrator, the settings schema that S4 and S6 read at runtime, the dependency list that the VSIX bundles, and the command registrations that surface the extension in the Command Palette. If the manifest is wrong -- a missing activation event, a runtime dependency placed in `devDependencies`, or a `.vscodeignore` rule that strips a required module -- the extension either fails to activate or silently ships broken.

## 2. User Value

When a developer installs the VSIX and opens a TypeScript file, two things happen without any configuration:

1. The extension activates silently (the `onLanguage:typescript` activation event fires) and begins analyzing on save. The developer does not need to run a command, edit a config file, or restart VS Code.
2. Eight settings appear in the VS Code Settings UI under "TypeScript Complexity Profiler" -- enable/disable, trigger-on-save, timeout, input sizes, confidence threshold, warning/error thresholds, and side panel toggle. Each has a typed default, a validation constraint, and a plain-English description. The developer can tune behavior without reading documentation.

Both commands -- "Analyze Complexity" and "Clear Complexity Annotations" -- appear in the Command Palette under the "TypeScript Complexity" category, discoverable by typing "complexity".

The VSIX file produced by `npm run package` is a single artifact that a developer can share with colleagues via `code --install-extension`, with no npm install, no build step, and no internet access required on the receiving end.

## 3. Detailed Design

### 3.1 package.json (annotated)

```jsonc
{
  // --- Extension Identity ---
  "name": "typescript-complexity-profiler",
  // npm-compatible package name. Used as the VSIX file stem.
  // Must be lowercase, hyphenated, no spaces.

  "displayName": "TypeScript Complexity Profiler",
  // Shown in the Extensions sidebar, Marketplace, and Settings UI.

  "description": "Empirically measures algorithmic complexity of TypeScript functions and shows inline annotations",
  // One-liner shown under the extension name in the Extensions sidebar.

  "version": "0.1.0",
  // Semver required by vsce. The VSIX filename includes this version.
  // Bump this before every `vsce package` to avoid overwriting prior artifacts.

  "publisher": "local",
  // Required by vsce. For local-only VSIX distribution, "local" is a
  // placeholder. For Marketplace publishing (v2), this must be a registered
  // publisher ID.

  "engines": {
    "vscode": "^1.85.0"
    // VS Code 1.85+ ships Node.js 18.x, which provides worker_threads
    // (stable since Node 12) and ES2020 support. This is the minimum
    // version that supports all runtime APIs the extension uses.
  },

  "categories": ["Other", "Linters"],
  // "Linters" surfaces the extension in relevant category searches.
  // "Other" is the fallback category required when no perfect match exists.

  // --- Activation ---
  "activationEvents": ["onLanguage:typescript"],
  // The extension activates when VS Code opens any file with languageId
  // "typescript" (i.e., .ts files). Activation is lazy -- the extension
  // host does not load the extension until this event fires.
  // Note: VS Code 1.74+ auto-infers onLanguage from contributes.languages,
  // but explicit declaration ensures compatibility with 1.85.0 baseline.

  "main": "./out/extension.js",
  // Entry point: the compiled JS output of src/extension.ts.
  // VS Code calls the exported activate() function from this file.

  // --- Contributions ---
  "contributes": {
    "commands": [
      {
        "command": "tsComplexity.analyzeFile",
        "title": "Analyze Complexity",
        "category": "TypeScript Complexity"
        // Appears in Command Palette as:
        // "TypeScript Complexity: Analyze Complexity"
        // Triggers on-demand analysis of the active .ts file.
      },
      {
        "command": "tsComplexity.clearAnnotations",
        "title": "Clear Complexity Annotations",
        "category": "TypeScript Complexity"
        // Clears all inline decorations and diagnostics from the active editor.
      }
    ],

    "configuration": {
      "title": "TypeScript Complexity Profiler",
      // Section header in VS Code Settings UI.
      "properties": {
        // Each property is documented individually in Section 7 (Configuration).
        // The JSON Schema types, defaults, and constraints below are validated
        // by VS Code at settings-read time.

        "tsComplexity.enabled": {
          "type": "boolean",
          "default": true,
          "description": "Enable or disable the extension globally"
        },
        "tsComplexity.triggerOnSave": {
          "type": "boolean",
          "default": true,
          "description": "Run analysis automatically on every file save"
        },
        "tsComplexity.timeoutMs": {
          "type": "number",
          "default": 5000,
          "minimum": 1000,
          "maximum": 30000,
          "description": "Worker execution timeout in milliseconds"
        },
        "tsComplexity.inputSizes": {
          "type": "array",
          "items": { "type": "number", "minimum": 1 },
          "minItems": 3,
          "maxItems": 20,
          "default": [10, 30, 100, 300, 1000, 3000, 10000],
          "description": "Input sizes used for complexity measurement (minimum 3 values required for regression)"
        },
        "tsComplexity.minConfidence": {
          "type": "number",
          "default": 0.92,
          "minimum": 0.5,
          "maximum": 1.0,
          "description": "Minimum R-squared score to report a complexity class (below this shows LOW_CONFIDENCE)"
        },
        "tsComplexity.warnThreshold": {
          "type": "string",
          "default": "O(n^2)",
          "enum": ["O(n)", "O(n log n)", "O(n^2)", "O(n^3)", "O(2^n)"],
          "description": "Minimum complexity class that triggers a Warning diagnostic"
        },
        "tsComplexity.errorThreshold": {
          "type": "string",
          "default": "O(n^3)",
          "enum": ["O(n^2)", "O(n^3)", "O(2^n)"],
          "description": "Minimum complexity class that triggers an Error diagnostic"
        },
        "tsComplexity.showSidePanel": {
          "type": "boolean",
          "default": true,
          "description": "Automatically open the complexity chart panel after analysis"
        }
      }
    }
  },

  // --- Scripts ---
  "scripts": {
    "vscode:prepublish": "npm run compile",
    // vsce calls this automatically before packaging.
    // Ensures the VSIX always contains freshly compiled JS.

    "compile": "tsc -p ./",
    // Invokes tsc with the project's tsconfig.json.
    // Outputs to ./out/ as specified by tsconfig outDir.

    "watch": "tsc -watch -p ./",
    // Incremental recompile on file change. Used during development.

    "test": "node ./out/test/runTest.js",
    // Launches the VS Code test runner (vscode-test-electron).
    // The compiled test entry point bootstraps Mocha inside a VS Code instance.

    "package": "vsce package"
    // Produces the .vsix artifact. Calls vscode:prepublish first.
  },

  // --- Runtime Dependencies ---
  // These are bundled inside the VSIX under node_modules/.
  // They must be in "dependencies", not "devDependencies".
  "dependencies": {
    "typescript": "^5.3.0",
    // S1 uses ts.transpileModule() and the TS type checker.
    // Must be bundled because the user's globally installed TS version
    // may differ or not exist.

    "acorn": "^8.11.0",
    // S2 uses Acorn to parse compiled JS into an AST.
    // Note: the s2-ast-instrumenter spec references acorn ^8.0.0 — ^8.11.0
    // is the minimum version that ships stable ES2022 parse support; use ^8.11.0.

    "escodegen": "^2.1.0",
    // S2 uses escodegen to regenerate JS from the instrumented AST.

    "source-map": "^0.7.4"
    // S1 uses source-map to parse the inline source map emitted by
    // ts.transpileModule() and construct the SourceMap interface.
  },

  // --- Bundled Dependencies ---
  // vsce 2.x does not auto-bundle node_modules. Listing dependencies here
  // tells vsce to include them in the VSIX archive.
  "bundledDependencies": [
    "typescript",
    "acorn",
    "escodegen",
    "source-map"
  ],

  // --- Development Dependencies ---
  // These are NOT bundled in the VSIX. Used only during build/test.
  "devDependencies": {
    "@types/vscode": "^1.85.0",
    // Type declarations for the VS Code Extension API.
    // The actual vscode module is provided by the extension host at runtime.
    // Version must match the engines.vscode minimum.

    "@types/node": "^20.0.0",
    // Type declarations for Node.js APIs (fs, path, worker_threads).

    "@types/escodegen": "^0.0.7",
    // Type declarations for escodegen's generate() function.

    "@vscode/test-electron": "^2.3.0",
    // Launches a real VS Code instance for integration tests.

    "@vscode/vsce": "^2.22.0",
    // The CLI tool that produces .vsix files. Invoked by `npm run package`.

    "mocha": "^10.2.0",
    // Test framework used by the VS Code test runner.

    "@types/mocha": "^10.0.0"
    // Type declarations for Mocha's describe/it/before/after API.
  }
}
```

### 3.2 tsconfig.json (annotated)

```jsonc
{
  "compilerOptions": {
    "module": "commonjs",
    // VS Code extensions must use CommonJS modules. The extension host
    // loads the entry point with require(), not import.

    "target": "ES2020",
    // VS Code 1.85 ships Node.js 18, which supports all ES2020 features
    // (optional chaining, nullish coalescing, BigInt, Promise.allSettled).
    // Targeting ES2020 avoids unnecessary downlevel transforms while
    // ensuring compatibility.

    "outDir": "./out",
    // Compiled JS goes here. package.json "main" points to ./out/extension.js.
    // The out/ directory is gitignored; the VSIX bundles its contents.

    "rootDir": "./src",
    // All source files live under src/. This ensures the output directory
    // structure mirrors the source structure (e.g., src/extension.ts ->
    // out/extension.js, src/test/runTest.ts -> out/test/runTest.js).

    "strict": true,
    // Enables all strict type-checking options: strictNullChecks,
    // noImplicitAny, strictFunctionTypes, strictBindCallApply,
    // strictPropertyInitialization, noImplicitThis, alwaysStrict.
    // Required by Acceptance Criterion #6.

    "esModuleInterop": true,
    // Allows `import acorn from 'acorn'` syntax for CommonJS modules
    // that export via module.exports. Without this, imports of acorn and
    // escodegen require `import * as acorn from 'acorn'`.

    "sourceMap": true,
    // Emit .js.map files alongside .js output. Used for debugging the
    // extension in VS Code's Extension Development Host.
    // Note: .map files are excluded from the VSIX by .vscodeignore.

    "lib": ["ES2020"]
    // Provides type declarations for ES2020 standard library features.
    // Critically, this does NOT include "DOM". The extension runs in
    // Node.js (the VS Code extension host), not a browser. There is no
    // window, document, or DOM API available. The WebView panel's HTML
    // content (including Canvas API calls for the complexity chart) is
    // constructed as a string and injected into the WebView -- those
    // Canvas calls execute in the WebView's browser context, not in the
    // extension host TypeScript.
  },
  "exclude": [
    "node_modules",
    ".vscode-test"
    // .vscode-test/ is created by @vscode/test-electron when it
    // downloads a VS Code instance for integration tests. It contains
    // a full VS Code installation and must not be compiled.
  ]
}
```

### 3.3 .vscodeignore (annotated)

```
.vscode/**            # Editor settings -- not part of the extension
.vscode-test/**       # Downloaded VS Code test instances
src/**                # TypeScript source -- only compiled JS is needed
.gitignore            # Git config
.vscodeignore         # This file itself
tsconfig.json         # Build config -- not needed at runtime
**/*.map              # Source maps -- useful for dev, not for distribution
**/*.ts               # Any .ts files outside src/ (safety catch)
!out/**               # EXCEPTION: include everything under out/ (compiled JS)
node_modules/**       # Excluded by default, but explicit for clarity.
                      # vsce re-installs production deps (dependencies only)
                      # during packaging, so runtime deps ARE included.
```

**Key behavior**: In `@vscode/vsce` 2.x, `node_modules` are **not** automatically bundled into the VSIX. To include runtime dependencies (`typescript`, `acorn`, `escodegen`, `source-map`), add a `"bundledDependencies"` field to `package.json` listing each runtime dependency by name. vsce will then include those packages in the VSIX archive. Alternative: use a bundler such as `esbuild` or `webpack` to produce a single output file — this is the recommended approach for extensions published to the Marketplace, but is deferred to v2. For MVP local VSIX distribution, `bundledDependencies` is the simpler solution.

### 3.4 Project File Layout

```
typescript-complexity-profiler/
├── src/
│   ├── extension.ts              # Extension entry point (Agent 7 - Orchestrator)
│   ├── types.ts                  # Interface contracts (shared types for S1-S6)
│   ├── s1-compiler-bridge.ts     # S1: TS -> JS compilation + source map
│   ├── s2-ast-instrumenter.ts    # S2: Acorn parse, __op() injection, escodegen
│   ├── s3-input-generator.ts     # S3: Type-aware input generation
│   ├── s4-runtime-executor.ts    # S4: Worker execution + timeout enforcement
│   ├── s5-complexity-analyzer.ts # S5: Least-squares regression + model selection
│   ├── s6-annotation-engine.ts   # S6: Inline decorations + diagnostics + WebView
│   └── test/
│       ├── runTest.ts            # Test bootstrap: launches VS Code + Mocha
│       ├── suite/
│       │   ├── s1.test.ts        # Unit tests for Compiler Bridge
│       │   ├── s2.test.ts        # Unit tests for AST Instrumenter
│       │   ├── s3.test.ts        # Unit tests for Input Generator
│       │   ├── s4.test.ts        # Unit tests for Runtime Executor
│       │   ├── s5.test.ts        # Unit tests for Complexity Analyzer
│       │   ├── s6.test.ts        # Unit tests for Annotation Engine
│       │   └── integration.test.ts  # End-to-end pipeline test
│       └── fixtures/
│           ├── bubble_sort.ts    # Expected: O(n^2)
│           ├── binary_search.ts  # Expected: O(log n)
│           ├── linear_scan.ts    # Expected: O(n)
│           ├── merge_sort.ts     # Expected: O(n log n)
│           ├── constant.ts       # Expected: O(1)
│           ├── infinite_loop.ts  # Expected: TIMEOUT
│           ├── no_functions.ts   # Expected: no annotations
│           └── compiler_error.ts # Expected: diagnostic, no annotations
├── out/                          # Compiled JS output (gitignored)
├── package.json                  # Extension manifest (this spec)
├── tsconfig.json                 # TypeScript compiler configuration
└── .vscodeignore                 # VSIX exclusion rules
```

## 4. Data Model & Logic

This component has no runtime logic, algorithms, or state machines. Its "data model" is the set of static declarations that VS Code, tsc, and vsce interpret at different lifecycle stages. This section describes how each tool reads the manifest and what processing it performs.

### 4.1 Install-Time Processing (VS Code reads package.json)

When a user runs `code --install-extension typescript-complexity-profiler-0.1.0.vsix`:

1. VS Code extracts the VSIX (which is a ZIP archive) into `~/.vscode/extensions/local.typescript-complexity-profiler-0.1.0/`.
2. VS Code reads `package.json` and indexes the following:
   - `activationEvents` -- registers the extension for lazy activation.
   - `contributes.commands` -- adds entries to the Command Palette index.
   - `contributes.configuration` -- registers the JSON Schema for settings validation.
3. The extension code (`out/extension.js`) is **not** loaded at this point. No `activate()` call occurs.

### 4.2 Activation-Time Processing (extension loads on first .ts file)

When the user opens a `.ts` file (or switches to a tab containing one):

1. VS Code matches the file's `languageId` ("typescript") against the registered `activationEvents: ["onLanguage:typescript"]`.
2. VS Code calls `require('./out/extension.js')` and invokes the exported `activate(context: vscode.ExtensionContext)` function.
3. The orchestrator (Agent 7) registers command handlers for `tsComplexity.analyzeFile` and `tsComplexity.clearAnnotations`, subscribes to `onDidSaveTextDocument`, and reads the 8 configuration settings via `vscode.workspace.getConfiguration('tsComplexity')`.

### 4.3 Settings Validation (JSON Schema at read time)

VS Code validates settings against the JSON Schema defined in `contributes.configuration.properties`. The validation occurs when:

- The user edits settings in the Settings UI or `settings.json`.
- The extension calls `vscode.workspace.getConfiguration('tsComplexity').get<T>('key')`.

**Validation behavior per type**:

| Setting | Schema Type | Validation | Invalid Value Behavior |
|---------|------------|------------|----------------------|
| `enabled` | boolean | Must be `true` or `false` | Falls back to default `true` |
| `triggerOnSave` | boolean | Must be `true` or `false` | Falls back to default `true` |
| `timeoutMs` | number | Must be >= 1000 and <= 30000 | Falls back to default 5000 |
| `inputSizes` | array of numbers | Each item must be >= 1 | Falls back to default array |
| `minConfidence` | number | Must be >= 0.5 and <= 1.0 | Falls back to default 0.92 |
| `warnThreshold` | string (enum) | Must be one of 5 values | Falls back to default "O(n^2)" |
| `errorThreshold` | string (enum) | Must be one of 3 values | Falls back to default "O(n^3)" |
| `showSidePanel` | boolean | Must be `true` or `false` | Falls back to default `true` |

VS Code's settings validation is lenient: invalid values are silently replaced with the declared default. The Settings UI enforces constraints via input widgets (checkboxes for booleans, dropdowns for enums, number spinners with min/max).

### 4.4 VSIX Bundle Composition

When `vsce package` runs:

1. `vsce` invokes the `vscode:prepublish` script, which runs `tsc -p ./` to compile `src/` into `out/`.
2. `vsce` runs `npm install --production` in a temporary staging area, installing only `dependencies`.
3. `vsce` reads `.vscodeignore` and constructs an exclusion list.
4. `vsce` packages the remaining files into a ZIP archive with `.vsix` extension.

**Included in the VSIX**:

| Path | Reason |
|------|--------|
| `package.json` | Required -- VS Code reads it at install time |
| `out/**/*.js` | Compiled extension code -- the runtime |
| `node_modules/typescript/` | Runtime dep: S1 uses ts.transpileModule() |
| `node_modules/acorn/` | Runtime dep: S2 uses Acorn to parse JS |
| `node_modules/escodegen/` | Runtime dep: S2 uses escodegen to regenerate JS |
| `node_modules/source-map/` | Runtime dep: S1 uses source-map to parse inline maps |
| Transitive deps of the above | npm installs the full dependency tree for production deps |

**Excluded from the VSIX**:

| Path | Rule | Reason |
|------|------|--------|
| `src/**` | `.vscodeignore: src/**` | TypeScript source not needed at runtime |
| `**/*.ts` | `.vscodeignore: **/*.ts` | Catches any .ts files outside src/ |
| `**/*.map` | `.vscodeignore: **/*.map` | Source maps are for debugging, not distribution |
| `tsconfig.json` | `.vscodeignore: tsconfig.json` | Build configuration not needed at runtime |
| `.vscode/**` | `.vscodeignore: .vscode/**` | Editor settings |
| `.vscode-test/**` | `.vscodeignore: .vscode-test/**` | Test VS Code instances |
| `.gitignore` | `.vscodeignore: .gitignore` | Git configuration |
| `.vscodeignore` | `.vscodeignore: .vscodeignore` | Self-exclusion |
| `@types/*`, `@vscode/test-electron`, `@vscode/vsce`, `mocha`, `@types/mocha` | Not in `dependencies` | devDependencies are not installed by `npm install --production` |

### 4.5 Build-Time Processing (tsc reads tsconfig.json)

When `tsc -p ./` runs:

1. tsc reads `tsconfig.json` from the project root.
2. It discovers all `.ts` files under `src/` (the `rootDir`), excluding `node_modules/` and `.vscode-test/`.
3. It compiles each `.ts` file under `strict: true`, targeting `ES2020` with `commonjs` module output.
4. Output files are written to `out/`, preserving the directory structure relative to `src/`.
5. Source map files (`.js.map`) are emitted alongside each `.js` file.

**Mapping**: `src/extension.ts` -> `out/extension.js` + `out/extension.js.map`, `src/s1-compiler-bridge.ts` -> `out/s1-compiler-bridge.js`, and so on for all source files. Test files follow the same pattern: `src/test/suite/s1.test.ts` -> `out/test/suite/s1.test.js`.

## 5. Edge Cases & Error Handling

### 5.1 vsce package fails: missing publisher field

- **Input condition**: `package.json` has no `"publisher"` field, or the field is an empty string.
- **Expected behavior**: `vsce package` exits with a non-zero code and prints an error: `"Missing publisher name."`.
- **Resolution**: The manifest specifies `"publisher": "local"` as a placeholder. This value is valid for local VSIX distribution. For Marketplace publishing (v2), it must be replaced with a registered Azure DevOps publisher ID.
- **State after handling**: No `.vsix` file is produced. The developer must add the publisher field and re-run.

### 5.2 vsce package fails: invalid version format

- **Input condition**: The `"version"` field is not valid semver (e.g., `"1.0"`, `"v1.0.0"`, `"latest"`).
- **Expected behavior**: `vsce package` exits with a non-zero code and prints: `"Invalid extension version."`.
- **Resolution**: The manifest specifies `"0.1.0"`, which is valid semver. All version bumps must follow `MAJOR.MINOR.PATCH` format.
- **State after handling**: No `.vsix` file is produced. The developer must fix the version string.

### 5.3 vsce package fails: node_modules not installed

- **Input condition**: The developer runs `npm run package` without first running `npm install`.
- **Expected behavior**: The `vscode:prepublish` script runs `tsc -p ./`, which fails because `@types/vscode` and other type declaration packages are missing. tsc prints "Cannot find module 'vscode'" errors.
- **Resolution**: Run `npm install` before `npm run package`.
- **State after handling**: No `.vsix` file is produced. The `out/` directory may contain partial output from a previous compilation.

### 5.4 tsc fails: DOM API usage in extension code

- **Input condition**: A developer writes code in `src/` that references `document`, `window`, `HTMLCanvasElement`, or any DOM API.
- **Expected behavior**: tsc reports errors such as `"Cannot find name 'document'"` because `"lib"` is `["ES2020"]` without `"DOM"`.
- **Resolution**: DOM APIs are not available in the extension host (Node.js). The WebView panel's HTML content, including Canvas API calls for the complexity chart, must be constructed as template strings in the extension TypeScript and injected via `webview.html = ...`. The Canvas calls execute in the WebView's browser context, not in the extension host.
- **State after handling**: Compilation fails. No output is written to `out/` for the affected file.

### 5.5 Activation does not fire: file is .js, not .ts

- **Input condition**: A user opens a `.js` file and expects complexity analysis.
- **Expected behavior**: The extension does not activate. The `onLanguage:typescript` event does not fire for JavaScript files (languageId "javascript"). No commands are registered, no analysis runs.
- **Resolution**: This is by design for v1 (TypeScript only, per scope definition). The user sees no error -- the extension is simply not loaded.
- **State after handling**: Extension remains inactive. No resources are consumed.

### 5.6 Settings conflict: errorThreshold lower than warnThreshold

- **Input condition**: A user sets `tsComplexity.warnThreshold` to `"O(n^2)"` and `tsComplexity.errorThreshold` to `"O(n)"`. The error threshold is less severe than the warning threshold.
- **Expected behavior**: VS Code does not prevent this configuration because the JSON Schema validates each field independently. The extension-orchestrator (not the manifest) is responsible for detecting this conflict at runtime and resolving it.

  **Conflict resolution rule** (normative): If `errorThreshold` is set to a lower complexity class than `warnThreshold` (i.e., `COMPLEXITY_ORDER[errorThreshold] <= COMPLEXITY_ORDER[warnThreshold]`), the extension orchestrator MUST treat `errorThreshold` as `warnThreshold` + one step up. Concretely: `effectiveErrorThreshold = complexityClasses[Math.min(COMPLEXITY_ORDER[warnThreshold] + 1, 6)]` where `complexityClasses` is the ordered array `['O(n)', 'O(n log n)', 'O(n^2)', 'O(n^3)', 'O(2^n)']` (indices 0-4, but warnThreshold can be at most index 3 since errorThreshold must be strictly higher).

  The orchestrator spec implements this rule in its OrchestratorConfig validation logic.

- **State after handling**: The manifest is valid. The orchestrator applies the normative conflict resolution rule above before any diagnostic is emitted.

### 5.7 VSIX bundles test files by accident

- **Input condition**: A developer modifies `.vscodeignore` and removes the `src/**` exclusion, or adds test fixture `.ts` files outside `src/`.
- **Expected behavior**: `vsce package` includes the files in the VSIX, inflating bundle size. The extension still functions correctly -- extra files are inert.
- **Resolution**: The `.vscodeignore` as specified excludes `src/**` and `**/*.ts`, which covers both source and fixture files. The `!out/**` exception ensures only compiled JS is included. Test output files (`out/test/`) are included in the VSIX but are inert -- they are never loaded by the extension host.
- **State after handling**: Larger-than-necessary VSIX. Functional correctness is unaffected.

### 5.8 engines.vscode mismatch: user has older VS Code

- **Input condition**: A user attempts to install the VSIX on VS Code < 1.85.0.
- **Expected behavior**: VS Code displays an error dialog: `"Extension 'typescript-complexity-profiler' is not compatible with this version of VS Code."` The extension is not installed.
- **Resolution**: The user must update VS Code to >= 1.85.0.
- **State after handling**: No extension installed. No files written.

### 5.9 User sets inputSizes to fewer than 3 elements

- **Input condition**: The user sets `tsComplexity.inputSizes` to an array with fewer than 3 elements (e.g., `[10, 100]`) via the Settings UI or by directly editing `settings.json`.
- **Expected behavior**: VS Code's settings UI validates the `minItems: 3` constraint and rejects the change with an inline error. If `settings.json` is edited manually to bypass validation, VS Code still marks the setting invalid. The extension reads the invalid setting via `vscode.workspace.getConfiguration()`, which returns the default value `[10, 30, 100, 300, 1000, 3000, 10000]` for schema-invalid arrays. The pipeline is not affected.
- **Resolution**: The user must supply at least 3 input sizes. The schema constraint enforces this at write time.
- **State after handling**: The pipeline runs with the default input sizes. No error is surfaced to the user beyond the inline settings validation marker.

## 6. Dependencies

### Upstream (this component depends on)

None. The extension manifest is Layer 1 -- it has no upstream component dependencies. It is authored before any runtime code exists.

### Downstream (components that depend on this)

- **interface-contracts**: The tsconfig.json in this manifest governs how `src/types.ts` is compiled. The `strict: true` setting ensures that all interface contracts are type-checked with maximum strictness.
- **s1-compiler-bridge**: Requires `typescript` and `source-map` in `dependencies` to be bundled in the VSIX. Uses the `compilerOptions` from tsconfig.json during development compilation.
- **s2-ast-instrumenter**: Requires `acorn` and `escodegen` in `dependencies` to be bundled in the VSIX.
- **s3-input-generator**: Requires `typescript` in `dependencies` (uses the TS type checker at runtime).
- **s4-runtime-executor**: Reads `tsComplexity.timeoutMs` and `tsComplexity.inputSizes` settings declared in this manifest's configuration schema.
- **s5-complexity-analyzer**: Reads `tsComplexity.minConfidence` setting declared in this manifest's configuration schema.
- **s6-annotation-engine**: Reads `tsComplexity.warnThreshold`, `tsComplexity.errorThreshold`, and `tsComplexity.showSidePanel` settings. Registers decorations against command IDs declared in this manifest.
- **extension-orchestrator**: Registers handlers for `tsComplexity.analyzeFile` and `tsComplexity.clearAnnotations` commands. Reads `tsComplexity.enabled` and `tsComplexity.triggerOnSave`. The `main` field points to the orchestrator's compiled output. The `activationEvents` field controls when the orchestrator's `activate()` is called.

### External Dependencies

#### Runtime (bundled in VSIX)

| Package | Version Constraint | Reason |
|---------|-------------------|--------|
| `typescript` | `^5.3.0` | S1 uses `ts.transpileModule()` and the TS type checker. S3 uses the type checker for parameter inspection. Must be bundled because the user's global TS version may differ or be absent. |
| `acorn` | `^8.11.0` | S2 uses Acorn to parse compiled JavaScript into an ESTree-compatible AST. Chosen for speed and minimal footprint (no plugin system overhead). |
| `escodegen` | `^2.1.0` | S2 uses escodegen to regenerate JavaScript source from the instrumented AST. Paired with Acorn's ESTree output format. |
| `source-map` | `^0.7.4` | S1 uses this to parse the inline source map emitted by `ts.transpileModule()` and construct the `SourceMap` interface for JS-to-TS position mapping. |

#### Development (not bundled)

| Package | Version Constraint | Reason |
|---------|-------------------|--------|
| `@types/vscode` | `^1.85.0` | Type declarations for the VS Code Extension API. Version matches `engines.vscode`. The `vscode` module itself is provided by the extension host at runtime -- it is never bundled. |
| `@types/node` | `^20.0.0` | Type declarations for Node.js built-in modules (fs, path, worker_threads, crypto). |
| `@types/escodegen` | `^0.0.7` | Type declarations for escodegen's `generate()` function signature. |
| `@vscode/test-electron` | `^2.3.0` | Downloads and launches a real VS Code instance for running integration tests. Creates the `.vscode-test/` directory. |
| `@vscode/vsce` | `^2.22.0` | CLI tool that packages the extension into a `.vsix` file. Invoked by `npm run package`. |
| `mocha` | `^10.2.0` | Test framework. The VS Code test runner (`src/test/runTest.ts`) bootstraps Mocha inside the test VS Code instance. |
| `@types/mocha` | `^10.0.0` | Type declarations for Mocha's `describe`, `it`, `before`, `after` API. |

#### Implicit Peer Dependency

- **VS Code Extension Host**: Provides the `vscode` module at runtime. This module is never installed via npm -- it is injected by the extension host process. The `@types/vscode` package provides compile-time types only. This is why `vscode` does not appear in `dependencies` or `devDependencies`.

## 7. Configuration

The manifest IS the configuration specification. All 8 user-facing settings are declared in `package.json` under `contributes.configuration.properties`. VS Code validates these against their JSON Schema definitions and exposes them in the Settings UI.

| Key | Type | Default | Valid Range / Options | Effect |
|-----|------|---------|----------------------|--------|
| `tsComplexity.enabled` | boolean | `true` | `true` / `false` | Master switch. When `false`, the orchestrator skips all analysis on save and the `analyzeFile` command is a no-op. Decorations and diagnostics from previous runs remain until explicitly cleared. |
| `tsComplexity.triggerOnSave` | boolean | `true` | `true` / `false` | When `true`, the orchestrator subscribes to `onDidSaveTextDocument` and runs the full S1-S6 pipeline automatically. When `false`, analysis runs only via the `tsComplexity.analyzeFile` command. |
| `tsComplexity.timeoutMs` | number | `5000` | 1000 -- 30000 | Maximum wall-clock time in milliseconds that S4 allows a worker to execute before terminating it. Functions exceeding this limit receive a `TIMEOUT` decoration. Lower values improve responsiveness but may cause false timeouts on complex functions with large input sizes. |
| `tsComplexity.inputSizes` | array of numbers | `[10, 30, 100, 300, 1000, 3000, 10000]` | Array of positive integers; minimum 3 elements, maximum 20 elements. | The set of input sizes (n values) passed to S3 for generating test inputs. S5 fits complexity models against these data points. Fewer sizes = faster analysis but less accurate fitting. Must have at least 3 elements and at most 20 elements (enforced by JSON Schema `minItems: 3` and `maxItems: 20`); VS Code rejects out-of-range arrays at settings-write time. |
| `tsComplexity.minConfidence` | number | `0.92` | 0.5 -- 1.0 | The minimum R-squared value that S5 requires to report a complexity class. Below this threshold, the result is `LOW_CONFIDENCE` and the decoration shows `~Theta(?)`. Lower values produce more classifications but with higher risk of misclassification. |
| `tsComplexity.warnThreshold` | string (enum) | `"O(n^2)"` | `"O(n)"`, `"O(n log n)"`, `"O(n^2)"`, `"O(n^3)"`, `"O(2^n)"` | The minimum complexity class that produces a Warning-severity diagnostic in the Problems panel. Functions at or above this class but below the error threshold show a warning squiggle. |
| `tsComplexity.errorThreshold` | string (enum) | `"O(n^3)"` | `"O(n^2)"`, `"O(n^3)"`, `"O(2^n)"` | The minimum complexity class that produces an Error-severity diagnostic. Functions at or above this class show an error squiggle. Must be >= `warnThreshold` in severity ordering; the orchestrator resolves conflicts at runtime. |
| `tsComplexity.showSidePanel` | boolean | `true` | `true` / `false` | When `true`, S6 automatically opens a WebView panel showing a complexity growth chart after each analysis run. When `false`, the chart is available on demand but does not open automatically. |

### Version Bump Procedure

To release a new version of the VSIX:

1. Update the `"version"` field in `package.json` to the new semver string (e.g., `"0.2.0"`).
2. Run `npm run package`. The `vscode:prepublish` script recompiles, and `vsce package` produces `typescript-complexity-profiler-0.2.0.vsix`.
3. Distribute the new `.vsix` file. Users install with `code --install-extension typescript-complexity-profiler-0.2.0.vsix`.

There is no changelog mechanism in v1. Version history is tracked in git commits.

## 8. Acceptance Criteria

### Functional Criteria

- [ ] **AC-1: VSIX builds successfully** -- Given a clean checkout with `npm install` completed, when `npm run package` is executed, then the command exits with code 0 and produces a file named `typescript-complexity-profiler-0.1.0.vsix` in the project root.

- [ ] **AC-2: VSIX installs and activates** -- Given the `.vsix` file from AC-1, when `code --install-extension typescript-complexity-profiler-0.1.0.vsix` is run and VS Code opens a `.ts` file, then the extension appears in the Extensions sidebar as "TypeScript Complexity Profiler" with status "Active".

- [ ] **AC-3: Settings appear in VS Code UI** -- Given the extension is installed, when the user opens Settings and searches for "tsComplexity", then all 8 configuration settings (`enabled`, `triggerOnSave`, `timeoutMs`, `inputSizes`, `minConfidence`, `warnThreshold`, `errorThreshold`, `showSidePanel`) are listed with correct types (boolean checkboxes, number inputs with min/max, enum dropdowns, array editor), correct default values, and correct description text.

- [ ] **AC-4: Commands appear in Command Palette** -- Given the extension is active, when the user opens the Command Palette (Ctrl+Shift+P / Cmd+Shift+P) and types "complexity", then both "TypeScript Complexity: Analyze Complexity" and "TypeScript Complexity: Clear Complexity Annotations" appear as options.

- [ ] **AC-5 (no source TypeScript in VSIX)**: The VSIX must not contain any `.ts` files from the extension's own source tree (i.e., no `extension/**/*.ts` or `src/**/*.ts` files). `.d.ts` type declaration files within bundled `node_modules/typescript/lib/` are permitted -- they are part of the bundled `typescript` runtime dependency and are not extension source code. Verify by running `unzip -l *.vsix | grep '\.ts$' | grep -v 'node_modules/'` -- the output must be empty. The `out/` directory's `.js` files are present.

- [ ] **AC-6: TypeScript compiles with zero errors** -- Given a clean checkout with `npm install` completed, when `npx tsc -p ./ --noEmit` is executed, then the command exits with code 0 and produces no diagnostic output.

- [ ] **AC-7: Runtime dependencies are in dependencies** -- Given `package.json`, when the `dependencies` object is inspected, then it contains `typescript`, `acorn`, `escodegen`, and `source-map`. None of these four packages appear in `devDependencies`.

- [ ] **AC-8: Engine version supports worker_threads** -- Given `package.json`, when the `engines.vscode` field is inspected, then the minimum version is `^1.85.0` (or higher), which ships Node.js >= 18 with stable `worker_threads` support.

- [ ] **AC-9 (RUNTIME_ERROR decoration)**: Given a fixture function that throws `Error('boom')` during worker execution, when the pipeline completes, then an inline decoration reading `  ERROR` appears at the function signature (consistent with §3.2 of the S6 annotation engine spec), and a `DiagnosticSeverity.Error` diagnostic is added to the Problems panel for that function's line. The extension host does not throw an unhandled exception.
