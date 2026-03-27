# TypeScript Complexity Profiler

A VS Code extension that shows the algorithmic complexity of every TypeScript function — inline, on every save.

## What it does

Instruments your TypeScript code, runs it with varying input sizes, fits a complexity model (O(1) through O(2^n)) to the growth curve, and renders `Θ(n²) ⚠` directly after the function signature on every save. No copy-pasting. No external tools. No AI.

## Prerequisites

- Node.js 18+
- VS Code 1.85+
- `npm install -g @vscode/vsce` (for VSIX packaging)

## Setup

```bash
npm install
```

## Development

```bash
# Watch mode (recompiles on change)
npm run watch

# Open in Extension Development Host
# Press F5 in VS Code (or Run > Start Debugging)
```

## Build VSIX

```bash
vsce package
# Produces typescript-complexity-profiler-<version>.vsix

# Install locally
code --install-extension typescript-complexity-profiler-<version>.vsix
```

## Run Tests

```bash
npm test
```

## Architecture

Six-subsystem pipeline: S1 (Compiler) → S2 (Instrumenter) → S3 (Input Generator) → S4 (Executor) → S5 (Analyzer) → S6 (Annotation Engine).

See `docs/specs/` for full component specifications and `docs/architecture/` for architecture decision records.
