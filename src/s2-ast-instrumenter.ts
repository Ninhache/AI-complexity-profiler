/**
 * @file src/s2-ast-instrumenter.ts
 *
 * S2 — AST Instrumenter
 *
 * Receives compiled JavaScript from S1, parses it with Acorn, injects __op()
 * counter calls at loop bodies, function entries, and recursive call sites,
 * then regenerates syntactically valid JavaScript via escodegen.
 *
 * Public API:
 *   export function instrumentCode(compiledJs: string): InstrumentResult
 *
 * See docs/specs/s2-ast-instrumenter.md for the full specification.
 */

import * as acorn from 'acorn';
import * as escodegen from 'escodegen';
import * as crypto from 'crypto';
import { InstrumentResult, FunctionBoundary, NodeMeta, AstNodeType } from './types';

// ---------------------------------------------------------------------------
// Preamble — prepended verbatim to every instrumented output (§3.2)
// ---------------------------------------------------------------------------

// `var` is intentional: these must leak out of S4's eval() call so the worker
// can access __counters.clear() and __counters.values() in the outer scope.
// `const`/`let` are block-scoped to eval() and would cause ReferenceError.
const PREAMBLE = `var __counters = new Map();\nvar __op = (id) => __counters.set(id, (__counters.get(id) || 0) + 1);`;

// ---------------------------------------------------------------------------
// Node ID generation (§4.1)
// ---------------------------------------------------------------------------

/**
 * Generates a deterministic 8-character hex node identifier.
 *
 * @param jsLine - 1-indexed line number of the AST node in the compiled JS.
 * @param jsCol  - 0-indexed column number of the AST node in the compiled JS.
 * @returns An 8-character lowercase hex string.
 */
function generateNodeId(jsLine: number, jsCol: number): string {
  const input = `${jsLine}:${jsCol}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------------------
// AST node construction helpers (§3.3)
// ---------------------------------------------------------------------------

/**
 * Builds the CallExpression AST node for __op('nodeId').
 *
 * @param nodeId - The 8-character hex node identifier to pass as argument.
 * @returns A plain ESTree CallExpression object.
 */
function makeOpCallExpr(nodeId: string): any {
  return {
    type: 'CallExpression',
    callee: { type: 'Identifier', name: '__op' },
    arguments: [{ type: 'Literal', value: nodeId, raw: `'${nodeId}'` }],
  };
}

/**
 * Builds an ExpressionStatement wrapping __op('nodeId').
 *
 * @param nodeId - The 8-character hex node identifier.
 * @returns A plain ESTree ExpressionStatement object.
 */
function makeOpStatement(nodeId: string): any {
  return {
    type: 'ExpressionStatement',
    expression: makeOpCallExpr(nodeId),
  };
}

/**
 * Builds a SequenceExpression of the form (__op('nodeId'), originalExpr).
 *
 * @param nodeId       - The 8-character hex node identifier.
 * @param originalExpr - The original expression node to execute after the counter.
 * @returns A plain ESTree SequenceExpression object.
 */
function makeSequenceExpr(nodeId: string, originalExpr: any): any {
  return {
    type: 'SequenceExpression',
    expressions: [makeOpCallExpr(nodeId), originalExpr],
  };
}

// ---------------------------------------------------------------------------
// Parent map construction
// ---------------------------------------------------------------------------

/**
 * Builds a Map from every AST node to its parent node and the property key
 * (or array index) through which the parent holds a reference to the child.
 * This allows in-place replacement of child nodes during the walk.
 *
 * @param root - The root Program node from acorn.parse().
 * @returns A Map<childNode, { parent, key, index? }> covering all nodes.
 */
function buildParentMap(root: any): Map<any, { parent: any; key: string; index?: number }> {
  const map = new Map<any, { parent: any; key: string; index?: number }>();

  function visit(node: any, parent: any, key: string, index?: number): void {
    if (node === null || typeof node !== 'object') {
      return;
    }
    if (typeof node.type === 'string') {
      // It's an AST node — record its parent reference
      map.set(node, { parent, key, index });
    }
    // Recurse through all properties
    for (const prop of Object.keys(node)) {
      if (prop === 'type' || prop === 'loc' || prop === 'start' || prop === 'end') {
        continue;
      }
      const child = node[prop];
      if (Array.isArray(child)) {
        for (let i = 0; i < child.length; i++) {
          visit(child[i], node, prop, i);
        }
      } else if (child !== null && typeof child === 'object' && typeof child.type === 'string') {
        visit(child, node, prop);
      }
    }
  }

  // The root Program has no parent; we record a sentinel
  map.set(root, { parent: null, key: '', index: undefined });
  for (const prop of Object.keys(root)) {
    if (prop === 'type' || prop === 'loc' || prop === 'start' || prop === 'end') {
      continue;
    }
    const child = root[prop];
    if (Array.isArray(child)) {
      for (let i = 0; i < child.length; i++) {
        visit(child[i], root, prop, i);
      }
    } else if (child !== null && typeof child === 'object' && typeof child.type === 'string') {
      visit(child, root, prop);
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Preamble AST nodes
// ---------------------------------------------------------------------------

/**
 * Parses the preamble string into two ready-to-inject AST statement nodes.
 * Parsing once avoids re-parsing on every call to instrumentCode.
 */
function buildPreambleNodes(): any[] {
  const ast = acorn.parse(PREAMBLE, { ecmaVersion: 2020, locations: false }) as any;
  return ast.body as any[];
}

// ---------------------------------------------------------------------------
// Main walk (§4.4)
// ---------------------------------------------------------------------------

/** Internal state threaded through the recursive walk. */
interface WalkState {
  parentMap: Map<any, { parent: any; key: string; index?: number }>;
  enclosingFunctionNames: string[];
  nodeRegistry: Map<string, NodeMeta>;
  functionBoundaries: FunctionBoundary[];
}

/**
 * Registers a NodeMeta entry and returns the generated nodeId.
 *
 * @param state   - Shared walk state.
 * @param node    - The AST node being instrumented.
 * @param astType - The AstNodeType classification for this node.
 * @returns The 8-character nodeId.
 */
function registerNode(state: WalkState, node: any, astType: AstNodeType): string {
  const jsLine: number = node.loc.start.line;
  const jsCol: number = node.loc.start.column;
  const nodeId = generateNodeId(jsLine, jsCol);
  const meta: NodeMeta = {
    nodeId,
    jsLine,
    jsCol,
    tsLine: jsLine,   // placeholder — S5 remaps via source map
    tsCol: jsCol,     // placeholder
    type: astType,
  };
  state.nodeRegistry.set(nodeId, meta);
  return nodeId;
}

/**
 * Determines the human-readable name for a function node (§4.3 naming rules).
 *
 * @param node      - FunctionDeclaration, FunctionExpression, or ArrowFunctionExpression.
 * @param parentMap - Map from node to its parent reference info.
 * @returns The resolved name string.
 */
function resolveFunctionName(
  node: any,
  parentMap: Map<any, { parent: any; key: string; index?: number }>
): string {
  // Named FunctionDeclaration
  if (node.type === 'FunctionDeclaration' && node.id) {
    return node.id.name as string;
  }

  // Arrow or FunctionExpression — look for VariableDeclarator parent
  const parentInfo = parentMap.get(node);
  if (parentInfo && parentInfo.parent && parentInfo.parent.type === 'VariableDeclarator') {
    const declarator = parentInfo.parent;
    if (declarator.id && declarator.id.type === 'Identifier') {
      return declarator.id.name as string;
    }
  }

  // All other cases — anonymous
  const jsStartLine: number = node.loc.start.line;
  return `<anonymous>_L${jsStartLine}`;
}

/**
 * Replaces a child node reference in its parent with a new node.
 * Uses the parentMap to locate the exact property and optional array index.
 *
 * @param parentMap - The parent reference map built before walking.
 * @param oldNode   - The node to replace.
 * @param newNode   - The replacement node.
 */
function replaceNode(
  parentMap: Map<any, { parent: any; key: string; index?: number }>,
  oldNode: any,
  newNode: any
): void {
  const info = parentMap.get(oldNode);
  if (!info || info.parent === null) {
    // Cannot replace the root node — should not occur in practice
    return;
  }
  const { parent, key, index } = info;
  if (index !== undefined) {
    parent[key][index] = newNode;
  } else {
    parent[key] = newNode;
  }
}

/**
 * Depth-first pre-order walk of the Acorn AST. Mutates the AST in-place by
 * injecting __op() instrumentation at the points defined in §3.3.
 *
 * @param node  - Current AST node being visited.
 * @param state - Shared mutable state (registries, function name stack).
 */
function walk(node: any, state: WalkState): void {
  if (node === null || typeof node !== 'object' || typeof node.type !== 'string') {
    return;
  }

  // --- §3.6 Generator exclusion: skip entire subtree ---
  if (
    (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') &&
    node.generator === true
  ) {
    return;
  }

  // --- §3.5 Recursive call detection: push enclosing function name ---
  let pushedName: string | null = null;
  if (node.type === 'FunctionDeclaration' && node.id) {
    pushedName = node.id.name as string;
    state.enclosingFunctionNames.push(pushedName);
  } else if (node.type === 'VariableDeclarator' && node.init) {
    const initType = node.init.type;
    if (
      (initType === 'ArrowFunctionExpression' || initType === 'FunctionExpression') &&
      node.id &&
      node.id.type === 'Identifier'
    ) {
      pushedName = node.id.name as string;
      state.enclosingFunctionNames.push(pushedName);
    }
  }

  // --- §3.3 Injection points ---

  if (node.type === 'FunctionDeclaration') {
    // Non-generator guaranteed above (generator case returned early)
    const nodeId = registerNode(state, node, 'FunctionDeclaration');
    node.body.body.unshift(makeOpStatement(nodeId));

    const jsStartLine: number = node.loc.start.line;
    const jsStartCol: number = node.loc.start.column;
    const jsEndLine: number = node.loc.end.line;
    const name = resolveFunctionName(node, state.parentMap);
    state.functionBoundaries.push({
      functionId: nodeId,
      name,
      jsStartLine,
      jsStartCol,
      jsEndLine,
      paramTypes: [],
    });

  } else if (node.type === 'ArrowFunctionExpression') {
    const nodeId = registerNode(state, node, 'ArrowFunctionExpression');

    if (node.body.type === 'BlockStatement') {
      node.body.body.unshift(makeOpStatement(nodeId));
    } else {
      // Expression body — wrap via SequenceExpression (§3.3, §5.10)
      const originalBody = node.body;
      node.body = makeSequenceExpr(nodeId, originalBody);
      // Update parentMap for the original body's new container
      // (the original body children will still recurse correctly since
      //  we descend into node.body's expressions below)
    }

    const jsStartLine: number = node.loc.start.line;
    const jsStartCol: number = node.loc.start.column;
    const jsEndLine: number = node.loc.end.line;
    const name = resolveFunctionName(node, state.parentMap);
    state.functionBoundaries.push({
      functionId: nodeId,
      name,
      jsStartLine,
      jsStartCol,
      jsEndLine,
      paramTypes: [],
    });

  } else if (node.type === 'FunctionExpression') {
    // Non-generator guaranteed above
    const nodeId = registerNode(state, node, 'FunctionExpression');
    node.body.body.unshift(makeOpStatement(nodeId));

    const jsStartLine: number = node.loc.start.line;
    const jsStartCol: number = node.loc.start.column;
    const jsEndLine: number = node.loc.end.line;
    const name = resolveFunctionName(node, state.parentMap);
    state.functionBoundaries.push({
      functionId: nodeId,
      name,
      jsStartLine,
      jsStartCol,
      jsEndLine,
      paramTypes: [],
    });

  } else if (
    node.type === 'ForStatement' ||
    node.type === 'WhileStatement' ||
    node.type === 'DoWhileStatement' ||
    node.type === 'ForInStatement' ||
    node.type === 'ForOfStatement'
  ) {
    const astType = node.type as AstNodeType;
    const nodeId = registerNode(state, node, astType);

    // §3.4 Wrap unbraced body in a BlockStatement before injecting
    if (node.body.type !== 'BlockStatement') {
      const originalBody = node.body;
      node.body = {
        type: 'BlockStatement',
        body: [originalBody],
      };
    }
    node.body.body.unshift(makeOpStatement(nodeId));

  } else if (node.type === 'CallExpression') {
    // §3.5 Recursive call detection
    if (
      node.callee.type === 'Identifier' &&
      state.enclosingFunctionNames.includes(node.callee.name as string)
    ) {
      const nodeId = registerNode(state, node, 'CallExpression');
      // Replace this CallExpression with SequenceExpression([__op, call]) in its parent
      const sequenceNode = makeSequenceExpr(nodeId, node);
      replaceNode(state.parentMap, node, sequenceNode);
      // Note: we do NOT recurse into the CallExpression node after wrapping it,
      // because the callee is Identifier (leaf) and arguments are walked below
      // via the sequence node's expressions[1] which still points to the original node.
      // However, since we replaced the reference in the parent, the recursive descent
      // below will walk the original node's children correctly (they haven't moved).
    }
  }

  // --- Recurse into all child properties (depth-first pre-order) ---
  for (const prop of Object.keys(node)) {
    if (prop === 'type' || prop === 'loc' || prop === 'start' || prop === 'end') {
      continue;
    }
    const child = node[prop];
    if (Array.isArray(child)) {
      // Walk array children. Snapshot length since injection via unshift may have grown the array;
      // however our injected nodes are plain objects without sub-nodes that need walking.
      const len = child.length;
      for (let i = 0; i < len; i++) {
        walk(child[i], state);
      }
    } else if (child !== null && typeof child === 'object' && typeof child.type === 'string') {
      walk(child, state);
    }
  }

  // --- §3.5 Pop function name stack ---
  if (pushedName !== null) {
    state.enclosingFunctionNames.pop();
  }
}

// ---------------------------------------------------------------------------
// Public API (§3.1)
// ---------------------------------------------------------------------------

/**
 * Instruments compiled JavaScript by injecting __op() counter calls at loop
 * bodies, function entries, and recursive call sites.
 *
 * @param compiledJs - Valid ES2020 JavaScript produced by S1's ts.transpileModule().
 *                     If empty string (""), returns preamble-only output with empty
 *                     nodeRegistry and functionBoundaries (no error thrown).
 * @returns InstrumentResult containing instrumentedJs, nodeRegistry, and functionBoundaries.
 * @throws Error with message "S2: Failed to parse compiled JS: ..." if Acorn cannot parse.
 * @throws Error with message "S2: Failed to regenerate JS: ..." if escodegen fails.
 */
export function instrumentCode(compiledJs: string): InstrumentResult {
  // §5.6 Empty input short-circuit
  if (compiledJs === '') {
    return {
      instrumentedJs: PREAMBLE + '\n',
      nodeRegistry: new Map(),
      functionBoundaries: [],
    };
  }

  // §5.7 Parse — catch Acorn SyntaxError
  let ast: any;
  try {
    ast = acorn.parse(compiledJs, { ecmaVersion: 2020, locations: true });
  } catch (err: any) {
    throw new Error(`S2: Failed to parse compiled JS: ${err.message}`);
  }

  // Inject preamble statements at the front of Program.body (§3.2)
  const preambleNodes = buildPreambleNodes();
  ast.body.unshift(...preambleNodes);

  // Build parent map before walking (§4.4)
  const parentMap = buildParentMap(ast);

  // Walk the AST, injecting counters
  const state: WalkState = {
    parentMap,
    enclosingFunctionNames: [],
    nodeRegistry: new Map<string, NodeMeta>(),
    functionBoundaries: [],
  };

  // Walk all top-level nodes (skip the two preamble nodes we just injected)
  for (let i = preambleNodes.length; i < ast.body.length; i++) {
    walk(ast.body[i], state);
  }

  // §5.8 Regenerate — catch escodegen errors
  let instrumentedJs: string;
  try {
    instrumentedJs = escodegen.generate(ast);
  } catch (err: any) {
    throw new Error(`S2: Failed to regenerate JS: ${err.message}`);
  }

  return {
    instrumentedJs,
    nodeRegistry: state.nodeRegistry,
    functionBoundaries: state.functionBoundaries,
  };
}
