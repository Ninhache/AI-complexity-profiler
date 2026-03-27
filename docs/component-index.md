# Component Index

> **Project**: TypeScript Complexity Profiler
> **Last Updated**: 2026-03-27
> **Status**: 10/10 components have specs

## Component Inventory

| Component | Category | Layer | Priority | Spec | Notes |
|-----------|----------|-------|----------|------|-------|
| interface-contracts | Contracts | 1 | MVP | [x] | Shared TS types: SourceMap, FunctionBoundary, InputSet, MeasurementPoint, ComplexityResult |
| extension-manifest | DevOps | 1 | MVP | [x] | package.json, settings schema, VSIX config |
| test-fixtures | DevOps | 1 | MVP | [x] | 8 .ts fixture files under test/fixtures/ |
| s1-compiler-bridge | Core | 2 | MVP | [x] | ts.transpileModule(), inline source map, compilation cache |
| s2-ast-instrumenter | Core | 2 | MVP | [x] | Acorn parse, __op() injection, escodegen, nodeRegistry |
| s3-input-generator | Core | 3 | MVP | [x] | TS type checker, type-to-input mapping, deterministic seed |
| s4-runtime-executor | Core | 3 | MVP | [x] | worker_threads.Worker, timeout enforcement, counter extraction |
| s5-complexity-analyzer | Core | 4 | MVP | [x] | Least-squares regression, R² selection, source map attribution |
| s6-annotation-engine | UI | 5 | MVP | [x] | Inline decorations, DiagnosticCollection, WebView Canvas chart |
| extension-orchestrator | Integration | 6 | MVP | [x] | extension.ts activation, pipeline wiring, cancellation, status bar |

## Layer Architecture

### Layer 1: Foundation
- **interface-contracts** — TypeScript type definitions for all cross-subsystem data structures. Must be locked before Layer 2 begins.
- **extension-manifest** — `package.json` contributions, settings schema, activation events, VSIX packaging config.
- **test-fixtures** — 8 `.ts` files under `test/fixtures/` used by integration tests. Designed alongside the integration agent.

### Layer 2: Core (parallel-safe from Day 0)
- **s1-compiler-bridge** — depends on: `interface-contracts` (SourceMap type)
- **s2-ast-instrumenter** — depends on: `interface-contracts` (FunctionBoundary, NodeMeta types)

### Layer 3: Feature (parallel-safe once S2 interface is locked)
- **s3-input-generator** — depends on: `s1-compiler-bridge` (SourceMap), `s2-ast-instrumenter` (FunctionBoundary[])
- **s4-runtime-executor** — depends on: `s2-ast-instrumenter` (instrumentedJs, FunctionBoundary[]), `s3-input-generator` (InputSet[])

### Layer 4: Analysis (after S4 interface locked)
- **s5-complexity-analyzer** — depends on: `s1-compiler-bridge` (SourceMap), `s2-ast-instrumenter` (nodeRegistry), `s4-runtime-executor` (MeasurementMatrix)

### Layer 5: Presentation (after S5 interface locked)
- **s6-annotation-engine** — depends on: `s5-complexity-analyzer` (ComplexityResult[]), VS Code TextEditor API

### Layer 6: Integration (all interfaces locked)
- **extension-orchestrator** — depends on: S1–S6 (all outputs), `extension-manifest` (settings), VS Code API (onDidSaveTextDocument, StatusBarItem)

## Design Order

Components should be designed in this order:

1. `interface-contracts` — locks all cross-subsystem types first
2. `s1-compiler-bridge` — no upstream deps, parallel with S2
3. `s2-ast-instrumenter` — no upstream deps, parallel with S1 ← **highest algorithmic risk**
4. `s3-input-generator` — after S1+S2 specs approved
5. `s4-runtime-executor` — after S2+S3 specs approved
6. `s5-complexity-analyzer` — after S4 spec approved ← **highest math risk**
7. `s6-annotation-engine` — after S5 spec approved
8. `extension-orchestrator` — after all subsystem specs approved
9. `extension-manifest` — alongside orchestrator
10. `test-fixtures` — alongside orchestrator (integration tests)

## High-Risk Components

| Component | Risk | Reason |
|-----------|------|--------|
| **s2-ast-instrumenter** | High | AST walking + code injection is the most algorithmically complex subsystem. An off-by-one in injection point placement corrupts all downstream measurements. |
| **s5-complexity-analyzer** | High | Least-squares regression on linearized models is subtle. O(n log n) vs O(n) is easily confused for small n. Needs concrete worked examples in the spec. |
| **s3-input-generator** | Medium | Type-to-input mapping must produce inputs that actually exercise growth. Wrong types → flat curves → all functions classified O(1). |
| **s4-runtime-executor** | Medium | Worker lifecycle and timeout enforcement must be rock-solid. State leakage between runs is silent and produces wrong measurements. |

## Cross-Subsystem Interface Contracts (from spec §4)

These are the typed boundaries between layers. Agent implementations must not modify these without cross-agent sign-off.

```typescript
// S1 → S2, S1 → S5
interface SourceMap {
  jsToTs(jsLine: number, jsCol: number): { tsLine: number; tsCol: number };
}

// S2 → S3, S2 → S4, S2 → S5
interface FunctionBoundary {
  functionId: string;   // stable hash
  name:       string;   // inferred name or '<anonymous>'
  jsStartLine: number;
  jsStartCol:  number;  // 0-indexed — required by S3 and S5 for jsToTs() lookup
  jsEndLine:   number;
  paramTypes:  string[]; // TS type strings, e.g. ['number[]', 'number']
}

// S3 → S4
interface InputSet {
  functionId: string;
  n:          number;
  args:       unknown[]; // serializable
}

// S4 → S5
interface MeasurementPoint {
  functionId:   string;
  n:            number;
  opCount:      number;
  nodeCounters: Record<string, number>; // nodeId -> count
}
```

## Progress Tracker

| Phase | Count | Status |
|-------|-------|--------|
| MVP components | 10 | 10 with specs |
| v1.0 components | 0 | — |
| Total | 10 | 10/10 specs written |
