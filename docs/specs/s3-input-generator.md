# S3 — Input Generator

> **Status**: APPROVED
> **Author**: architect
> **Created**: 2026-03-26
> **Priority**: MVP
> **Layer**: 3 (Core)

## 1. Overview

S3 produces typed test inputs for every detected function at a fixed set of input sizes. It receives `FunctionBoundary[]` from S2 (with `paramTypes` initially empty) and a `SourceMap` from S1, queries the TypeScript type checker to populate each function's `paramTypes`, then generates deterministic `InputSet[]` objects that scale collections in a way that exercises the function's algorithmic complexity. S3 is the bridge between static analysis (S1/S2) and runtime measurement (S4): if S3 produces inputs with wrong types or flat growth, every function will appear to be O(1) regardless of its actual complexity. Deterministic generation via a seeded PRNG ensures that the same source file always produces identical inputs, making complexity measurements reproducible across saves.

## 2. User Value

When the developer saves a `.ts` file, the extension must run each detected function at multiple input sizes to measure how operation counts scale. The quality of those measurements depends entirely on S3's inputs. If S3 generates an array of 10, 30, 100, ... 10000 numbers for a `bubbleSort(arr: number[])` function, S4 and S5 will observe quadratic growth and correctly label it `O(n^2)`. If S3 instead generates inputs of the wrong type (e.g., always a single number), the function either throws or runs in constant time, and the developer sees a misleading `O(1)` label — or worse, a `RUNTIME_ERROR`. S3's type awareness is what makes the complexity labels trustworthy.

From the developer's perspective, S3 is invisible. They never interact with it directly. But every correct `O(n^2)` annotation and every correct `O(n log n)` annotation depends on S3 having generated the right inputs at the right sizes.

## 3. Detailed Design

### 3.1 Public Interface

```typescript
export function generateInputs(
  functionBoundaries: FunctionBoundary[],   // from S2 (paramTypes initially empty)
  sourceMap:          SourceMap,            // from S1 (for TS type lookup)
  filePath:           string,              // absolute path of the .ts source file
  inputSizes?:        number[],            // default: [10, 30, 100, 300, 1000, 3000, 10000]
  seed?:              number               // default: 42
): InputSet[]
```

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `functionBoundaries` | `FunctionBoundary[]` | (required) | Function metadata from S2. `paramTypes` fields are empty (`[]`) on arrival; S3 populates them. |
| `sourceMap` | `SourceMap` | (required) | Source map from S1, used to map JS function positions back to TS source for type checker queries. |
| `filePath` | `string` | (required) | Absolute path of the `.ts` source file being analyzed. Passed to `ts.createProgram([filePath], compilerOptions)` to initialize the TypeScript type checker (see §3.5). Supplied by the orchestrator from the `onDidSaveTextDocument` event. |
| `inputSizes` | `number[]` | `[10, 30, 100, 300, 1000, 3000, 10000]` | Set of n values at which to generate inputs. Deduplicated internally. |
| `seed` | `number` | `42` | Seed for the deterministic PRNG. |

**Returns:** `InputSet[]` — one entry per `(functionId, n)` pair, where `n` iterates over the deduplicated `inputSizes` array. Total length = `functionBoundaries.length * deduplicatedInputSizes.length`.

**Preconditions:**
- `functionBoundaries` satisfies the `FunctionBoundary` interface from `interface-contracts`.
- `sourceMap` satisfies the `SourceMap` interface from `interface-contracts`.

**Postconditions:**
- Every returned `InputSet` satisfies the `InputSet` interface from `interface-contracts`.
- Every `InputSet.args` is JSON-serializable: `JSON.parse(JSON.stringify(args))` deep-equals `args`.
- The function never throws. If a function's type cannot be resolved, inputs fall back to array-of-n-numbers. S3 only generates JSON-serializable values; the TypeError path in InputSet construction (see `interface-contracts`) is unreachable from S3-generated data. If reached due to a future code change, the TypeError propagates as an exception.

### 3.2 Type-to-Input Mapping Table

For each function parameter, S3 determines the input value based on the TS type string in `FunctionBoundary.paramTypes`:

| TS Type String | Is Collection? | Generated Input | Growth Model |
|----------------|---------------|-----------------|--------------|
| `number` | No | `n` (the scalar value) | Linear scalar |
| `string` | No | Random ASCII printable string of length `n` (chars in range 0x20-0x7E; 0x7F exclusive, equivalent to [0x20, 0x7E] inclusive) | Length = n |
| `T[]` or `Array<T>` | Yes | Array of `n` pseudo-random integers in range `[0, 1000)` (i.e., `Math.floor(seededRandom() * 1000)`) | Size = n |
| `Map<K,V>` | Yes | Serialized as `[...entries]`: array of `n` 2-tuples `[i, 0]` for `i` in `0..n-1` | Size = n |
| `Set<T>` | Yes | Serialized as `[...values]`: array of `n` numbers `0..n-1` | Size = n |
| `object` or `Record<K,V>` | Yes | Object with `n` string keys `"k0"` through `"k{n-1}"`, each value `0` | Key count = n |
| `unknown` or `any` | Yes (fallback) | Array of `n` pseudo-random integers in range `[0, 1000)` | Size = n |
| Anything else (unrecognized) | Yes (fallback) | Array of `n` pseudo-random integers in range `[0, 1000)` | Size = n |

**JSON-serialization constraints for Map and Set:**

`Map` and `Set` are not JSON-serializable. S3 generates their serialized representations:
- `Map<K,V>` is generated as an `Array<[number, number]>` — an array of `[key, value]` pairs. The target function is expected to accept this representation. If the function actually expects a `Map` instance, S4 will encounter a runtime error, and S5 will classify the function as `RUNTIME_ERROR`.
- `Set<T>` is generated as a `number[]` — a plain array of unique values. Same caveat as Map.

This is a known limitation of v1: functions that require `Map` or `Set` instances as arguments will receive array-based representations. The complexity profiler is designed primarily for functions that accept arrays, numbers, strings, and plain objects.

**Important note on `target` values for search functions:**

Note: S3 does not inspect function names. The target-value behavior for numeric parameters follows automatically from the fixed mid-range rule in Section 3.3. The function-specific examples above illustrate the rule's effect, not name-based dispatch.

When a function has a `number[]` array parameter and a `number` target parameter (e.g., `linearScan(arr: number[], target: number)` or `binarySearch(arr: number[], target: number)`), the target value must be chosen to prevent degenerate early-exit behavior:

- **`linearScan.target`**: The `target` argument (the non-growth `number` parameter) is set to the fixed mid-range value of `100` (a scalar). Because the array elements are pseudo-random integers in `[0, 1000)`, a target of `100` will not generally be present in the array and the loop must scan all `n` elements. This ensures O(n) behavior is observed rather than O(1) early-exit. If `100` happens to appear in the array due to PRNG output, S4 may observe a slightly shorter scan at that particular `n`, but across the full input-size sweep the linear trend will dominate. A value guaranteed to be absent (e.g., `-1`) would be equally valid, but `100` is used because it is the fixed mid-range constant defined in this spec.

- **`binarySearch.target`**: The array must be sorted in ascending order before binary search is applied. S3 generates a pseudo-random `number[]` for the array argument; the target function is expected to handle sorting internally, or the caller must sort the input before passing it. The `target` (non-growth `number` parameter) is set to `100` (fixed mid-range scalar). To ensure the full `log n` iterations run, the target should ideally be a value near the end of the sorted range or absent from the array. Because the pseudo-random elements span `[0, 1000)` and the fixed target is `100`, the target is likely present in larger arrays (where many random values are generated) but absent in very small ones — this produces a valid growth curve. If a worst-case guarantee is required, the target function should explicitly search for `n + 1` (a value above all generated elements), but S3 uses the standard `100` scalar and relies on the growth curve fitter to observe the log-linear trend across all sizes.

### 3.3 Multi-Parameter Growth Rule

When a function has multiple parameters, only one dimension should grow with `n` to produce an unambiguous growth curve for the fitter. S3 selects the "growth parameter" as follows:

**Algorithm: `selectGrowthParam(paramTypes: string[])`**

```
Input: paramTypes — array of TS type strings, one per function parameter
Output: growthIndex — the 0-based index of the parameter that grows with n,
                      or -1 if no collection parameter exists

Variables:
  i: number — loop counter (0-based index into paramTypes)
  typeStr: string — the TS type string of the current parameter
  isCollection: boolean — whether typeStr matches a collection type

Steps:
  1. For i = 0 to paramTypes.length - 1:
     a. typeStr = paramTypes[i]
     b. isCollection = typeStr matches one of:
        - /\[\]$/ (ends with [])
        - /^Array</ (starts with Array<)
        - /^Map</ (starts with Map<)
        - /^Set</ (starts with Set<)
        - typeStr === 'object'
        - /^Record</ (starts with Record<)
        - typeStr === 'unknown'
        - typeStr === 'any'
     c. If isCollection is true:
        Return i
  2. Return -1  (no collection parameter found)
```

**Growth assignment rules:**

| Condition | Growth parameter | Non-growth parameters |
|-----------|-----------------|----------------------|
| `growthIndex >= 0` | Parameter at `growthIndex` uses the type mapping table with `n` as input size | All other parameters receive a fixed mid-range value (see below) |
| `growthIndex === -1` (no collection params) | All parameters use the type mapping table with `n` as input size | N/A — all params grow with n |

**Fixed mid-range values for non-growth parameters** (used when `growthIndex >= 0`):

| Non-growth param type | Fixed value |
|-----------------------|-------------|
| `number` | `100` (the 3rd element of the default inputSizes) |
| `string` | Random ASCII string of length `100` (generated from the PRNG) |
| `T[]` or `Array<T>` | Array of `100` pseudo-random integers in `[0, 1000)` |
| `Map<K,V>` | Array of `100` entry pairs |
| `Set<T>` | Array of `100` values |
| `object` or `Record<K,V>` | Object with `100` keys |
| `unknown`, `any`, unrecognized | Array of `100` random integers |

The value `100` is chosen because it is the 3rd input size in the default set — large enough to exercise non-trivial behavior in the non-growing parameter, small enough to avoid dominating runtime.

### 3.4 Deterministic PRNG

S3 uses the mulberry32 algorithm, a 32-bit PRNG with full-period guarantees and uniform distribution. It takes a single 32-bit seed and produces a stream of pseudo-random floating-point numbers in the range [0, 1).

**Mulberry32 pseudocode:**

```
Function: createPRNG(seed: number) -> () -> number

Variables:
  state: number — 32-bit unsigned integer, initialized to seed

Returns a closure that, when called, produces the next pseudo-random number:

  nextRandom():
    1. state = (state + 0x6D2B79F5) | 0          // unsigned 32-bit addition
    2. Let t: number = Math.imul(state ^ (state >>> 15), 1 | state)
    3. t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    4. Return ((t ^ (t >>> 14)) >>> 0) / 4294967296   // divide by 2^32
```

**Usage in S3:**

- One PRNG instance is created per `generateInputs()` call with the given `seed`.
- The PRNG is consumed in a deterministic order: for each function (in `functionBoundaries` array order), for each `n` (in `inputSizes` array order, after deduplication and sorting ascending), for each parameter (in `paramTypes` declaration order).
- `randomInt(min, max)`: `Math.floor(prng() * (max - min)) + min`
- `randomChar()`: `String.fromCharCode(randomInt(0x20, 0x7F))` — ASCII printable range

### 3.5 Type String Resolution

S3 must populate `FunctionBoundary.paramTypes` before generating inputs. The resolution algorithm:

```
Input: functionBoundary — a single FunctionBoundary with paramTypes: []
       sourceMap — SourceMap from S1

Variables:
  tsLine: number — the TypeScript source line of the function declaration
  tsCol:  number — the TypeScript source column of the function declaration

Steps:
  1. { tsLine, tsCol } = sourceMap.jsToTs(functionBoundary.jsStartLine, functionBoundary.jsStartCol)
     // Using the actual jsStartCol ensures accurate source mapping for non-column-0 functions
     // (e.g., inner or nested functions).
  2. Query the TypeScript type checker for the function at (tsLine, tsCol)
     in the original .ts source. Extract each parameter's type annotation
     as a string (e.g., 'number[]', 'string', 'Map<string, number>').
  3. If the type checker query fails (function not found at that position,
     or file has fatal syntax errors):
     - Set paramTypes = [] (leave empty)
     - The function will be treated as having no parameters
  4. If a parameter has no explicit type annotation and the type checker
     infers a type, use the inferred type string.
  5. If a parameter has no annotation and no inference is possible,
     use 'unknown' as the type string.
  6. Assign the resolved array of type strings to functionBoundary.paramTypes.
```

**Note on mutation:** S3 mutates the `FunctionBoundary` objects in-place to populate `paramTypes`. This is documented in `interface-contracts` — S2 emits boundaries with empty `paramTypes`, and S3 enriches them. The enriched boundaries are then available to downstream consumers (S5) without an additional data path.

### Type Checker Initialization

The TypeScript type checker is initialized as follows for each file analysis:

1. **Create a program** using `ts.createProgram([filePath], compilerOptions)`, where `filePath` is the `filePath` parameter passed to `generateInputs()` — the absolute path of the `.ts` file being analyzed.
2. **`compilerOptions`** defaults to `{ strict: true, target: ts.ScriptTarget.ES2020 }`. Call `ts.findConfigFile(path.dirname(filePath), ts.sys.fileExists, 'tsconfig.json')` to locate the nearest ancestor `tsconfig.json`. This function traverses parent directories until it finds a `tsconfig.json` or reaches the filesystem root, returning `undefined` if none is found. When found, load it with `ts.readConfigFile()` and merge its `compilerOptions` into the base compiler options.
3. **Obtain the checker** via `program.getTypeChecker()`.
4. **Fresh per file analysis**: A new `ts.Program` and checker instance is created on every call to the type resolution step. The checker is not cached across saves or across `generateInputs()` calls. This avoids stale type information when the source file changes between saves.

```typescript
// Canonical initialization pattern
const compilerOptions: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2020,
};
const program = ts.createProgram([filePath], compilerOptions);
const checker = program.getTypeChecker();
```

5. **Parameter type lookup**: To resolve a function's parameter types, traverse the program's source file AST to locate the `FunctionDeclaration` node at the position indicated by `(tsLine, tsCol)`. For each parameter node `paramNode` in that declaration, call `checker.getTypeAtLocation(paramNode)` to obtain the TypeScript `Type` object, then call `checker.typeToString(type)` to produce the canonical type string (e.g., `'number[]'`, `'string'`, `'Map<string, number>'`). Collect the resulting strings into the `paramTypes` array in parameter declaration order.

**Why no caching:** TypeScript programs are cheap to create for single-file analysis. Caching the checker across saves risks returning type information from a previous version of the file. The correctness cost of a stale checker outweighs the small performance gain from reuse.

### 3.6 Union Type Handling

When a `paramTypes` entry contains a union type (e.g., `'string | null'`, `'number[] | undefined'`), S3 resolves it as follows:

```
Input: typeStr — a TS type string that may contain '|'

Steps:
  1. Split typeStr on ' | ' (space-pipe-space).
  2. Filter out members that are exactly 'null', 'undefined', or 'void'.
  3. If the filtered list is non-empty, use the first remaining member
     as the effective type string.
  4. If the filtered list is empty (all members were null/undefined/void),
     use 'unknown' as the effective type string.
```

**Examples:**
- `'string | null'` resolves to `'string'`
- `'number[] | undefined'` resolves to `'number[]'`
- `'null | undefined'` resolves to `'unknown'` (fallback)
- `'Map<string, number> | Set<number>'` resolves to `'Map<string, number>'` (first non-null member)

### 3.7 InputSet Construction

For each `(functionBoundary, n)` pair, S3 constructs one `InputSet`:

```
Input: boundary — FunctionBoundary (with paramTypes populated)
       n        — current input size
       prng     — seeded PRNG instance
       growthIndex — result of selectGrowthParam(boundary.paramTypes)

Output: InputSet

Variables:
  args: unknown[] — the argument array to populate
  paramIdx: number — loop counter over parameters

Steps:
  1. If boundary.paramTypes is empty ([]):
     - Return { functionId: boundary.functionId, n: n, args: [] }

  2. args = []
  3. For paramIdx = 0 to boundary.paramTypes.length - 1:
     a. Let typeStr = boundary.paramTypes[paramIdx]
     b. Resolve union types (Section 3.6) to get effectiveType
     c. Determine the effective size for this parameter:
        - If growthIndex === -1 (no collection param): effectiveSize = n
        - If paramIdx === growthIndex: effectiveSize = n
        - Else: effectiveSize = 100 (fixed mid-range)
     d. Generate the value using effectiveType and effectiveSize (Section 3.8)
     e. args.push(generatedValue)

  4. Return { functionId: boundary.functionId, n: n, args: args }
```

### 3.8 Value Generation by Type

```
Function: generateValue(effectiveType: string, size: number, prng: () -> number) -> unknown

Variables:
  i: number — loop counter
  arr: number[] — temporary array for collection generation
  obj: Record<string, number> — temporary object
  chars: string[] — temporary array for string generation

Cases:
  'number':
    Return size (the scalar value directly)

  'string':
    chars = []
    For i = 0 to size - 1:
      chars.push(randomChar())  // Uses randomChar() from §3.4 — range [0x20, 0x7E] inclusive (0x7F is exclusive upper bound).
    Return chars.join('')

  effectiveType ends with '[]' OR starts with 'Array<':
    arr = []
    For i = 0 to size - 1:
      arr.push(Math.floor(prng() * 1000))
    Return arr

  effectiveType starts with 'Map<':
    arr = []
    For i = 0 to size - 1:
      arr.push([i, 0])
    Return arr  (array of [key, value] pairs)

  effectiveType starts with 'Set<':
    arr = []
    For i = 0 to size - 1:
      arr.push(i)
    Return arr  (array of unique values)

  effectiveType === 'object' OR starts with 'Record<':
    obj = {}
    For i = 0 to size - 1:
      obj['k' + String(i)] = 0
    Return obj

  default (including 'unknown', 'any', and any unrecognized type):
    arr = []
    For i = 0 to size - 1:
      arr.push(Math.floor(prng() * 1000))
    Return arr
```

**Note on inner types:** When the type is `T[]` or `Array<T>`, the inner type `T` is ignored. All array elements are filled with pseudo-random integers in `[0, 1000)`. This avoids recursive type resolution complexity for v1. The rationale: S4 counts operations, not correctness of results. As long as the function does not throw on the input type, the growth curve is valid.

### 3.9 PRNG Consumption Order (Determinism Contract)

To guarantee byte-identical results across calls, the PRNG must be consumed in this exact order:

```
1. Create PRNG with seed
2. Sort deduplicated inputSizes ascending
3. For each boundary in functionBoundaries (array order, index 0 first):
   a. Resolve paramTypes (no PRNG consumption — type checker is deterministic)
   b. Compute growthIndex = selectGrowthParam(boundary.paramTypes)
   c. For each n in sorted inputSizes:
      i.  For each param in boundary.paramTypes (declaration order, index 0 first):
          - Generate value (consumes PRNG calls in the order defined by Section 3.8)
      ii. Construct InputSet
4. Return all InputSets
```

This order is normative. Changing the iteration order changes the PRNG stream and breaks determinism.

Non-growth `string` parameters also consume PRNG calls: `effectiveSize = 100` random characters are drawn from the PRNG for each non-growth `string` parameter in each InputSet. These calls occur before the growth parameter PRNG calls within that InputSet.

## 4. Data Model & Logic

### 4.1 Type Dispatch Algorithm

The complete type dispatch for a single parameter value:

```
Function: resolveAndGenerate(rawType: string, size: number, prng: () -> number) -> unknown

Variables:
  effectiveType: string — the resolved type after union handling
  members: string[] — union members (if rawType contains ' | ')

Steps:
  1. If rawType contains ' | ':
     a. members = rawType.split(' | ')
     b. members = members.filter(m => m !== 'null' && m !== 'undefined' && m !== 'void')
     c. If members.length > 0: effectiveType = members[0]
     d. Else: effectiveType = 'unknown'
  2. Else: effectiveType = rawType

  3. Return generateValue(effectiveType, size, prng)   // Section 3.8
```

### 4.2 Growth Parameter Selection — Worked Example: bubbleSort

```
Input:
  FunctionBoundary: { functionId: 'aa11', name: 'bubbleSort', paramTypes: ['number[]'] }
  inputSizes: [10, 30, 100]
  seed: 42

Step 1: Create PRNG with seed=42
Step 2: Deduplicate and sort inputSizes: [10, 30, 100] (no change)
Step 3: Process boundary 'bubbleSort':
  a. paramTypes = ['number[]'] (already resolved)
  b. selectGrowthParam(['number[]']):
     - i=0: typeStr = 'number[]', matches /\[\]$/ -> isCollection = true
     - Return 0
     growthIndex = 0

  c. For n=10:
     - param 0 (number[], growthIndex=0): effectiveSize = 10
       generateValue('number[]', 10, prng):
         arr = [prng()*1000 floor, prng()*1000 floor, ... (10 times)]
         With seed=42 mulberry32: produces [764, 336, 484, 34, 510, 917, 246, 687, 567, 303]
     - InputSet: { functionId: 'aa11', n: 10, args: [[764, 336, 484, 34, 510, 917, 246, 687, 567, 303]] }

  c. For n=30:
     - param 0 (number[], growthIndex=0): effectiveSize = 30
       generateValue('number[]', 30, prng):
         arr = [30 pseudo-random integers from continued PRNG state]
     - InputSet: { functionId: 'aa11', n: 30, args: [[...30 numbers]] }

  c. For n=100:
     - param 0 (number[], growthIndex=0): effectiveSize = 100
       generateValue('number[]', 100, prng):
         arr = [100 pseudo-random integers from continued PRNG state]
     - InputSet: { functionId: 'aa11', n: 100, args: [[...100 numbers]] }

Output: 3 InputSets, one per n value.
Total PRNG calls: 10 + 30 + 100 = 140
```

### 4.3 Growth Parameter Selection — Worked Example: binarySearch (Mixed Params)

```
Input:
  FunctionBoundary: { functionId: 'bb22', name: 'binarySearch', paramTypes: ['number[]', 'number'] }
  inputSizes: [10, 30, 100]
  seed: 42

Step 1: Create PRNG with seed=42
Step 2: inputSizes sorted: [10, 30, 100]
Step 3: Process boundary 'binarySearch':
  a. paramTypes = ['number[]', 'number']
  b. selectGrowthParam(['number[]', 'number']):
     - i=0: typeStr = 'number[]', matches /\[\]$/ -> isCollection = true
     - Return 0
     growthIndex = 0

  c. For n=10:
     - param 0 (number[], growthIndex=0): effectiveSize = 10
       generateValue('number[]', 10, prng): [10 random ints from PRNG]
     - param 1 (number, NOT growthIndex): effectiveSize = 100 (fixed mid-range)
       generateValue('number', 100, prng): returns 100 (scalar, no PRNG consumed)
     - InputSet: { functionId: 'bb22', n: 10, args: [[...10 numbers], 100] }

  c. For n=30:
     - param 0: effectiveSize = 30 -> array of 30 random ints
     - param 1: effectiveSize = 100 -> returns 100
     - InputSet: { functionId: 'bb22', n: 30, args: [[...30 numbers], 100] }

  c. For n=100:
     - param 0: effectiveSize = 100 -> array of 100 random ints
     - param 1: effectiveSize = 100 -> returns 100
     - InputSet: { functionId: 'bb22', n: 100, args: [[...100 numbers], 100] }

Output: 3 InputSets.

Key observation: args[1] is always 100 (the fixed mid-range value for non-growth
number params), NOT n. This prevents cross-dimension growth confusion in S5.

PRNG calls per InputSet: 10, 30, 100 (only the array param consumes PRNG; 'number'
type returns the size directly without consuming PRNG).
```

### 4.4 No-Collection Example: All Scalars

```
Input:
  FunctionBoundary: { functionId: 'cc33', name: 'multiply', paramTypes: ['number', 'number'] }
  inputSizes: [10, 30, 100]
  seed: 42

Step 1: Create PRNG with seed=42
Step 2: inputSizes sorted: [10, 30, 100]
Step 3: Process boundary 'multiply':
  a. paramTypes = ['number', 'number']
  b. selectGrowthParam(['number', 'number']):
     - i=0: typeStr = 'number', not a collection
     - i=1: typeStr = 'number', not a collection
     - Return -1
     growthIndex = -1

  c. For n=10:
     - growthIndex === -1, so ALL params use effectiveSize = n
     - param 0 (number): generateValue('number', 10, prng) -> returns 10
     - param 1 (number): generateValue('number', 10, prng) -> returns 10
     - InputSet: { functionId: 'cc33', n: 10, args: [10, 10] }

  c. For n=30:
     - param 0: returns 30
     - param 1: returns 30
     - InputSet: { functionId: 'cc33', n: 30, args: [30, 30] }

  c. For n=100:
     - param 0: returns 100
     - param 1: returns 100
     - InputSet: { functionId: 'cc33', n: 100, args: [100, 100] }

Output: 3 InputSets.
PRNG calls: 0 (number type never consumes the PRNG).
```

## 5. Edge Cases & Error Handling

### 5.1 Function with No Parameters (`paramTypes: []`)

**Input condition:** A `FunctionBoundary` with `paramTypes: []` (e.g., `function getTimestamp(): number`).

**Behavior:** For every `n` in `inputSizes`, S3 produces `{ functionId, n, args: [] }`. The empty `args` array is valid — S4 will call the function with no arguments. The function is still measured at every input size for baseline O(1) classification.

**Output:** One `InputSet` per `n`, each with `args: []`.

**State after:** No error, no warning, no skipped entries.

### 5.2 Unrecognized Type String (e.g., `'MyClass'`, `'Foo<Bar>'`)

**Input condition:** A `paramTypes` entry that does not match any known type in the mapping table (Section 3.2).

**Behavior:** S3 falls back to the default case: generates an array of `n` (or `100` if non-growth) pseudo-random integers in range `[0, 1000)`. No error is thrown. No warning is logged. No diagnostic is emitted.

**Output:** The parameter's value in `args` is a `number[]` of the appropriate length.

**State after:** The `InputSet` is constructed normally. The function may throw at runtime (S4) if it cannot handle an array argument, resulting in `RUNTIME_ERROR` classification by S5.

### 5.3 Union Type (e.g., `'string | null'`)

**Input condition:** A `paramTypes` entry containing ` | ` (space-pipe-space).

**Behavior:** S3 splits on ` | `, filters out `'null'`, `'undefined'`, and `'void'`, and uses the first remaining member as the effective type. If all members are null/undefined/void, the effective type is `'unknown'` (falls back to array of random numbers).

**Examples:**
| Input type string | Effective type | Generated value |
|---|---|---|
| `'string \| null'` | `'string'` | Random ASCII string of length n |
| `'number[] \| undefined'` | `'number[]'` | Array of n random ints |
| `'null \| undefined'` | `'unknown'` | Array of n random ints |
| `'Map<string, number> \| Set<number>'` | `'Map<string, number>'` | Array of n entry pairs |

**State after:** Normal `InputSet` construction.

### 5.4 Duplicate Values in `inputSizes`

**Input condition:** `inputSizes` contains duplicate values, e.g., `[10, 30, 30, 100]`.

**Behavior:** S3 deduplicates using `[...new Set(inputSizes)]`, then sorts ascending. The example becomes `[10, 30, 100]`. Each unique `n` appears exactly once in the output `InputSet[]` per function.

**Output:** `functionBoundaries.length * 3` InputSets (not 4).

**State after:** Normal operation.

### 5.5 Empty `inputSizes`

**Input condition:** `inputSizes` is `[]` (empty array) or `undefined`.

**Behavior:**
- If `undefined`: uses the default `[10, 30, 100, 300, 1000, 3000, 10000]`.
- If `[]` (empty array): returns `[]` (no InputSets generated for any function). No error thrown.

**Output:** `[]`.

**State after:** No InputSets exist. S4 receives nothing and produces no measurements. S5 classifies all functions as `INSUFFICIENT_DATA`.

### 5.6 Inner Type of `T[]` is Complex

**Input condition:** `paramTypes` contains `'{ name: string; age: number }[]'` or `'Foo[]'` or `'(number | string)[]'`.

**Behavior:** S3 detects the trailing `[]` and generates an array of `n` elements filled with pseudo-random integers in `[0, 1000)` (i.e., `Math.floor(prng() * 1000)`). The inner type `T` is not parsed, not recursed into, and not used.

**Output:** `args` contains a `number[]` of length `n` with pseudo-random integers in `[0, 1000)`.

**State after:** Normal. If the function expects objects in the array, it will throw at runtime.

### 5.7 `n = 0` in `inputSizes`

**Input condition:** `inputSizes` contains `0`.

**Behavior:** S3 generates `InputSet` entries with `n: 0` and empty collections:
- `number[]` / `Array<T>`: `[]` (empty array)
- `Map<K,V>`: `[]` (empty entries array)
- `Set<T>`: `[]` (empty values array)
- `object` / `Record<K,V>`: `{}` (empty object)
- `number`: `0` (the scalar value)
- `string`: `''` (empty string)
- `unknown` / fallback: `[]` (empty array)

**Output:** One `InputSet` per function with `n: 0` and appropriately empty `args`.

**State after:** Normal. S4 will execute the function with empty inputs and record opCount. S5 uses this as the smallest data point.

### 5.8 Type Checker Query Fails

**Input condition:** The TS type checker cannot resolve the function at the mapped position (e.g., the source map returned a fallback position, or the `.ts` file has fatal syntax errors).

**Behavior:** S3 leaves `paramTypes` as `[]` (empty). The function is treated as having no parameters. For every `n`, S3 produces `{ args: [] }`.

**Output:** InputSets with empty args, one per `n`.

**State after:** No error thrown. The function will likely be classified O(1) or `INSUFFICIENT_DATA` by S5 depending on whether it runs successfully with no arguments.

## 6. Dependencies

### Upstream (S3 depends on):

| Component | What S3 consumes | Interface |
|-----------|------------------|-----------|
| **s1-compiler-bridge** | `sourceMap: SourceMap` — used to map JS function positions back to TS source positions for type checker queries | `CompilerBridgeResult.sourceMap` |
| **s2-ast-instrumenter** | `functionBoundaries: FunctionBoundary[]` — the list of detected functions with empty `paramTypes`, which S3 enriches | `InstrumentResult.functionBoundaries` |
| **interface-contracts** | `FunctionBoundary`, `InputSet`, `SourceMap` type definitions | Type imports only |
| **orchestrator** | `filePath: string` — the absolute path of the `.ts` source file, passed directly to `generateInputs()`. The orchestrator obtains this path from the VS Code `onDidSaveTextDocument` event (`document.fileName`). S3 does not derive the path from any other source. | Direct parameter |

### Downstream (components that depend on S3):

| Component | What it consumes from S3 | Interface |
|-----------|--------------------------|-----------|
| **s4-runtime-executor** | `InputSet[]` — the generated inputs at each size, passed to the worker for execution | `InputSet[]` array |
| **s5-complexity-analyzer** | (indirect) S5 does not directly consume S3's output, but it reads the enriched `FunctionBoundary.paramTypes` that S3 populated on the shared boundary objects | Mutated `FunctionBoundary[]` from S2, enriched by S3 |

### External Dependencies:

| Library | Version Constraint | Purpose |
|---------|-------------------|---------|
| **typescript** | `^5.0.0` | TypeScript Compiler API — `ts.createProgram()`, `ts.TypeChecker`, `checker.getTypeAtLocation()`. Used to resolve parameter types from the original `.ts` source. S3 needs the type checker, not just transpilation. |

**Self-contained:**
- The PRNG (mulberry32) is implemented inline — no external PRNG library is needed.

### Bidirectional Reference Status:

- S1 spec (Section 6 Downstream) lists S3 as a consumer of `sourceMap`. **Verified.**
- S2 spec (Section 6 Downstream) lists S3 as a consumer of `functionBoundaries`. **Verified.**
- S4 spec is not yet written. When written, S4 must list S3 (`InputSet[]`) as an upstream dependency.

## 7. Configuration

| Key | Type | Default | Valid Range | Effect |
|-----|------|---------|-------------|--------|
| `tsComplexity.inputSizes` | `number[]` | `[10, 30, 100, 300, 1000, 3000, 10000]` | Each element >= 0, integer. Array length >= 1. | Determines the set of `n` values at which functions are tested. Smaller sets run faster but may reduce curve-fitting accuracy. Larger values increase runtime linearly. |

**Not user-configurable (and why):**

| Setting | Fixed Value | Rationale |
|---------|-------------|-----------|
| PRNG seed | `42` | A user-configurable seed would make results non-reproducible across machines, teams, and CI environments. If developer A uses seed 42 and developer B uses seed 7, they see different complexity labels for the same file. Fixed seed ensures deterministic, reproducible results everywhere. |
| PRNG algorithm | mulberry32 | Changing the PRNG algorithm changes the stream for the same seed, breaking reproducibility. Fixed for the lifetime of v1. |
| Fixed mid-range value | `100` | This is the 3rd element of the default input sizes. It could theoretically be derived from the actual `inputSizes` config, but fixing it at 100 avoids the scenario where a user changes `inputSizes` and gets different non-growth parameter values, making measurements config-dependent in a non-obvious way. |
| Type-to-input mapping | Table in Section 3.2 | The mapping is a design contract, not a tunable. Changing it would alter all complexity measurements and require re-validating the entire pipeline. |

## 8. Acceptance Criteria

### Functional Criteria

- [ ] **AC-1: One InputSet per (functionId, n) pair.** Given 3 function boundaries and `inputSizes = [10, 30, 100]`, `generateInputs()` returns exactly 9 `InputSet` objects. Given 5 boundaries and the default 7 input sizes, it returns exactly 35 `InputSet` objects. Total count = `functionBoundaries.length * deduplicated inputSizes.length`.

- [ ] **AC-2: JSON serializability.** For every `InputSet` `s` in the returned array, `JSON.parse(JSON.stringify(s.args))` deep-equals `s.args`. Verified by running the assertion on all returned InputSets.

- [ ] **AC-3: Array length matches n.** For a function with `paramTypes: ['number[]']` and `inputSizes: [10, 100, 1000]`, the returned InputSets have `args[0].length === 10`, `args[0].length === 100`, and `args[0].length === 1000` respectively.

- [ ] **AC-4: Multi-param fixed value.** For a function with `paramTypes: ['number[]', 'number']`, in every returned `InputSet`, `args[1]` is `100` (fixed mid-range) and `args[0].length === n` (grows with input size).

- [ ] **AC-5: Determinism.** Calling `generateInputs(boundaries, sourceMap, [10, 30, 100], 42)` twice with identical `functionBoundaries` and `sourceMap` produces byte-identical results: `JSON.stringify(result1) === JSON.stringify(result2)`.

- [ ] **AC-6: No-param function.** For a function with `paramTypes: []`, every returned `InputSet` has `args` equal to `[]` (empty array). One `InputSet` is produced for each `n` in the input sizes. No error is thrown.

- [ ] **AC-7: Unrecognized type fallback.** For a function with `paramTypes: ['MyCustomClass']`, the generated `args[0]` is a `number[]` of length `n` (falls back to array of random integers). No error is thrown, no exception is caught by the caller.

- [ ] **AC-8: Interface conformance.** Every returned `InputSet` object has exactly three properties: `functionId` (string), `n` (number), and `args` (unknown[]). Each `functionId` matches a `functionId` in the input `functionBoundaries`. Each `n` matches a value in the deduplicated `inputSizes`.

- [ ] **AC-9: Total count invariant.** The total number of returned `InputSet` objects equals `functionBoundaries.length * [...new Set(inputSizes)].length`. If `inputSizes` is `[10, 10, 30]`, the deduplicated count is 2, so `functionBoundaries.length * 2` InputSets are returned.

### Edge Case Criteria

- [ ] **AC-10: Empty inputSizes.** Given `inputSizes = []`, `generateInputs()` returns `[]` (empty array, no error).

- [ ] **AC-11: n=0 in inputSizes.** Given `inputSizes = [0, 10]` and a function with `paramTypes: ['number[]']`, the InputSet for `n=0` has `args[0]` equal to `[]` (empty array).

- [ ] **AC-12: Union type resolution.** For a function with `paramTypes: ['string | null']`, the generated `args[0]` is a string of length `n` (not null, not an array).

### Performance Criteria

- [ ] **AC-13: Generation speed.** For 20 functions with 7 input sizes each (140 InputSets), `generateInputs()` completes in < 200ms wall-clock time. The largest generated array has 10000 elements.

- [ ] **AC-14: Memory bound.** The total memory footprint of the returned `InputSet[]` does not exceed 100 MB for 20 functions with the default input sizes. (The largest single array is 10000 numbers at 8 bytes each = 80 KB; 20 functions * 7 sizes * ~80 KB = ~11.2 MB for the max-size arrays, well under the bound.)

- [ ] **AC-15 (type-checker resolution)**: Given a real TypeScript source file containing `function search(arr: number[], target: number): number { ... }`, calling `generateInputs(boundaries, sourceMap, filePath)` with boundaries derived from that file produces `InputSet[]` where each InputSet's `args` array has length 2, `args[0]` is an array of numbers (type `number[]`), and `args[1]` is a number. Verified by running a real `ts.createProgram()` against the file.
