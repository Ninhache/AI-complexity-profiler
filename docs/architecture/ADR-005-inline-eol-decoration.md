# ADR-005: Render Complexity Annotations as Inline End-of-Line Text Decorations

**Status**: Accepted
**Date**: 2026-03-27
**Deciders**: Architecture team

## Context

The S6 Annotation Engine must surface complexity results to the developer inside VS Code. The result is a short label such as `Θ(n²) ⚠` or `Θ(1) ✓`. Three rendering approaches were evaluated for where and how this label appears.

**Inline end-of-line decoration** uses VS Code's `TextEditorDecorationType` with `after` content to append styled text directly after the last character on the function's opening line (e.g., after `function bubbleSort(arr: number[]): number[] {`). The developer sees the label in the same visual scan as the function signature — no interaction required. **Gutter icons** use a `DecorationRenderOptions` with `gutterIconPath` to place a small colored icon in the margin to the left of the line number. Gutter icons are commonly used for breakpoints and git blame; they are small, visually subtle, and require a hover interaction to reveal the label text. A developer scanning code quickly will often miss them. **Hover-only display** attaches a `HoverProvider` that shows the complexity label only when the cursor rests over the function name. This has zero ambient visibility — the developer must already know to look for the annotation, defeating the purpose of surfacing complexity proactively.

The primary user value of the extension is ambient, passive complexity awareness: the developer should see the complexity label without taking any action. End-of-line placement achieves this. The accepted trade-off is visual clutter on long function signatures (e.g., a generic function with a long parameter list). This clutter is manageable because: (1) the label is short (max ~12 characters), (2) VS Code renders it in a dimmed color, visually separated from the actual code, and (3) the entire decoration system can be toggled off via the `tsComplexity.enabled` setting.

## Decision

S6 renders complexity results as inline end-of-line text decorations using `vscode.window.createTextEditorDecorationType` with `after: { contentText, color, fontStyle }`. The decoration is placed on the line containing the function's opening brace (i.e., the function signature line as identified by the `functionBoundaries` map from S2).

Gutter icons are rejected as a primary annotation surface because they are too easy to overlook and require hover to convey the label text. They may be added as a supplementary visual in a future iteration, but they cannot serve as the primary annotation. Hover-only display is rejected because it provides no ambient visibility — the developer must already be suspicious about a function's complexity to check it, which is exactly the situation the extension is designed to prevent. A secondary hover tooltip (in addition to the inline label) is planned for v1.1 to surface additional detail (R² score, raw measurements), but the inline label remains the primary surface.

## Consequences

### Positive
- The complexity label is visible on every function signature in the active editor without any interaction
- The label is spatially co-located with the function definition, making the association between label and function unambiguous
- VS Code's `after` decoration renders in a distinct visual style (dimmed, italic) that signals "annotation" rather than "code"
- The decoration is updated on every save, so the label always reflects the current state of the function
- The `tsComplexity.enabled` toggle gives users control if clutter is unacceptable

### Negative
- Functions with long parameter lists or long return types (common in TypeScript generics) can have their signature line pushed further right, and the label may appear far from the function name
- The end-of-line position means the label is not visible in diff views or when the editor column is narrow
- Inline `after` decorations are not searchable, printable, or visible in VS Code's Outline view — the annotation exists only in the rendered editor

### Mitigations
- Label length is capped at approximately 12 characters (`Θ(n log n)` is the longest standard label); this limits horizontal displacement
- A hover tooltip on the function name (planned for v1.1) will provide the full complexity detail in contexts where the inline label is not visible (narrow columns, diff views)
- The `tsComplexity.enabled` setting disables all decorations globally; a per-file or per-function disable mechanism is tracked as a v2 enhancement
