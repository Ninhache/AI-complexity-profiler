# S2 — AST Instrumenter

> **Status**: APPROVED
> **Author**: architect
> **Created**: 2026-03-26
> **Priority**: MVP
> **Layer**: 2 (Core)

## 1. Overview

S2 is the instrumentation engine at the center of the complexity profiler pipeline. It receives compiled JavaScript (a plain string) from S1, parses it into an Abstract Syntax Tree using Acorn, walks every node to inject `__op()` counter calls at semantically meaningful points (loop bodies, function entries, recursive call sites), then regenerates syntactically valid JavaScript via escodegen. Its three outputs — the instrumented source, a registry mapping node IDs to AST metadata, and a list of detected function boundaries — feed S3, S4, and S5 respectively. S2 is the most algorithmically critical subsystem: an off-by-one in injection placement corrupts every downstream measurement.

## 2. User Value

When S2 works correctly, the developer's TypeScript functions are transparently instrumented so that every loop iteration and every recursive call is counted. The developer never sees S2's output directly — they see the complexity annotations that S4 and S5 produce from it. But if S2 injects counters at the wrong locations, misses a loop, or double-counts a recursion, the complexity label on the function will be wrong (e.g., `O(n)` shown for an `O(n^2)` function), and the developer will either ignore a real performance problem or waste time investigating a false alarm. S2's correctness is what makes the entire extension trustworthy.

## 3. Detailed Design

### 3.1 Public Interface

```typescript
export function instrumentCode(compiledJs: string): InstrumentResult
```

**Parameters:**
- `compiledJs` (`string`): JavaScript source code produced by S1's `ts.transpileModule()`. Must be valid ES2020 JavaScript. S2 does not receive or depend on any other S1 output — no source map, no diagnostics.

**Returns:** `InstrumentResult`

The `InstrumentResult` type is defined in `interface-contracts` and imported from there. See §4 of `interface-contracts.md` for the full field documentation.

**Preconditions:**
- `compiledJs` is syntactically valid JavaScript parseable by Acorn with `ecmaVersion: 2020`.
- If `compiledJs` is `""` (empty string — produced by S1 on fatal syntax error), S2 returns an `InstrumentResult` with the two-statement preamble as `instrumentedJs`, an empty `nodeRegistry`, and an empty `functionBoundaries` array. No error is thrown.

**Postconditions:**
- `instrumentedJs` is syntactically valid JavaScript parseable by Acorn.
- Every loop body in the original code has exactly one `__op()` call as its first statement.
- Every non-generator function has exactly one `__op()` call as its first statement (or, for expression-body arrows, wrapped via the comma operator).
- Recursive `CallExpression` nodes are wrapped in `(__op('id'), originalCall(...))`.
- `nodeRegistry` contains one entry per injected `__op()` call.
- `functionBoundaries` contains one entry per non-generator function, with `paramTypes` set to `[]`.
- Generator functions (`function*`) are absent from `functionBoundaries` and have zero injected `__op()` calls.

### 3.2 Instrumentation Preamble

Two declarations are injected as the first two statements of the output file, before any user code:

```javascript
const __counters = new Map();
const __op = (id) => __counters.set(id, (__counters.get(id) || 0) + 1);
```

These declarations must appear verbatim. They are not configurable.

### 3.3 Counter Injection Points

| AST Node Type | Injection Location | Mechanism |
|---------------|-------------------|-----------|
| `ForStatement` | First statement of the loop body block | Prepend `__op('nodeId')` as an `ExpressionStatement` at index 0 of `body.body` |
| `WhileStatement` | First statement of the loop body block | Prepend `__op('nodeId')` as an `ExpressionStatement` at index 0 of `body.body` |
| `DoWhileStatement` | First statement of the loop body block | Prepend `__op('nodeId')` as an `ExpressionStatement` at index 0 of `body.body` |
| `ForInStatement` | First statement of the loop body block | Prepend `__op('nodeId')` as an `ExpressionStatement` at index 0 of `body.body` |
| `ForOfStatement` | First statement of the loop body block | Prepend `__op('nodeId')` as an `ExpressionStatement` at index 0 of `body.body` |
| `FunctionDeclaration` (non-generator) | First statement of function body | Prepend `__op('nodeId')` as an `ExpressionStatement` at index 0 of `body.body` |
| `FunctionExpression` (non-generator) | First statement of function body | Prepend `__op('nodeId')` as an `ExpressionStatement` at index 0 of `body.body` |
| `ArrowFunctionExpression` with block body | First statement of function body | Prepend `__op('nodeId')` as an `ExpressionStatement` at index 0 of `body.body` |
| `ArrowFunctionExpression` with expression body | Wrap the expression body | Replace `body` with `SequenceExpression([__op('nodeId'), originalBody])` |
| `CallExpression` (recursive only) | At the call site | Replace the `CallExpression` node with `SequenceExpression([__op('nodeId'), originalCallExpression])` |

**Firm exclusion:** `MemberExpression` bracket access (`arr[i]`) is NOT instrumented. Loop and recursion counters already capture growth; bracket instrumentation adds noise.

### 3.4 Loop Body Without Braces

If a loop's `body` property is not a `BlockStatement` (i.e., the loop body is a single statement without braces), S2 wraps it in a `BlockStatement` before injecting the counter:

**Before transformation:**
```javascript
for (let i = 0; i < n; i++) stmt;
```

**After transformation (AST-level):**
```javascript
for (let i = 0; i < n; i++) { __op('nodeId'); stmt; }
```

The loop node's `body` property is replaced with a new `BlockStatement` node whose `body` array is `[__op_call_statement, original_statement]`.

### 3.5 Recursive Call Detection Algorithm

A `CallExpression` is classified as recursive if and only if:

1. The `callee` property is an `Identifier` node (not a `MemberExpression` or other complex expression), AND
2. One of the following holds:
   - **(a)** The `CallExpression` is inside a `FunctionDeclaration` whose `id.name` equals `callee.name`, OR
   - **(b)** The `CallExpression` is inside an `ArrowFunctionExpression` that is the `init` of a `VariableDeclarator` whose `id.name` equals `callee.name`.

   - **(c)** The `CallExpression` is inside a `FunctionExpression` that is the `init` of a `VariableDeclarator` whose `id.name` equals `callee.name`.

**Implementation approach:** During the AST walk, maintain a stack variable `enclosingFunctionNames` (type: `string[]`). When entering a `FunctionDeclaration` with a non-null `id`, push `id.name`. When entering a `VariableDeclarator` whose `init` is an `ArrowFunctionExpression`, push `id.name`. When entering a `VariableDeclarator` whose `init` is a `FunctionExpression` (e.g., `const f = function f(n) { return f(n-1); }`), push `id.name`. Pop when leaving the corresponding node. A `CallExpression` is recursive if `callee.type === 'Identifier'` and `enclosingFunctionNames.includes(callee.name)`.

Non-recursive `CallExpression` nodes receive no instrumentation.

### 3.6 Generator Function Handling

When the AST walker encounters a `FunctionDeclaration` or `FunctionExpression` with `generator === true`, it skips the node entirely:
- No `__op()` call is injected into the function body
- No entry is added to `functionBoundaries`
- Loops inside the generator function are also NOT instrumented (the entire subtree is skipped)
- Nothing is logged

## 4. Data Model & Logic

### 4.1 Node ID Hashing Algorithm

**Purpose:** Generate a deterministic, short identifier for each instrumented AST node.

**Variables:**
- `jsLine` (`number`, 1-indexed): The line number of the AST node's `start` position as reported by Acorn's `loc.start.line`
- `jsCol` (`number`, 0-indexed): The column number of the AST node's `start` position as reported by Acorn's `loc.start.column`
- `input` (`string`): The concatenation `"${jsLine}:${jsCol}"`
- `hash` (`string`): The SHA-256 hex digest of `input`
- `nodeId` (`string`): The first 8 characters of `hash`

**Pseudocode:**
```
function generateNodeId(jsLine: number, jsCol: number): string {
  input = `${jsLine}:${jsCol}`
  hash  = crypto.createHash('sha256').update(input).digest('hex')
  return hash.slice(0, 8)
}
```

**Determinism guarantee:** Same `(jsLine, jsCol)` pair always produces the same `nodeId` across all runs, all platforms, all Node.js versions. This follows from SHA-256 being a deterministic function and `crypto.createHash` being part of the Node.js standard library.

**Collision assumption:** Acorn guarantees that no two AST nodes share the same `(line, col)` start position. Therefore, no two `nodeId` values within a single file will collide. This assumption holds because each token in the source occupies at least one character, so no two node start positions can coincide.

### 4.2 NodeMeta Structure

Each entry in `nodeRegistry` is keyed by `nodeId` and maps to:

```typescript
interface NodeMeta {
  nodeId: string;   // 8-char hex hash (same as the map key)
  jsLine: number;   // 1-indexed line of the AST node in the compiled JS
  jsCol:  number;   // 0-indexed column of the AST node in the compiled JS
  tsLine: number;   // placeholder — S2 sets this equal to jsLine
  tsCol:  number;   // placeholder — S2 sets this equal to jsCol
  type:   AstNodeType;   // Acorn node type; member of the AstNodeType closed union
}
```

**Note on `tsLine`/`tsCol`:** S2 does not have access to the source map (that is S1's output, consumed by S5). S2 sets `tsLine = jsLine` and `tsCol = jsCol` as placeholders. The pipeline orchestrator or S5 is responsible for remapping these to TypeScript positions using the source map.

### 4.3 FunctionBoundary Structure (S2 output)

For each non-generator function detected in the AST, S2 emits:

```typescript
{
  functionId:  string,   // sha256(jsStartLine:jsStartCol)
  name:        string,   // declared name or '<anonymous>_L{jsStartLine}'
  jsStartLine: number,   // 1-indexed start line of the function body in compiled JS
  jsStartCol:  number,   // 0-indexed column of the function's opening token (node.loc.start.column)
  jsEndLine:   number,   // 1-indexed line of the function body in compiled JS
  paramTypes:  string[], // empty [] initially; populated by S3
}
```

**Naming rules:**
- `FunctionDeclaration` with `id`: use `id.name` (e.g., `"bubbleSort"`)
- `ArrowFunctionExpression` assigned to a `VariableDeclarator`: use `declarator.id.name` (e.g., `"factorial"`)
- `FunctionExpression` assigned to a `VariableDeclarator`: use `declarator.id.name`
- All other cases (IIFE, callback argument, unassigned expression): use `"<anonymous>_L{jsStartLine}"` where `jsStartLine` is the 1-indexed line of the function node's start position

**Why `paramTypes` is empty:** S2 operates on compiled JavaScript, which has no type annotations. TypeScript type information is only available through the TS type checker API, which S3 accesses. S2's contract is to identify function boundaries geometrically (start line, end line, name); S3's contract is to fill in the type semantics.

### 4.4 AST Walk Algorithm

**Algorithm:** Depth-first, pre-order traversal of the Acorn AST.

**Variables:**
- `ast` (`acorn.Node`): The root AST node returned by `acorn.parse()`
- `enclosingFunctionNames` (`string[]`): Stack tracking the names of enclosing functions for recursive call detection. Initially empty.
- `insideGenerator` (`boolean`): Flag set to `true` when inside a generator function subtree. Initially `false`.
- `nodeRegistry` (`Map<string, NodeMeta>`): Accumulator for node metadata. Initially empty.
- `functionBoundaries` (`FunctionBoundary[]`): Accumulator for function entries. Initially empty.
- `parentMap` (`Map<Node, Node>`): Maps each AST node to its parent, built during traversal. Used to find `VariableDeclarator` parents of arrow functions.

**Walk pseudocode:**

```
function walk(node, parent):
  parentMap.set(node, parent)

  // Skip generator function subtrees entirely
  if node.type in ['FunctionDeclaration', 'FunctionExpression'] AND node.generator:
    return  // do not recurse into children

  // Track enclosing function names
  pushedName = null
  if node.type == 'FunctionDeclaration' AND node.id:
    push node.id.name onto enclosingFunctionNames
    pushedName = node.id.name
  elif node.type == 'VariableDeclarator' AND node.init?.type == 'ArrowFunctionExpression':
    push node.id.name onto enclosingFunctionNames
    pushedName = node.id.name
  elif node.type == 'VariableDeclarator' AND node.init?.type == 'FunctionExpression':
    push node.id.name onto enclosingFunctionNames
    pushedName = node.id.name

  // Instrument function entries (non-generator)
  if node.type == 'FunctionDeclaration' AND NOT node.generator:
    nodeId = generateNodeId(node.loc.start.line, node.loc.start.column)
    inject __op(nodeId) as first statement of node.body.body
    register nodeId in nodeRegistry with type 'FunctionDeclaration'
    add FunctionBoundary entry

  elif node.type == 'ArrowFunctionExpression':
    nodeId = generateNodeId(node.loc.start.line, node.loc.start.column)
    if node.body.type == 'BlockStatement':
      inject __op(nodeId) as first statement of node.body.body
    else:
      replace node.body with SequenceExpression([__op(nodeId), node.body])
    register nodeId in nodeRegistry with type 'ArrowFunctionExpression'
    add FunctionBoundary entry (resolve name from parent VariableDeclarator if present)

  elif node.type == 'FunctionExpression' AND NOT node.generator:
    nodeId = generateNodeId(node.loc.start.line, node.loc.start.column)
    inject __op(nodeId) as first statement of node.body.body
    register nodeId in nodeRegistry with type 'FunctionExpression'
    add FunctionBoundary entry (resolve name from parent VariableDeclarator if present, else anonymous)

  // Instrument loop bodies
  elif node.type in ['ForStatement', 'WhileStatement', 'DoWhileStatement', 'ForInStatement', 'ForOfStatement']:
    nodeId = generateNodeId(node.loc.start.line, node.loc.start.column)
    if node.body.type != 'BlockStatement':
      wrap node.body in a new BlockStatement
    inject __op(nodeId) as first statement of node.body.body
    register nodeId in nodeRegistry with type node.type

  // Instrument recursive calls
  elif node.type == 'CallExpression':
    if node.callee.type == 'Identifier' AND enclosingFunctionNames.includes(node.callee.name):
      nodeId = generateNodeId(node.loc.start.line, node.loc.start.column)
      replace node with SequenceExpression([__op(nodeId), node])
      register nodeId in nodeRegistry with type 'CallExpression'

  // Recurse into child nodes
  for each child property of node:
    if child is an AST node: walk(child, node)
    if child is an array of AST nodes: for each element: walk(element, node)

  // Pop function name stack
  if pushedName is not null:
    pop enclosingFunctionNames
```

### 4.5 Worked Example: bubbleSort

**Input JS** (received from S1):
```javascript
function bubbleSort(arr) {
  for (let i = 0; i < arr.length; i++) {
    for (let j = 0; j < arr.length - 1; j++) {
      if (arr[j] > arr[j + 1]) {
        let tmp = arr[j]; arr[j] = arr[j+1]; arr[j+1] = tmp;
      }
    }
  }
}
```

**Step-by-step instrumentation:**

1. **Parse:** Acorn parses the input with `{ ecmaVersion: 2020, locations: true }`. The root `Program` node is returned.

2. **Preamble injection:** The two `__counters` and `__op` declarations are prepended to `Program.body`.

3. **Walk encounters `FunctionDeclaration` "bubbleSort" at line 1, col 0:**
   - `nodeId = sha256("1:0").slice(0,8)` — produces `"aa11bb22"` (illustrative)
   - Prepend `__op('aa11bb22')` to `bubbleSort`'s body
   - Push `"bubbleSort"` onto `enclosingFunctionNames`
   - Add to `nodeRegistry`: `'aa11bb22' -> { nodeId: 'aa11bb22', jsLine: 1, jsCol: 0, tsLine: 1, tsCol: 0, type: 'FunctionDeclaration' }`
   - Add to `functionBoundaries`: `{ functionId: 'aa11bb22', name: 'bubbleSort', jsStartLine: 1, jsStartCol: 0, jsEndLine: 10, paramTypes: [] }`

4. **Walk encounters outer `ForStatement` at line 2, col 2:**
   - `nodeId = sha256("2:2").slice(0,8)` — produces `"cc33dd44"` (illustrative)
   - Loop body is already a `BlockStatement` — no wrapping needed
   - Prepend `__op('cc33dd44')` to the loop body
   - Add to `nodeRegistry`: `'cc33dd44' -> { nodeId: 'cc33dd44', jsLine: 2, jsCol: 2, tsLine: 2, tsCol: 2, type: 'ForStatement' }`

5. **Walk encounters inner `ForStatement` at line 3, col 4:**
   - `nodeId = sha256("3:4").slice(0,8)` — produces `"ee55ff66"` (illustrative)
   - Loop body is already a `BlockStatement` — no wrapping needed
   - Prepend `__op('ee55ff66')` to the loop body
   - Add to `nodeRegistry`: `'ee55ff66' -> { nodeId: 'ee55ff66', jsLine: 3, jsCol: 4, tsLine: 3, tsCol: 4, type: 'ForStatement' }`

6. **No `CallExpression` with callee `"bubbleSort"` found inside the function.** No recursive instrumentation.

7. **Pop `"bubbleSort"` from `enclosingFunctionNames`.** Walk complete.

8. **escodegen regeneration** produces the final instrumented output:

```javascript
const __counters = new Map();
const __op = (id) => __counters.set(id, (__counters.get(id) || 0) + 1);
function bubbleSort(arr) {
  __op('aa11bb22');
  for (let i = 0; i < arr.length; i++) {
    __op('cc33dd44');
    for (let j = 0; j < arr.length - 1; j++) {
      __op('ee55ff66');
      if (arr[j] > arr[j + 1]) {
        let tmp = arr[j]; arr[j] = arr[j+1]; arr[j+1] = tmp;
      }
    }
  }
}
```

**Final nodeRegistry:**
| nodeId | jsLine | jsCol | tsLine | tsCol | type |
|--------|--------|-------|--------|-------|------|
| `aa11bb22` | 1 | 0 | 1 | 0 | `FunctionDeclaration` |
| `cc33dd44` | 2 | 2 | 2 | 2 | `ForStatement` |
| `ee55ff66` | 3 | 4 | 3 | 4 | `ForStatement` |

**Final functionBoundaries:**
```
[{ functionId: 'aa11bb22', name: 'bubbleSort', jsStartLine: 1, jsStartCol: 0, jsEndLine: 10, paramTypes: [] }]
```

### 4.6 Worked Example: Recursive Factorial (Arrow Function)

**Input JS:**
```javascript
const factorial = (n) => n <= 1 ? 1 : n * factorial(n - 1);
```

**Step-by-step instrumentation:**

1. **Parse:** Acorn parses. The `VariableDeclarator` has `id.name = "factorial"` and `init` is an `ArrowFunctionExpression`.

2. **Walk encounters `VariableDeclarator` with arrow init:**
   - Push `"factorial"` onto `enclosingFunctionNames`.

3. **Walk encounters `ArrowFunctionExpression` at line 1, col 20 (illustrative position of the opening parenthesis):**
   - `nodeId = sha256("1:20").slice(0,8)` — produces `"ff001122"` (illustrative)
   - Body is an expression (conditional), not a `BlockStatement`
   - Replace body with: `SequenceExpression([__op('ff001122'), originalConditionalExpression])`
   - Add to `nodeRegistry`: `'ff001122' -> { nodeId: 'ff001122', jsLine: 1, jsCol: 20, tsLine: 1, tsCol: 20, type: 'ArrowFunctionExpression' }`
   - Add to `functionBoundaries`: `{ functionId: 'ff001122', name: 'factorial', jsStartLine: 1, jsStartCol: 20, jsEndLine: 1, paramTypes: [] }`

4. **Walk encounters `CallExpression` with callee `Identifier("factorial")` at line 1, col 44 (illustrative):**
   - `enclosingFunctionNames` contains `"factorial"` — this is a recursive call
   - `nodeId = sha256("1:44").slice(0,8)` — produces `"ff334455"` (illustrative)
   - Replace `CallExpression` with `SequenceExpression([__op('ff334455'), originalCallExpression])`
   - Add to `nodeRegistry`: `'ff334455' -> { nodeId: 'ff334455', jsLine: 1, jsCol: 44, tsLine: 1, tsCol: 44, type: 'CallExpression' }`

5. **Pop `"factorial"` from `enclosingFunctionNames`.** Walk complete.

**Instrumented output:**
```javascript
const __counters = new Map();
const __op = (id) => __counters.set(id, (__counters.get(id) || 0) + 1);
const factorial = (n) => (__op('ff001122'), n <= 1 ? 1 : n * (__op('ff334455'), factorial(n - 1)));
```

## 5. Edge Cases & Error Handling

### 5.1 Empty Function Body

**Input condition:** A `FunctionDeclaration` (or block-body arrow) with an empty body — `function foo() {}`.

**Behavior:** `__op('nodeId')` is injected as the sole statement, producing `function foo() { __op('nodeId'); }`.

**nodeRegistry:** One entry for the function.

**functionBoundaries:** One entry: `{ functionId: nodeId, name: 'foo', jsStartLine: L, jsEndLine: L, paramTypes: [] }`.

### 5.2 Loop with Unbraced Body

**Input condition:** A loop whose `body` is a single statement, not a `BlockStatement`. Example: `for (let i = 0; i < n; i++) console.log(i);`

**Behavior:** S2 wraps the body in a `BlockStatement`, then prepends the `__op()` call. Result:
```javascript
for (let i = 0; i < n; i++) {
  __op('nodeId');
  console.log(i);
}
```

**State after:** The AST has been mutated — the loop's `body` is now a `BlockStatement`. This mutation is permanent in the AST but does not affect the original input string.

### 5.3 Async Function with Await

**Input condition:** An `async function` containing `await` expressions.

**Behavior:** S2 instruments the function entry and any loops inside it using the standard rules. `await` expressions are AST nodes of type `AwaitExpression` — they are not in the injection point table and are left untouched. The `async` keyword on the function is preserved by escodegen.

**Example:**
```javascript
// Input
async function fetchAll(urls) {
  for (const url of urls) {
    await fetch(url);
  }
}

// Output
async function fetchAll(urls) {
  __op('aabbccdd');
  for (const url of urls) {
    __op('eeff0011');
    await fetch(url);
  }
}
```

### 5.4 Generator Function

**Input condition:** A `function*` declaration or expression (node has `generator === true`).

**Behavior:** S2 skips the entire subtree. No `__op()` calls are injected anywhere inside the generator (not in its body, not in loops within it). No entry is added to `functionBoundaries`. No entry is added to `nodeRegistry` for any node inside the generator. Nothing is logged.

**Rationale:** Generator functions have yield-based control flow that makes operation counting semantically ambiguous. Deferred to v1.1.

### 5.5 IIFE (Immediately Invoked Function Expression)

**Input condition:** A `FunctionExpression` that is the callee of a `CallExpression` — e.g., `(function() { ... })()`.

**Behavior:** S2 treats this as a `FunctionExpression` with no `VariableDeclarator` parent. The function entry `__op()` call is injected. The function is added to `functionBoundaries` with name `"<anonymous>_L{jsStartLine}"`.

**Example:**
```javascript
// Input
(function() { console.log('hello'); })();

// Output (assuming function starts at line 1, col 1)
(function() { __op('nodeId'); console.log('hello'); })();
```

**functionBoundaries entry:** `{ functionId: 'nodeId', name: '<anonymous>_L1', jsStartLine: 1, jsEndLine: 1, paramTypes: [] }`

### 5.6 Empty compiledJs Input

**Input condition:** `compiledJs` is `""` (an empty string). This occurs when S1 encounters a fatal syntax error and cannot produce any JavaScript output.

**Behavior:** Acorn parses `""` successfully and returns a `Program` with an empty `body`. S2 proceeds normally: the two preamble statements are injected, the walk finds no nodes, and `escodegen.generate()` produces the preamble-only output. No error is thrown.

**Result:**
- `instrumentedJs`: `"const __counters = new Map();\nconst __op = (id) => __counters.set(id, (__counters.get(id) || 0) + 1);\n"` (the two preamble statements only)
- `nodeRegistry`: empty `Map`
- `functionBoundaries`: `[]`

**State after:** The `InstrumentResult` is valid. S3 receives an empty `functionBoundaries` array and produces no `InputSet`s. The pipeline terminates gracefully with no complexity annotations.

### 5.7 Acorn Parse Failure

**Input condition:** `compiledJs` is not valid JavaScript parseable by Acorn with `ecmaVersion: 2020`.

**Behavior:** `acorn.parse()` throws a `SyntaxError`. S2 catches it and throws a new `Error` with the message:

```
S2: Failed to parse compiled JS: {acorn_error.message}
```

where `{acorn_error.message}` is the verbatim `message` property of the `SyntaxError` thrown by Acorn.

**State after:** No `InstrumentResult` is returned. No partial state is exposed. The pipeline caller receives the thrown `Error` and is responsible for aborting the S2 stage.

**escodegen is NOT called.** The function returns nothing (throws before reaching code generation).

### 5.8 escodegen Failure

**Input condition:** The mutated AST, after injection, causes `escodegen.generate()` to throw.

**Behavior:** S2 catches the error and throws a new `Error` with the message:

```
S2: Failed to regenerate JS: {escodegen_error.message}
```

where `{escodegen_error.message}` is the verbatim `message` property of the error thrown by escodegen.

**State after:** No `InstrumentResult` is returned. The `nodeRegistry` and `functionBoundaries` accumulated during the walk are discarded. The pipeline caller receives the thrown `Error`.

### 5.9 Node ID Hash Collision

**Input condition:** Two AST nodes have the same `(jsLine, jsCol)` start position.

**Why this cannot happen:** Acorn assigns each AST node a start position corresponding to its first token. No two tokens in valid JavaScript can begin at the same `(line, column)` position. This is guaranteed by the lexer: each token consumes at least one character.

**Documented assumption:** S2 assumes Acorn produces unique `(line, col)` for every node start. If this assumption is violated (e.g., due to an Acorn bug), the second node's `nodeRegistry` entry would silently overwrite the first. No runtime check is performed — this is a documented invariant, not a handled error case.

### 5.10 Arrow Function with Expression Body

**Input condition:** `const f = (n) => n * 2` — an arrow whose body is an expression, not a block.

**Behavior:** The expression body is wrapped via the comma operator:
```javascript
const f = (n) => (__op('nodeId'), n * 2);
```

The `ArrowFunctionExpression` node's `body` property is replaced with a `SequenceExpression` whose `expressions` array is `[__op_call, original_expression]`.

**functionBoundaries entry:** `{ functionId: 'nodeId', name: 'f', jsStartLine: 1, jsEndLine: 1, paramTypes: [] }`

### 5.11 Nested Arrow in Expression Body

**Input condition:** `const f = (n) => (m) => n + m` — a curried arrow function where both levels have expression bodies.

**Behavior:** Both arrow functions are instrumented independently:
```javascript
const f = (n) => (__op('outerNodeId'), (m) => (__op('innerNodeId'), n + m));
```

**functionBoundaries:** Two entries — `f` (outer, named via `VariableDeclarator`) and `<anonymous>_L{line}` (inner, no `VariableDeclarator` parent).

### 5.12 FunctionExpression Assigned to Variable

**Input condition:** `const add = function(a, b) { return a + b; };`

**Behavior:** The `FunctionExpression` is instrumented at entry. The name is resolved from the parent `VariableDeclarator`:
```javascript
const add = function(a, b) { __op('nodeId'); return a + b; };
```

**functionBoundaries entry:** `{ functionId: 'nodeId', name: 'add', jsStartLine: 1, jsEndLine: 1, paramTypes: [] }`

## 6. Dependencies

### Upstream (S2 depends on):

- **s1-compiler-bridge**: S2 receives `compiledJs` (a `string`) as its sole input. S2 does NOT receive or use S1's `sourceMap` or `diagnostics`. The only contract is: S1 produces valid ES2020 JavaScript, and S2 parses it.
- **interface-contracts**: S2 imports `FunctionBoundary`, `NodeMeta`, `AstNodeType`, and `InstrumentResult`. `InstrumentResult` is defined in `interface-contracts` — S2 does not define it locally.

### Downstream (components that depend on S2):

- **s3-input-generator**: Consumes `functionBoundaries` to know which functions exist, their names, and their line ranges. S3 then fills in `paramTypes` using the TS type checker.
- **s4-runtime-executor**: Consumes `instrumentedJs` to run in the worker thread. S4 also needs the `__counters` map exposed by the preamble to extract measurements.
- **s5-complexity-analyzer**: Consumes `nodeRegistry` to attribute high op counts back to specific AST nodes (which loop or recursive call is the dominant contributor).

### External Dependencies:

- **acorn** (`^8.0.0`): ES2020-compliant JavaScript parser. Used to parse `compiledJs` into an AST. Chosen for its small size, speed, and lack of plugin system (simplicity). Acorn must be called with `{ ecmaVersion: 2020, locations: true }` to produce location data on every node.
- **escodegen** (`^2.0.0`): AST-to-JavaScript code generator. Used to regenerate JavaScript from the mutated AST after counter injection. No special options required beyond default formatting.
- **crypto** (Node.js built-in, `node:crypto`): Used for `createHash('sha256')` in the node ID generation algorithm. No external cryptographic library needed.

## 7. Configuration

S2 has no user-configurable settings.

**Rationale:** The injection point list (which AST node types receive `__op()` calls) is fixed by design. Making instrumentation configurable would mean:
1. **Non-reproducible results**: Two developers analyzing the same file with different instrumentation settings would get different complexity classifications, making the tool untrustworthy for team use.
2. **Harder debugging**: If a complexity result is wrong, the first question becomes "what instrumentation settings were active?" rather than "is the algorithm correct?"
3. **Downstream coupling**: S4 and S5 assume a fixed set of counter semantics. If S2's injection points change, S5's curve fitting models would need to be recalibrated.

The only way to change instrumentation behavior is to modify the S2 source code and rebuild the extension.

| Setting | Value | Rationale |
|---------|-------|-----------|
| Acorn ecmaVersion | `2020` | Matches `ts.transpileModule()` output target. Fixed, not configurable. |
| Acorn locations | `true` | Required for node ID generation. Fixed. |
| Hash algorithm | `sha256` | Standard, deterministic, available in all Node.js versions. Fixed. |
| Hash truncation length | `8` hex characters | 4 bytes = 4.3 billion unique IDs. Sufficient for any single-file scope. Fixed. |

## 8. Acceptance Criteria

### Functional Criteria

- [ ] **AC-1: Loop instrumentation completeness.** Given a JavaScript string containing one `ForStatement`, one `WhileStatement`, one `DoWhileStatement`, one `ForInStatement`, and one `ForOfStatement`, when `instrumentCode()` is called, then the returned `instrumentedJs` contains exactly 5 `__op()` calls inside loop bodies (one per loop), each as the first statement of the loop's `BlockStatement` body. Verified by re-parsing `instrumentedJs` with Acorn and checking that each loop body's first statement is an `ExpressionStatement` calling `__op`.

- [ ] **AC-2: Instrumented output is syntactically valid.** Given any syntactically valid ES2020 JavaScript string as input, when `instrumentCode()` is called, then `acorn.parse(instrumentedJs, { ecmaVersion: 2020 })` succeeds without throwing a `SyntaxError`.

- [ ] **AC-3: nodeRegistry correctness.** Given a JavaScript string with a `ForStatement` starting at line 5, column 4, when `instrumentCode()` is called, then `nodeRegistry` contains an entry whose `nodeId` equals `crypto.createHash('sha256').update('5:4').digest('hex').slice(0, 8)`, with `jsLine === 5`, `jsCol === 4`, and `type === 'ForStatement'`.

- [ ] **AC-4: Function entry instrumentation.** Given a JavaScript string containing a `FunctionDeclaration` named `"myFunc"` with no loops and no recursive calls, when `instrumentCode()` is called, then `functionBoundaries` contains exactly one entry with `name === 'myFunc'`, and `nodeRegistry` contains one entry for the function's `__op()` call, and `instrumentedJs` contains `__op('nodeId')` as the first statement of `myFunc`'s body.

- [ ] **AC-5: Async function preservation.** Given a JavaScript string `async function fetchData(urls) { for (const url of urls) { await fetch(url); } }`, when `instrumentCode()` is called, then `instrumentedJs` contains the `await fetch(url)` expression intact, the function has an entry `__op()` call, the `ForOfStatement` has a loop body `__op()` call, and `acorn.parse(instrumentedJs, { ecmaVersion: 2020 })` succeeds.

- [ ] **AC-6: Generator function exclusion.** Given a JavaScript string containing `function* gen() { for (let i = 0; i < 10; i++) { yield i; } }`, when `instrumentCode()` is called, then `functionBoundaries` contains zero entries, `nodeRegistry` contains zero entries, and `instrumentedJs` does not contain any `__op()` calls within the generator body.

- [ ] **AC-7: paramTypes is always empty.** Given any valid JavaScript input, when `instrumentCode()` is called, then every entry in `functionBoundaries` has `paramTypes` equal to `[]` (an empty array). No entry ever has a non-empty `paramTypes`.

- [ ] **AC-8: Recursive call detection.** Given a JavaScript string `function factorial(n) { return n <= 1 ? 1 : n * factorial(n - 1); }`, when `instrumentCode()` is called, then `instrumentedJs` contains exactly two `__op()` calls inside or wrapping `factorial`: one for the function entry and one wrapping the recursive `factorial(n - 1)` call as a `SequenceExpression`. Non-recursive calls to other functions (e.g., `console.log(n)`) within the same body receive no `__op()` wrapping.

### Error Handling Criteria

- [ ] **AC-9: Acorn parse failure.** Given an invalid JavaScript string `"function {{{invalid"`, when `instrumentCode()` is called, then it throws an `Error` whose `message` starts with `"S2: Failed to parse compiled JS: "` followed by Acorn's syntax error text. No `InstrumentResult` is returned.

- [ ] **AC-10: escodegen failure.** Given that `escodegen.generate()` throws an error (simulated via a deliberately corrupted AST node), when `instrumentCode()` reaches the code generation step, then it throws an `Error` whose `message` starts with `"S2: Failed to regenerate JS: "` followed by escodegen's error text. No `InstrumentResult` is returned.

### Performance Criteria

- [ ] **AC-11: Instrumentation speed.** Given a syntactically valid JavaScript string of 500 lines containing 10 functions with nested loops, when `instrumentCode()` is called, then it returns in less than 100ms (target) and always in less than 300ms (hard limit). Measured as wall-clock time from function entry to return, averaged over 10 consecutive calls on a machine with a 2GHz+ CPU and 4GB+ RAM. The 100ms target is the median; the 300ms hard limit is the p100 (no single call exceeds it).

### Structural Criteria

- [ ] **AC-12: Preamble injection.** Given any valid JavaScript input, when `instrumentCode()` is called, then the first two statements of the returned `instrumentedJs` (after parsing with Acorn) are: (1) a `VariableDeclaration` declaring `__counters` initialized to `new Map()`, and (2) a `VariableDeclaration` declaring `__op` initialized to an arrow function. These appear before any user code.

- [ ] **AC-13: Unbraced loop body wrapping.** Given JavaScript `for (let i = 0; i < 10; i++) console.log(i);`, when `instrumentCode()` is called, then the `ForStatement`'s body in `instrumentedJs` is a `BlockStatement` containing `__op('nodeId')` as the first statement followed by `console.log(i)`.

- [ ] **AC-14: Arrow expression body wrapping.** Given JavaScript `const double = (n) => n * 2;`, when `instrumentCode()` is called, then the arrow function's body in `instrumentedJs` is a `SequenceExpression` with two expressions: `__op('nodeId')` and `n * 2`.

- [ ] **AC-15: Anonymous function naming.** Given JavaScript `(function() { return 42; })();` where the `FunctionExpression` starts at line 1, when `instrumentCode()` is called, then `functionBoundaries` contains one entry with `name === '<anonymous>_L1'`.
