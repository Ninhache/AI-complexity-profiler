/**
 * @file src/s1-compiler-bridge.ts
 *
 * S1 — Compiler Bridge
 *
 * Entry point of the analysis pipeline. Compiles a TypeScript file to JavaScript
 * using ts.transpileModule(), extracts an inline source map, and caches results
 * keyed on file + tsconfig modification times.
 *
 * Public API:
 *   compileFile(filePath, tsConfigPath?) — compile and return CompilerBridgeResult
 *   resetCache()                         — clear the compilation cache (for tests only)
 */

import * as ts from 'typescript';
import { SourceMapConsumer } from 'source-map';
import * as path from 'path';
import * as fs from 'fs';

import {
  CompilerBridgeResult,
  CompilerBridgeError,
  TSDiagnostic,
  SourceMap,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The five mandatory compiler options that always override tsconfig values. */
const MANDATORY_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.CommonJS,
  strict: false,
  inlineSourceMap: true,
  inlineSources: false,
};

/** Prefix used to locate the inline source map comment in transpiler output. */
const SOURCE_MAP_PREFIX = '//# sourceMappingURL=data:application/json;base64,';

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

/** Cache key format: "${filePath}:${fileMtimeMs}:${tsConfigMtimeMs}" */
type CacheKey = string;

/**
 * Compilation cache keyed on file + tsconfig modification times.
 * Never evicted — the extension lifetime is bounded by the VS Code window session.
 */
const cache: Map<CacheKey, CompilerBridgeResult> = new Map();

/**
 * Clears the compilation cache.
 * Exported for unit tests only — not part of the production API surface.
 */
export function resetCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Maps a ts.DiagnosticCategory to the TSDiagnostic severity string.
 *
 * @param category - TypeScript diagnostic category.
 * @returns The corresponding severity literal.
 */
function mapCategory(category: ts.DiagnosticCategory): TSDiagnostic['severity'] {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return 'error';
    case ts.DiagnosticCategory.Warning:
      return 'warning';
    case ts.DiagnosticCategory.Suggestion:
      return 'suggestion';
    case ts.DiagnosticCategory.Message:
    default:
      // Informational messages fall back to 'suggestion' per spec Section 3.5.
      return 'suggestion';
  }
}

/**
 * Resolves compiler options from an optional tsconfig path.
 *
 * Implements the algorithm in spec Section 3.4:
 * - If tsConfigPath is absent or empty, return the five mandatory defaults.
 * - If the tsconfig can be read and parsed, merge it with mandatory options
 *   (mandatory options always win).
 * - If the tsconfig cannot be read or parsed, push a warning diagnostic and
 *   fall back to the five mandatory defaults.
 *
 * @param tsConfigPath - Absolute path to tsconfig.json, or null/undefined.
 * @returns Resolved compiler options and any synthetic diagnostics.
 */
function resolveCompilerOptions(tsConfigPath: string | null | undefined): {
  options: ts.CompilerOptions;
  diagnostics: TSDiagnostic[];
} {
  const diagnostics: TSDiagnostic[] = [];

  if (!tsConfigPath) {
    return { options: { ...MANDATORY_OPTIONS }, diagnostics };
  }

  const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile);

  if (configFile.error) {
    const errorText = ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n');
    diagnostics.push({
      message: `tsconfig.json could not be loaded: ${errorText}`,
      line: 0,
      col: 0,
      severity: 'warning',
    });
    return { options: { ...MANDATORY_OPTIONS }, diagnostics };
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsConfigPath),
  );

  // Mandatory options always override tsconfig values — spec Section 3.4, step 4.
  const options: ts.CompilerOptions = {
    ...parsed.options,
    ...MANDATORY_OPTIONS,
  };

  return { options, diagnostics };
}

/**
 * Converts raw ts.Diagnostic entries from transpileModule() to TSDiagnostic[].
 *
 * Line and column numbers are converted from 0-indexed to 1-indexed per spec
 * Section 3.5, step 6.
 *
 * @param tsDiagnostics - Raw diagnostics from ts.transpileModule().
 * @param sourceText    - The original TypeScript source text (used for position lookup).
 * @param filePath      - Path used when creating the synthetic SourceFile for position lookup.
 * @returns Array of TSDiagnostic with 1-indexed line/col.
 */
function convertDiagnostics(
  tsDiagnostics: readonly ts.Diagnostic[],
  sourceText: string,
  filePath: string,
): TSDiagnostic[] {
  if (tsDiagnostics.length === 0) {
    return [];
  }

  // Create a SourceFile once for position lookups — same sourceText as transpileModule used.
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.ES2020);

  return tsDiagnostics.map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    const severity = mapCategory(d.category);

    if (d.start == null) {
      // No position information available — use sentinel 0,0 per spec Section 5.5 pattern.
      return { message, line: 0, col: 0, severity };
    }

    const pos = ts.getLineAndCharacterOfPosition(sourceFile, d.start);
    // pos.line and pos.character are 0-indexed; spec requires 1-indexed.
    return {
      message,
      line: pos.line + 1,
      col: pos.character + 1,
      severity,
    };
  });
}

/**
 * Extracts and constructs a SourceMap from the inline base64 source map comment
 * embedded in transpiler output.
 *
 * Implements spec Section 3.6 and Section 4.2:
 * - Finds the last line starting with the base64 prefix.
 * - Decodes, parses, constructs SourceMapConsumer, extracts mapping closure,
 *   destroys consumer immediately to release WASM memory.
 * - If no source map line is found, returns a constant-fallback SourceMap.
 *
 * Also strips the sourceMappingURL line from the output text, returning clean JS.
 *
 * @param outputText - The raw string returned by ts.transpileModule().outputText.
 * @returns An object with the clean compiledJs and the resolved SourceMap.
 */
async function buildSourceMap(outputText: string): Promise<{ compiledJs: string; sourceMap: SourceMap }> {
  // Constant-fallback SourceMap — used when no source map line is present.
  const fallbackSourceMap: SourceMap = {
    jsToTs: (_jsLine: number, _jsCol: number) => ({ tsLine: 1, tsCol: 0 }),
  };

  const lines = outputText.split('\n');

  // Spec Section 4.2 step 2: iterate in reverse, find last matching line.
  let sourceMapLineIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(SOURCE_MAP_PREFIX)) {
      sourceMapLineIndex = i;
      break;
    }
  }

  if (sourceMapLineIndex === -1) {
    // Spec Section 3.6 step 3: silent fallback, no diagnostic pushed.
    return { compiledJs: outputText, sourceMap: fallbackSourceMap };
  }

  // Strip the sourceMappingURL line before returning compiledJs — spec Section 3.6 step 9.
  const strippedLines = lines.filter((_, i) => i !== sourceMapLineIndex);
  // Remove trailing newline that splitting on '\n' may have introduced.
  const compiledJs = strippedLines.join('\n').replace(/\n$/, '');

  const base64Payload = lines[sourceMapLineIndex].substring(SOURCE_MAP_PREFIX.length);
  const rawJson = Buffer.from(base64Payload, 'base64').toString('utf-8');
  const rawSourceMap = JSON.parse(rawJson);

  // Spec Section 3.6 step 7: await constructor (source-map 0.7.x returns a Promise).
  // Eagerly materialize all mappings before destroying the consumer — the closure must
  // not reference a live consumer, as destroy() frees the underlying WASM memory and
  // any subsequent call to originalPositionFor() would be undefined behavior.
  const consumer = await new SourceMapConsumer(rawSourceMap);

  const allMappings = new Map<string, { tsLine: number; tsCol: number }>();
  consumer.eachMapping((m) => {
    if (m.originalLine != null) {
      allMappings.set(`${m.generatedLine}:${m.generatedColumn}`, {
        tsLine: m.originalLine,
        // m.originalColumn is 0-indexed per source-map library convention.
        tsCol: m.originalColumn ?? 0,
      });
    }
  });

  consumer.destroy();

  // The closure captures only the plain Map — no reference to the destroyed consumer.
  const jsToTs = (jsLine: number, jsCol: number): { tsLine: number; tsCol: number } =>
    allMappings.get(`${jsLine}:${jsCol}`) ?? { tsLine: 1, tsCol: 0 };

  return { compiledJs, sourceMap: { jsToTs } };
}

/**
 * Compiles a TypeScript file to JavaScript using ts.transpileModule().
 *
 * Results are cached keyed on `${filePath}:${fileMtimeMs}:${tsConfigMtimeMs}`.
 * The cache is never evicted.
 *
 * @param filePath     - Absolute path to the .ts source file to compile.
 * @param tsConfigPath - Optional absolute path to a tsconfig.json. Both undefined
 *                       and null mean "no tsconfig"; treated identically.
 * @returns A CompilerBridgeResult with compiledJs, sourceMap, and diagnostics.
 * @throws CompilerBridgeError if the source file cannot be read.
 */
export async function compileFile(
  filePath: string,
  tsConfigPath?: string | null,
): Promise<CompilerBridgeResult> {
  // Step 1: Stat the source file to get its mtime — spec Section 3.5 step 1.
  // A stat failure here is a fatal error (file may not exist for reading either).
  let fileStat: fs.Stats;
  try {
    fileStat = await fs.promises.stat(filePath);
  } catch (err) {
    // The file doesn't exist or isn't accessible. readFile will fail too; throw
    // with the canonical CompilerBridgeError format.
    const e = err as NodeJS.ErrnoException;
    throw new CompilerBridgeError(
      `Cannot read file: ${filePath}: ${e.message}`,
      filePath,
      err,
    );
  }

  const fileMtimeMs = Math.floor(fileStat.mtimeMs);

  // Step 1 continued: Stat tsconfig if provided.
  // ENOENT → tsConfigMtimeMs = 'none' (string), not a fatal error — spec Section 3.5 step 1.
  let tsConfigMtimeMs: number | 'none' = 'none';
  if (tsConfigPath) {
    try {
      const tsConfigStat = await fs.promises.stat(tsConfigPath);
      tsConfigMtimeMs = Math.floor(tsConfigStat.mtimeMs);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        tsConfigMtimeMs = 'none';
      } else {
        // Non-ENOENT stat failure — treat as 'none' to avoid blocking the pipeline.
        tsConfigMtimeMs = 'none';
      }
    }
  }

  // Step 2: Check cache — spec Section 3.5 step 2.
  const cacheKey: CacheKey = `${filePath}:${fileMtimeMs}:${tsConfigMtimeMs}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  // Step 3: Read the source file — spec Section 3.5 step 3.
  // Throws CompilerBridgeError on any filesystem failure.
  let sourceText: string;
  try {
    sourceText = await fs.promises.readFile(filePath, 'utf-8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new CompilerBridgeError(
      `Cannot read file: ${filePath}: ${e.message}`,
      filePath,
      err,
    );
  }

  // Step 4: Resolve compiler options from tsconfig — spec Section 3.5 step 4.
  const { options: compilerOptions, diagnostics: configDiagnostics } =
    resolveCompilerOptions(tsConfigPath);

  // Step 5: Transpile — spec Section 3.5 step 5.
  const transpileOutput = ts.transpileModule(sourceText, {
    compilerOptions,
    fileName: filePath,
    reportDiagnostics: true,
  });

  // Step 6: Convert diagnostics — spec Section 3.5 step 6.
  const tsDiagnostics = convertDiagnostics(
    transpileOutput.diagnostics ?? [],
    sourceText,
    filePath,
  );

  // Combine config-load warnings with transpiler diagnostics.
  const allDiagnostics: TSDiagnostic[] = [...configDiagnostics, ...tsDiagnostics];

  // Steps 7–8: Extract source map and strip the sourceMappingURL line — spec Sections 3.5–3.6.
  const { compiledJs, sourceMap } = await buildSourceMap(transpileOutput.outputText);

  // Step 8: Construct result, populate cache, return — spec Section 3.5 step 8.
  const result: CompilerBridgeResult = {
    compiledJs,
    sourceMap,
    diagnostics: allDiagnostics,
  };

  cache.set(cacheKey, result);

  return result;
}
