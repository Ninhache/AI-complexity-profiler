# ADR-001: Use Acorn + escodegen for JavaScript AST Parsing and Code Generation

**Status**: Accepted
**Date**: 2026-03-27
**Deciders**: Architecture team

## Context

The S2 Instrumenter subsystem must parse compiled JavaScript (output from `ts.transpileModule()`), traverse the AST to inject `__op()` counter calls at loops and function entries, and then regenerate valid JavaScript from the mutated AST. This requires a parser that is accurate, stable, and whose output AST can be round-tripped back to source code.

Four candidates were evaluated. **Acorn** is a small (~100KB), fast, spec-compliant ES2020 JavaScript parser with no plugin system and a stable, well-documented AST node format (ESTree). **Babel** (`@babel/parser` + `@babel/generator`) is the standard tool in the transpilation ecosystem but carries a multi-megabyte bundle of plugins, preset machinery, and helper infrastructure that is designed for transpilation workflows — not instrumentation of already-compiled output. **SWC** is a high-performance Rust-based parser and transformer, but integrating it into a VS Code extension host requires native binaries, which complicates VSIX packaging and cross-platform distribution. **Recast** is a wrapper around other parsers (typically Babel) that attempts to preserve original formatting; it adds a layer of complexity without meaningful benefit here because the extension regenerates instrumented code that is never shown to the user.

VSIX bundle size is a hard constraint. A large extension activates slowly and hurts the VS Code Marketplace rating. The extension also does not need TypeScript parsing at this stage — S1 (Compiler Bridge) has already produced plain JavaScript before S2 receives it.

## Decision

Acorn is used as the sole parser for the S2 Instrumenter. escodegen is used as the paired code regenerator. Both libraries are well-maintained, operate on the same ESTree AST format, and together total well under 500KB in the final bundle.

Babel is rejected because its bundle size would add multiple megabytes to the VSIX for features (preset resolution, plugin chaining, source-map splicing) that are not needed. SWC is rejected because native binaries cannot be reliably bundled in a VSIX for all platforms (Windows x64, macOS arm64, Linux x64). Recast is rejected because formatting preservation in the instrumented JS is irrelevant — that code is only executed inside a Worker, never displayed. A round-trip through Acorn + escodegen produces valid, executable JavaScript, which is the only requirement.

## Consequences

### Positive
- VSIX bundle stays small; Acorn + escodegen contribute under 500KB combined
- ESTree AST format is a stable, well-documented standard; node types for loops and function declarations are unambiguous
- Acorn parses ES2020, which covers all output from `ts.transpileModule()` targeting ES2017 or later
- No native binaries required; the extension installs without platform-specific steps
- escodegen is the canonical regenerator for Acorn ASTs; the pairing is widely tested in production

### Negative
- Acorn has no plugin system; any future need to parse non-standard syntax (e.g., decorators at stage 2) would require a parser switch or a fork
- escodegen does not preserve original formatting or comments in regenerated output; debugging instrumented code is harder than with Recast
- Neither library is actively developed by a large organization; long-term maintenance depends on the open-source community

### Mitigations
- v1 targets only TypeScript files compiled to standard ES2017+ JavaScript, so no non-standard syntax is expected; if decorators become relevant in v2, the parser choice can be revisited in a new ADR
- The instrumented JS is only executed inside a Worker and is never rendered to the user; formatting loss has no user-visible impact
- Acorn has been stable since 2012 with thousands of dependents; escodegen is similarly mature; the maintenance risk is low for the v1 timeline
