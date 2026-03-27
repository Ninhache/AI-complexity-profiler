# TypeScript Complexity Profiler

> **Status**: Concept — decisions finalized, ready for design phase
> **Created**: 2026-03-26
> **Spec Source**: spec-poc.pdf (v1.0.0, March 2026)

## Elevator Pitch

A VS Code extension that tells you the algorithmic complexity of every TypeScript function — inline, on every save — with no copy-pasting, no external tools, and no AI.

## Core Value Proposition

Developers write O(n²) functions without realizing it. Static linters can't detect this — only empirical measurement can. This extension instruments code, runs it, fits a complexity model to the growth curve, and renders `Θ(n²) ⚠` directly after the function signature. Complexity lives next to the code that produces it.

## The Problem

Algorithmic complexity bugs are invisible to static analysis. ESLint won't catch a quadratic loop. TypeScript's type checker doesn't know about runtime growth. The current workflow is: notice slowness in production, profile with DevTools, realize the algorithm is wrong. This extension moves that discovery to the moment of writing — at save time, in the editor, without leaving the workflow.

## Architecture

Six subsystems connected in a strict left-to-right pipeline. Each has typed interface contracts; no subsystem reaches back into a prior stage.

| Subsystem | Responsibility | Primary Output |
|-----------|---------------|----------------|
| S1 — Compiler Bridge | Compile TS → JS via `ts.transpileModule()`, extract inline source map | `compiledJs`, `sourceMap`, `diagnostics` |
| S2 — AST Instrumenter | Parse JS with Acorn, inject `__op()` counters at loops/recursion/function entries, regenerate via escodegen | `instrumentedJs`, `nodeRegistry`, `functionBoundaries` |
| S3 — Input Generator | Inspect function signatures via TS type checker, generate typed inputs at sizes [10,30,100,300,1000,3000,10000] | `InputSet[]` per function |
| S4 — Runtime Executor | Run instrumented code in a `worker_threads` Worker, collect `{n, opCount}` per function, enforce 5s timeout | `MeasurementMatrix`, `timedOut`, `errors` |
| S5 — Complexity Analyzer | Least-squares regression against 7 complexity models, select best fit by R² ≥ 0.92 | `ComplexityResult[]` |
| S6 — Annotation Engine | Render inline end-of-line decorations, diagnostics, WebView side panel | VS Code UI state |

### Data Flow (per save)

```
onDidSaveTextDocument (.ts file)
  → S1: ts.transpileModule() → compiledJs + sourceMap
  → S2: Acorn parse → inject __op() → escodegen → instrumentedJs + nodeRegistry
  → S3: TS type checker → typed InputSets per function
  → S4: Worker.postMessage(instrumentedJs + inputs) → MeasurementMatrix
  → S5: curve fit → ComplexityResult[]
  → S6: inline decorations + diagnostics + WebView chart
```

## Design Decisions (§11 Open Questions — Resolved)

| # | Question | Decision | Rationale |
|---|---------|----------|-----------|
| S2 | Instrument bracket access `arr[i]`? | **No** | Loop and recursion counters already capture growth. Bracket instrumentation adds noise to simple O(n) functions. Matrix ops still classified correctly via loop counters. |
| S3 | Multi-parameter growth: all params or first collection? | **First array/collection only** | Only the first `T[]` / `Map` / `Set` / `Record` parameter grows with n. Scalar params (`number`, `string`) receive a fixed mid-range value. Predictable growth curve, no cross-dimension confusion for the fitter. |
| S4 | Worker pooling vs fresh per save? | **Fresh worker per save** | ~50ms cold-start cost is within the 400ms S4 budget. Zero state leakage between runs; no reset protocol needed. |
| S5 | R² < 0.92 fallback behavior? | **Show `~Θ(?)` as Hint** | Signals that the function was analyzed but the pattern is ambiguous. Actionable — prompts inspection. Silence would be indistinguishable from "not analyzed." |
| S6 | Gutter annotation vs inline end-of-line? | **Inline end-of-line** | `Θ(n²) ⚠` appears after the function signature on the same line. Impossible to miss; immediately associated with the function. Trade-off: clutters long signatures. |

## Instrumentation Strategy

Counter calls injected at:
- `ForStatement`, `WhileStatement`, `DoWhileStatement`, `ForInStatement`, `ForOfStatement` — top of loop body
- `CallExpression` (recursive calls) — at call site
- `FunctionDeclaration`, `ArrowFunction` — function entry (baseline counter)

**Not instrumented:** `MemberExpression` bracket access (`arr[i]`) — decision above.

Node IDs are deterministic hashes of `file + line + column` — stable across re-parses.

## Complexity Classes

| Class | Model | Typical Source |
|-------|-------|----------------|
| O(1) | f(n) = c | No loops, no recursion |
| O(log n) | f(n) = c·log₂(n) | Binary search, tree traversal |
| O(n) | f(n) = c·n | Single loop |
| O(n log n) | f(n) = c·n·log₂(n) | Efficient sort, divide & conquer |
| O(n²) | f(n) = c·n² | Nested loops |
| O(n³) | f(n) = c·n³ | Triple-nested loops |
| O(2ⁿ) | f(n) = c·2ⁿ (capped at n≤30) | Naive recursion, power sets |

Fitting: ordinary least-squares on linearized model per candidate. Best fit = highest R² above 0.92. Below threshold → `LOW_CONFIDENCE` → `~Θ(?)` decoration.

## Decoration Scheme

| Complexity | Inline Label | Diagnostic |
|------------|-------------|------------|
| O(1) | `Θ(1) ✓` | None |
| O(log n) | `Θ(log n) ✓` | None |
| O(n) | `Θ(n)` | Information |
| O(n log n) | `Θ(n log n)` | Information |
| O(n²) | `Θ(n²) ⚠` | Warning |
| O(n³) | `Θ(n³) ✗` | Error |
| O(2ⁿ) | `Θ(2ⁿ) ✗✗` | Error |
| LOW_CONFIDENCE | `~Θ(?)` | Hint |
| INSUFFICIENT_DATA | *(none)* | None |
| TIMEOUT | `TIMEOUT` | Error |

## Performance Targets

| Stage | Target | Hard Limit |
|-------|--------|------------|
| End-to-end (50-line file) | < 800ms | 2000ms |
| End-to-end (500-line file) | < 3000ms | 8000ms |
| S1 compilation | < 300ms | 600ms |
| S2 instrumentation | < 100ms | 300ms |
| S4 worker execution | < 400ms | 5000ms (timeout) |
| S5 curve fitting (per function) | < 20ms | 100ms |
| S6 decoration render | < 50ms | 200ms |

Progress indicator appears in VS Code status bar if first run exceeds 2000ms.

## Technology Stack

- **Runtime**: Node.js (VS Code extension host)
- **Compiler**: TypeScript Compiler API (`ts.transpileModule`)
- **AST Parser**: Acorn (lightweight, no plugin system needed)
- **Code Generator**: escodegen
- **Sandboxing**: `worker_threads.Worker` (same process space — v1 trusts user code)
- **UI**: VS Code Extension API — `TextEditorDecorationType`, `DiagnosticCollection`, `WebviewPanel`
- **Chart**: Plain Canvas API (no external chart library in extension bundle)

## Target Users

- **Primary**: TypeScript developers who care about performance — library authors, backend engineers, anyone writing data-processing or algorithmic code
- **Secondary**: Code reviewers catching O(n²) regressions in PRs before they merge
- **Not for**: JavaScript-only projects (v1 TypeScript only), users who want cross-file module analysis

## MVP Definition

A working VSIX that:
1. Activates on `.ts` file save
2. Runs the full S1→S6 pipeline
3. Shows inline complexity annotations on function declarations
4. Correctly classifies the 8 fixture files (bubble sort, binary search, linear scan, merge sort, constant, infinite loop, no functions, compiler error)

## Scope Tiers

| Tier | Contents | Notes |
|------|---------|-------|
| MVP (v1) | S1–S6 pipeline, VSIX local install, TypeScript only, standalone functions only | Per spec §10 out-of-scope list |
| v1.1 | Worker pooling option (config flag), generator function support | Performance optimization + coverage |
| v2 | VS Code Marketplace publish, class method analysis, cross-file tracking, vm.runInNewContext sandbox | Distribution + correctness |
| Full Vision | Space complexity (memory profiling), custom complexity models, JS file support | Research-grade |

## Multi-Agent Build Plan

7 agents, each owning one subsystem + tests. Parallel-safe once interface contracts are locked (§4 of spec defines the typed boundaries).

| Agent | Owns | Parallel-Safe After |
|-------|-----|---------------------|
| Agent 1 — Compiler | S1 + unit tests | Day 0 |
| Agent 2 — Instrumenter | S2 + unit tests | Day 0 |
| Agent 3 — Generator | S3 + unit tests | S2 interface locked |
| Agent 4 — Executor | S4 + worker harness | S2 + S3 locked |
| Agent 5 — Analyzer | S5 + regression tests | S4 locked |
| Agent 6 — UI | S6 + WebView + E2E tests | S5 locked |
| Agent 7 — Integration | `extension.ts`, pipeline orchestration, settings | All locked |

## Risk Register

| Risk | Type | Mitigation |
|------|------|-----------|
| Input generator produces flat curves (wrong types) | Technical | Type-to-growth mapping table in spec; fallback to `unknown` → array of n numbers |
| Worker timeout kills measurement for large functions | Technical | 5s hard limit; TIMEOUT decoration surfaced to user |
| S1 compilation cache invalidation on tsconfig change | Technical | Cache key includes tsconfig mtime |
| Curve fitter misclassifies O(n log n) as O(n) for small n | Design | Regression test fixture: merge_sort.ts must hit R² > 0.94 |
| Inline end-of-line decoration clutters long function signatures | Design | Accepted trade-off; user can toggle via `tsComplexity.enabled` |
| Worker state not fully isolated (v1 trusts user code) | Technical | Documented security boundary; v2 will use vm.runInNewContext |

## Open Questions (Deferred to v2)

- [ ] Class method analysis — how to handle `this` context in instrumented workers
- [ ] Cross-file dependency tracking — functions calling imported functions will show incorrect complexity
- [ ] Custom complexity model hooks — user-defined f(n) candidates
