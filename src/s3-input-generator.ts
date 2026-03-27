/**
 * @file src/s3-input-generator.ts
 *
 * S3 — Input Generator
 *
 * Produces typed test inputs for every detected function at a fixed set of
 * input sizes. Queries the TypeScript type checker to populate each
 * FunctionBoundary's paramTypes, then generates deterministic InputSet[]
 * objects that scale collections appropriately to exercise algorithmic
 * complexity.
 *
 * Public API:
 *   generateInputs(functionBoundaries, sourceMap, filePath, inputSizes?, seed?)
 *     -> InputSet[]
 */

import ts from 'typescript';
import { FunctionBoundary, SourceMap, InputSet } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default input sizes (n values) at which each function is exercised. */
const DEFAULT_INPUT_SIZES: number[] = [10, 30, 100, 300, 1000, 3000, 10000];

/** Default PRNG seed. Fixed for deterministic, reproducible results. */
const DEFAULT_SEED = 42;

/**
 * Fixed mid-range value used for non-growth parameters when a growth parameter
 * exists. Equal to the 3rd element of the default input sizes.
 */
const FIXED_MID_RANGE = 100;

// ---------------------------------------------------------------------------
// PRNG — mulberry32
// ---------------------------------------------------------------------------

/**
 * Creates a seeded mulberry32 PRNG. Returns a closure that, on each call,
 * advances the 32-bit state and produces a pseudo-random float in [0, 1).
 *
 * @param seed - 32-bit unsigned integer seed.
 * @returns A stateful function that produces the next pseudo-random number.
 */
function createPRNG(seed: number): () => number {
  let state = seed >>> 0; // ensure 32-bit unsigned initial state
  return function nextRandom(): number {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Returns a pseudo-random integer in the range [min, max).
 *
 * @param prng - The PRNG instance.
 * @param min  - Inclusive lower bound.
 * @param max  - Exclusive upper bound.
 */
function randomInt(prng: () => number, min: number, max: number): number {
  return Math.floor(prng() * (max - min)) + min;
}

/**
 * Returns a single random ASCII printable character in the range [0x20, 0x7E].
 * (0x7F is the exclusive upper bound passed to randomInt.)
 *
 * @param prng - The PRNG instance.
 */
function randomChar(prng: () => number): string {
  return String.fromCharCode(randomInt(prng, 0x20, 0x7F));
}

// ---------------------------------------------------------------------------
// Union type resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a raw TS type string that may contain a union to a single effective
 * type string.
 *
 * Steps:
 *   1. Split on ' | '.
 *   2. Filter out 'null', 'undefined', 'void'.
 *   3. Return first remaining member, or 'unknown' if all were filtered.
 *
 * @param typeStr - Raw type string from the TypeScript type checker.
 * @returns The effective type string to use for value generation.
 */
function resolveUnionType(typeStr: string): string {
  if (!typeStr.includes(' | ')) {
    return typeStr;
  }
  const members = typeStr
    .split(' | ')
    .filter(m => m !== 'null' && m !== 'undefined' && m !== 'void');
  return members.length > 0 ? members[0] : 'unknown';
}

// ---------------------------------------------------------------------------
// Growth parameter selection
// ---------------------------------------------------------------------------

/**
 * Returns the 0-based index of the first collection-typed parameter, or -1 if
 * none exist.
 *
 * A type is considered a collection if it:
 *   - ends with '[]'
 *   - starts with 'Array<'
 *   - starts with 'Map<'
 *   - starts with 'Set<'
 *   - equals 'object'
 *   - starts with 'Record<'
 *   - equals 'unknown'
 *   - equals 'any'
 *
 * @param paramTypes - Array of TS type strings in parameter declaration order.
 * @returns Index of the growth parameter, or -1.
 */
function selectGrowthParam(paramTypes: string[]): number {
  for (let i = 0; i < paramTypes.length; i++) {
    const typeStr = paramTypes[i];
    if (
      typeStr.endsWith('[]') ||
      typeStr.startsWith('Array<') ||
      typeStr.startsWith('Map<') ||
      typeStr.startsWith('Set<') ||
      typeStr === 'object' ||
      typeStr.startsWith('Record<') ||
      typeStr === 'unknown' ||
      typeStr === 'any'
    ) {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Value generation
// ---------------------------------------------------------------------------

/**
 * Generates a single argument value for the given effective type and size.
 *
 * @param effectiveType - The resolved (post-union) TS type string.
 * @param size          - The effective input size for this parameter.
 * @param prng          - The PRNG instance (mutated in place).
 * @returns The generated value. Always JSON-serializable.
 */
function generateValue(
  effectiveType: string,
  size: number,
  prng: () => number
): unknown {
  if (effectiveType === 'number') {
    return size;
  }

  if (effectiveType === 'string') {
    const chars: string[] = [];
    for (let i = 0; i < size; i++) {
      chars.push(randomChar(prng));
    }
    return chars.join('');
  }

  if (effectiveType.endsWith('[]') || effectiveType.startsWith('Array<')) {
    const arr: number[] = [];
    for (let i = 0; i < size; i++) {
      arr.push(Math.floor(prng() * 1000));
    }
    return arr;
  }

  if (effectiveType.startsWith('Map<')) {
    const arr: [number, number][] = [];
    for (let i = 0; i < size; i++) {
      arr.push([i, 0]);
    }
    return arr;
  }

  if (effectiveType.startsWith('Set<')) {
    const arr: number[] = [];
    for (let i = 0; i < size; i++) {
      arr.push(i);
    }
    return arr;
  }

  if (effectiveType === 'object' || effectiveType.startsWith('Record<')) {
    const obj: Record<string, number> = {};
    for (let i = 0; i < size; i++) {
      obj['k' + String(i)] = 0;
    }
    return obj;
  }

  // Default: 'unknown', 'any', or any unrecognized type
  const arr: number[] = [];
  for (let i = 0; i < size; i++) {
    arr.push(Math.floor(prng() * 1000));
  }
  return arr;
}

// ---------------------------------------------------------------------------
// TypeScript type checker initialization
// ---------------------------------------------------------------------------

/**
 * Creates a TypeScript program and checker for the given .ts file.
 * Uses default compiler options { strict: true, target: ES2020 } — no
 * tsconfig.json lookup, as specified.
 *
 * @param filePath - Absolute path of the .ts source file being analyzed.
 * @returns An object containing the source file node and the type checker.
 *          Returns null if the source file cannot be obtained.
 */
function createCheckerForFile(
  filePath: string
): { sourceFile: ts.SourceFile; checker: ts.TypeChecker } | null {
  try {
    const compilerOptions: ts.CompilerOptions = {
      strict: true,
      target: ts.ScriptTarget.ES2020,
    };
    const program = ts.createProgram([filePath], compilerOptions);
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) {
      return null;
    }
    const checker = program.getTypeChecker();
    return { sourceFile, checker };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Type resolution (populates FunctionBoundary.paramTypes in-place)
// ---------------------------------------------------------------------------

/**
 * Finds the FunctionDeclaration AST node whose opening position matches
 * (tsLine, tsCol) in the given source file, and returns its parameter type
 * strings via the type checker.
 *
 * @param sourceFile - The TypeScript source file AST.
 * @param checker    - The TypeScript type checker.
 * @param tsLine     - 1-indexed TypeScript source line.
 * @param tsCol      - 0-indexed TypeScript source column.
 * @returns Array of type strings in parameter declaration order, or null if
 *          the node could not be found or an error occurred.
 */
function resolveParamTypes(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  tsLine: number,
  tsCol: number
): string[] | null {
  try {
    // TypeScript API uses 0-indexed lines; tsLine is 1-indexed per spec.
    const targetPos = ts.getPositionOfLineAndCharacter(
      sourceFile,
      tsLine - 1,
      tsCol
    );

    let result: string[] | null = null;

    function visitNode(node: ts.Node): void {
      if (result !== null) {
        return;
      }
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isMethodDeclaration(node)) &&
        node.getStart(sourceFile) === targetPos
      ) {
        result = node.parameters.map(param => {
          try {
            const type = checker.getTypeAtLocation(param);
            return checker.typeToString(type);
          } catch {
            return 'unknown';
          }
        });
        return;
      }
      ts.forEachChild(node, visitNode);
    }

    ts.forEachChild(sourceFile, visitNode);
    return result;
  } catch {
    return null;
  }
}

/**
 * Populates boundary.paramTypes in-place by querying the TypeScript type
 * checker. On any failure, leaves paramTypes as [] and continues.
 *
 * @param boundary   - The FunctionBoundary to enrich.
 * @param sourceFile - The TypeScript source file AST.
 * @param checker    - The TypeScript type checker.
 * @param sourceMap  - SourceMap for JS-to-TS coordinate translation.
 */
function populateParamTypes(
  boundary: FunctionBoundary,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  sourceMap: SourceMap
): void {
  try {
    const { tsLine, tsCol } = sourceMap.jsToTs(
      boundary.jsStartLine,
      boundary.jsStartCol
    );
    const types = resolveParamTypes(sourceFile, checker, tsLine, tsCol);
    if (types !== null) {
      boundary.paramTypes = types;
    }
    // If null, leave paramTypes as [] per spec §3.5 / §5.8
  } catch {
    // Leave paramTypes as [] on any unexpected error
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates typed test inputs for every detected function at a fixed set of
 * input sizes.
 *
 * Populates FunctionBoundary.paramTypes in-place via the TypeScript type
 * checker, then produces one InputSet per (functionId, n) pair.
 *
 * Never throws. Falls back to array-of-n-numbers if type resolution fails.
 *
 * @param functionBoundaries - Function metadata from S2 (paramTypes initially []).
 * @param sourceMap          - Source map from S1, for JS-to-TS coordinate mapping.
 * @param filePath           - Absolute path of the .ts source file.
 * @param inputSizes         - n values to generate inputs for. Default: [10,30,100,300,1000,3000,10000].
 * @param seed               - PRNG seed. Default: 42.
 * @returns One InputSet per (functionId, n) pair.
 */
export function generateInputs(
  functionBoundaries: FunctionBoundary[],
  sourceMap: SourceMap,
  filePath: string,
  inputSizes: number[] = DEFAULT_INPUT_SIZES,
  seed: number = DEFAULT_SEED
): InputSet[] {
  // Deduplicate and sort input sizes ascending (§3.9 / §5.4)
  const sizes = [...new Set(inputSizes)].sort((a, b) => a - b);

  if (sizes.length === 0) {
    return []; // §5.5
  }

  // One PRNG per generateInputs() call (§3.9)
  const prng = createPRNG(seed);

  // Initialize type checker once for this file
  const checkerContext = createCheckerForFile(filePath);

  // Populate paramTypes for all boundaries in array order (§3.9 step 3a)
  // Must be done before PRNG consumption begins
  if (checkerContext !== null) {
    const { sourceFile, checker } = checkerContext;
    for (const boundary of functionBoundaries) {
      populateParamTypes(boundary, sourceFile, checker, sourceMap);
    }
  }
  // If checkerContext is null, all paramTypes remain [] — fallback per §5.8

  const results: InputSet[] = [];

  // Outer loop: each boundary in array order (§3.9 step 3)
  for (const boundary of functionBoundaries) {
    const growthIndex = selectGrowthParam(boundary.paramTypes);

    // Middle loop: each n in sorted sizes (§3.9 step 3c)
    for (const n of sizes) {
      if (boundary.paramTypes.length === 0) {
        // §5.1 / §3.7 step 1
        results.push({ functionId: boundary.functionId, n, args: [] });
        continue;
      }

      const args: unknown[] = [];

      // Inner loop: each param in declaration order (§3.9 step 3c.i)
      for (let paramIdx = 0; paramIdx < boundary.paramTypes.length; paramIdx++) {
        const rawType = boundary.paramTypes[paramIdx];
        const effectiveType = resolveUnionType(rawType);

        // Determine effective size for this parameter
        const effectiveSize =
          growthIndex === -1 || paramIdx === growthIndex ? n : FIXED_MID_RANGE;

        args.push(generateValue(effectiveType, effectiveSize, prng));
      }

      results.push({ functionId: boundary.functionId, n, args });
    }
  }

  return results;
}
