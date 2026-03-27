# TypeScript Complexity Profiler

A VS Code extension that shows the algorithmic complexity of every TypeScript function — inline, on every save.

> **This entire project was written by [Claude](https://claude.ai) (Anthropic) — every line of code, every spec, every architecture decision record, every commit. Zero human-written code.**

---

## What it does

Instruments your TypeScript code, runs it with varying input sizes, fits a complexity model (O(1) through O(2^n)) to the growth curve, and renders `Θ(n²) ⚠` directly after the function signature on every save.

Click a decorated line to open a log-log chart showing the measured data points and the best-fit curve.

---

## Prerequisites

- Node.js 18+
- VS Code 1.85+

## Setup

```bash
npm install
```

## Development

```bash
# Recompile on every change
npm run watch

# Launch Extension Development Host
# Press F5 in VS Code
```

## Build VSIX

```bash
npm run package
code --install-extension typescript-complexity-profiler-*.vsix
```

---

## Architecture

Six-subsystem pipeline triggered on every file save:

```
S1 Compiler Bridge   →  TypeScript → JS + source map
S2 AST Instrumenter  →  Injects __op() counters at loops, function entries, recursive calls
S3 Input Generator   →  Generates typed inputs at 7 sizes: [10, 30, 100, 300, 1000, 3000, 10000]
S4 Runtime Executor  →  Runs instrumented JS in a worker_threads Worker, enforces 5s timeout
S5 Complexity Analyzer →  OLS regression over 7 candidate models, selects best R² fit
S6 Annotation Engine →  Inline decorations + Problems panel diagnostics + WebView chart
```

Full specs in `docs/specs/`, architecture decisions in `docs/architecture/`.

---

## Made with Claude

This project is a proof of concept for fully AI-driven software development.

The entire codebase — concept, component design, 10 detailed specs, 5 ADRs, all 8 TypeScript source files, bug fixes, and this README — was produced in a single extended session with **Claude Sonnet** (Anthropic) using [Claude Code](https://claude.ai/code).

The human role was: describe the idea, approve specs, trigger F5, report bugs.
Claude's role was: everything else.
