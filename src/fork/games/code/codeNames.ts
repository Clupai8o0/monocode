import type { SyntaxNode, Tree } from "@lezer/common";
import type { DrillLanguage, DrillTest } from "./codeModel";

/**
 * Fork: name checking for the Code tab's drills. The editor already parses
 * with Lezer for highlighting, so this is a second walk over that tree: it
 * collects every name the file binds, then flags reads of names that are
 * neither defined nor a known global. Nothing is type checked and no second
 * parser is involved. Everything is loose and file-wide so a beginner's
 * half-finished draft stays quiet.
 */

export type NameWarning = {
  from: number;
  to: number;
  name: string;
  message: string;
  suggestion?: string;
};

/** Past this a drill is a viewer, not something to name-check. */
const MAX_NAME_CHECK_CHARS = 20_000;

/** JavaScript's everyday globals, plus the CommonJS ones drills may use. */
const JS_GLOBALS = new Set(
  `console Math JSON Object Array String Number Boolean Map Set WeakMap Promise
  Symbol BigInt Date RegExp Error TypeError RangeError parseInt parseFloat
  isNaN isFinite Infinity NaN undefined globalThis structuredClone setTimeout
  clearTimeout setInterval clearInterval queueMicrotask require module exports
  process Buffer arguments this`
    .trim()
    .split(/\s+/),
);

/** `dir(builtins)` from Python 3.12, plus the module dunders drills meet. */
const PYTHON_BUILTINS = new Set(
  `ArithmeticError AssertionError AttributeError BaseException
  BaseExceptionGroup BlockingIOError BrokenPipeError BufferError BytesWarning
  ChildProcessError ConnectionAbortedError ConnectionError
  ConnectionRefusedError ConnectionResetError DeprecationWarning EOFError
  Ellipsis EncodingWarning EnvironmentError Exception ExceptionGroup False
  FileExistsError FileNotFoundError FloatingPointError FutureWarning
  GeneratorExit IOError ImportError ImportWarning IndentationError IndexError
  InterruptedError IsADirectoryError KeyError KeyboardInterrupt LookupError
  MemoryError ModuleNotFoundError NameError None NotADirectoryError
  NotImplemented NotImplementedError OSError OverflowError
  PendingDeprecationWarning PermissionError ProcessLookupError RecursionError
  ReferenceError ResourceWarning RuntimeError RuntimeWarning StopAsyncIteration
  StopIteration SyntaxError SyntaxWarning SystemError SystemExit TabError
  TimeoutError True TypeError UnboundLocalError UnicodeDecodeError
  UnicodeEncodeError UnicodeError UnicodeTranslateError UnicodeWarning
  UserWarning ValueError Warning ZeroDivisionError __build_class__ __debug__
  __doc__ __import__ __loader__ __name__ __package__ __spec__ __file__ abs
  aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr
  classmethod compile complex copyright credits delattr dict dir divmod
  enumerate eval exec exit filter float format frozenset getattr globals
  hasattr hash help hex id input int isinstance issubclass iter len license
  list locals map max memoryview min next object oct open ord pow print property
  quit range repr reversed round set setattr slice sorted staticmethod str sum
  super tuple type vars zip`
    .trim()
    .split(/\s+/),
);

const CALL_NAME = /^\s*([A-Za-z_$][\w$]*)\s*\(/;

/** The leading function name of each drill test's call, once each. */
export function testCallNames(tests: readonly DrillTest[]): string[] {
  const names: string[] = [];
  for (const test of tests) {
    const name = CALL_NAME.exec(test.call)?.[1];
    if (name && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Every name warning for a parsed drill: one per undefined read, plus one at
 * the top of the document for each test the user's code has renamed away.
 * A tree with any syntax error is left alone: its recovery nodes would make
 * the name results noise on top of the real mistake.
 */
export function nameWarnings(
  language: DrillLanguage,
  doc: string,
  tree: Tree,
  testNames: readonly string[] = [],
): NameWarning[] {
  if (doc.length > MAX_NAME_CHECK_CHARS || hasSyntaxError(tree.topNode)) {
    return [];
  }
  const definitions = collectDefinitions(language, tree, doc);
  const known = language === "python" ? PYTHON_BUILTINS : JS_GLOBALS;
  const warnings: NameWarning[] = [];

  for (const name of new Set(testNames)) {
    if (!name || definitions.has(name) || known.has(name)) {
      continue;
    }
    const suggestion = closestName(name, definitions);
    warnings.push({
      from: 0,
      to: firstLineEnd(doc),
      name,
      message: testNameMessage(name, suggestion),
      suggestion,
    });
  }

  const check = (node: SyntaxNode) => {
    const name = doc.slice(node.from, node.to);
    if (!name || definitions.has(name) || known.has(name)) {
      return;
    }
    const suggestion = closestName(name, definitions, known);
    warnings.push({
      from: node.from,
      to: node.to,
      name,
      message: undefinedNameMessage(name, suggestion),
      suggestion,
    });
  };

  const visit = (node: SyntaxNode) => {
    if (language === "python") {
      if (node.name === "VariableName" && isPythonRead(node)) {
        check(node);
      }
    } else if (node.name === "VariableName" && isJavaScriptRead(node)) {
      check(node);
    } else if (node.name === "Property" && isShorthandProperty(node)) {
      // `{ total }` reads `total`, but the grammar calls it a property key.
      const name = node.getChild("PropertyDefinition");
      if (name) {
        check(name);
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      visit(child);
    }
  };
  visit(tree.topNode);
  return warnings;
}

function firstLineEnd(doc: string): number {
  const end = doc.indexOf("\n");
  return end === -1 ? doc.length : end;
}

function hasSyntaxError(node: SyntaxNode): boolean {
  if (node.type.isError) {
    return true;
  }
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (hasSyntaxError(child)) {
      return true;
    }
  }
  return false;
}

function childrenOf(node: SyntaxNode): SyntaxNode[] {
  const children: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    children.push(child);
  }
  return children;
}

function addDefinition(definitions: Set<string>, doc: string, node: SyntaxNode) {
  const name = doc.slice(node.from, node.to);
  if (name) {
    definitions.add(name);
  }
}

function collectDefinitions(
  language: DrillLanguage,
  tree: Tree,
  doc: string,
): Set<string> {
  const definitions = new Set<string>();
  if (language === "python") {
    collectPythonDefinitions(tree.topNode, doc, definitions);
    return definitions;
  }
  tree.iterate({
    enter(node) {
      if (node.name === "VariableDefinition" || node.name === "Label") {
        addDefinition(definitions, doc, node.node);
      } else if (node.name === "PatternProperty") {
        // `{ total }` and `{ total = 1 }` bind the property name itself;
        // `{ key: value }` binds the value on the other side of the colon.
        if (!node.node.getChild(":")) {
          const name = node.node.getChild("PropertyName");
          if (name) {
            addDefinition(definitions, doc, name);
          }
        }
      }
      return true;
    },
  });
  return definitions;
}

function collectPythonDefinitions(
  node: SyntaxNode,
  doc: string,
  definitions: Set<string>,
) {
  switch (node.name) {
    case "ParamList":
      collectPythonParams(node, doc, definitions);
      break;
    case "FunctionDefinition":
    case "ClassDefinition":
    case "TypeDefinition":
    case "NamedExpression": {
      const name = node.getChild("VariableName");
      if (name) {
        addDefinition(definitions, doc, name);
      }
      break;
    }
    case "AssignStatement":
      collectPythonAssignmentTargets(node, doc, definitions);
      break;
    case "UpdateStatement":
      collectPythonUpdateTarget(node, doc, definitions);
      break;
    case "ForStatement":
    case "ArrayComprehensionExpression":
    case "SetComprehensionExpression":
    case "DictionaryComprehensionExpression":
    case "ComprehensionExpression":
    case "ArgList":
      // `f(x for x in xs)` keeps the generator's `for` in the argument list.
      collectPythonForTargets(node, doc, definitions);
      break;
    case "WithStatement":
    case "TryStatement":
      collectPythonAsAliases(node, doc, definitions);
      break;
    case "ImportStatement":
      collectPythonImports(node, doc, definitions);
      break;
    case "ScopeStatement":
      for (const child of childrenOf(node)) {
        if (child.name === "VariableName") {
          addDefinition(definitions, doc, child);
        }
      }
      break;
    case "CapturePattern": {
      const name = node.getChild("VariableName");
      if (name) {
        addDefinition(definitions, doc, name);
      }
      break;
    }
    case "AsPattern": {
      const children = childrenOf(node);
      const alias = children[children.length - 1];
      if (children.some((child) => child.name === "as") && alias?.name === "VariableName") {
        addDefinition(definitions, doc, alias);
      }
      break;
    }
  }
  for (let child = node.firstChild; child; child = child.nextSibling) {
    collectPythonDefinitions(child, doc, definitions);
  }
}

/**
 * `def f(a, b=1, *args, **kwargs)`: a parameter is the name right after `(`
 * or `,` (or a star). A default value after `=` is an ordinary read.
 */
function collectPythonParams(
  node: SyntaxNode,
  doc: string,
  definitions: Set<string>,
) {
  let expectName = true;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    switch (child.name) {
      case "(":
      case ")":
        break;
      case ",":
      case "*":
      case "**":
        expectName = true;
        break;
      case "VariableName":
        if (expectName) {
          addDefinition(definitions, doc, child);
          expectName = false;
        }
        break;
      case "/":
      case "TypeDef":
      case "AssignOp":
        expectName = false;
        break;
      default:
        expectName = false;
        break;
    }
  }
}

/**
 * Every target group before the last `=` is bound: `a = b = 1` defines both,
 * while `obj.x = 1` and `d[0] = 1` only read `obj` and `d`.
 */
function collectPythonAssignmentTargets(
  node: SyntaxNode,
  doc: string,
  definitions: Set<string>,
) {
  const children = childrenOf(node);
  let lastAssign = -1;
  children.forEach((child, index) => {
    if (child.name === "AssignOp") {
      lastAssign = index;
    }
  });
  const end = lastAssign === -1 ? children.length : lastAssign;
  for (let index = 0; index < end; index += 1) {
    const child = children[index];
    if (child.name !== "TypeDef" && child.name !== "AssignOp") {
      collectPythonTarget(child, doc, definitions);
    }
  }
}

function collectPythonUpdateTarget(
  node: SyntaxNode,
  doc: string,
  definitions: Set<string>,
) {
  for (const child of childrenOf(node)) {
    if (child.name === "UpdateOp") {
      break;
    }
    collectPythonTarget(child, doc, definitions);
  }
}

function collectPythonTarget(
  node: SyntaxNode,
  doc: string,
  definitions: Set<string>,
) {
  if (node.name === "VariableName") {
    addDefinition(definitions, doc, node);
    return;
  }
  if (
    node.name === "TupleExpression" ||
    node.name === "ArrayExpression" ||
    node.name === "ParenthesizedExpression"
  ) {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      collectPythonTarget(child, doc, definitions);
    }
  }
}

/** `for i, x in ...`, including every clause of a comprehension. */
function collectPythonForTargets(
  node: SyntaxNode,
  doc: string,
  definitions: Set<string>,
) {
  let collecting = false;
  for (const child of childrenOf(node)) {
    if (child.name === "for") {
      collecting = true;
      continue;
    }
    if (!collecting) {
      continue;
    }
    if (child.name === "in") {
      collecting = false;
      continue;
    }
    if (child.name !== "async") {
      collectPythonTarget(child, doc, definitions);
    }
  }
}

/** `with ... as fh`, `except ValueError as err`. */
function collectPythonAsAliases(
  node: SyntaxNode,
  doc: string,
  definitions: Set<string>,
) {
  let expectingAlias = false;
  for (const child of childrenOf(node)) {
    if (child.name === "as") {
      expectingAlias = true;
    } else if (expectingAlias) {
      if (child.name === "VariableName") {
        addDefinition(definitions, doc, child);
      }
      expectingAlias = false;
    }
  }
}

/**
 * `import math` binds math; `import a.b` binds a; `import a as b` binds only
 * b. A name on the left of `as` is the module's own name, not a binding.
 */
function collectPythonImports(
  node: SyntaxNode,
  doc: string,
  definitions: Set<string>,
) {
  const children = childrenOf(node);
  const importAt = children.findIndex((child) => child.name === "import");
  if (importAt < 0) {
    return;
  }
  let entryStarted = false;
  let expectingAlias = false;
  for (let index = importAt + 1; index < children.length; index += 1) {
    const child = children[index];
    if (child.name === ",") {
      entryStarted = false;
      continue;
    }
    if (child.name === "as") {
      expectingAlias = true;
      continue;
    }
    if (child.name !== "VariableName") {
      continue;
    }
    if (expectingAlias) {
      addDefinition(definitions, doc, child);
      expectingAlias = false;
      entryStarted = true;
      continue;
    }
    if (entryStarted) {
      continue;
    }
    let hasAlias = false;
    for (
      let next = index + 1;
      next < children.length && children[next].name !== ",";
      next += 1
    ) {
      if (children[next].name === "as") {
        hasAlias = true;
        break;
      }
    }
    if (!hasAlias) {
      addDefinition(definitions, doc, child);
    }
    entryStarted = true;
  }
}

/** A property name after a dot, an object key, or a label is not a read. */
function isJavaScriptRead(node: SyntaxNode): boolean {
  if (node.prevSibling?.name === "as") {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.name === "ExportGroup" || parent.name === "ExportDeclaration") {
        return false;
      }
    }
  }
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === "ImportDeclaration") {
      return false;
    }
  }
  return true;
}

function isShorthandProperty(node: SyntaxNode): boolean {
  const name = node.getChild("PropertyDefinition");
  if (!name || node.getChild(":")) {
    return false;
  }
  return node.from === name.from && node.to === name.to;
}

/** A type annotation, an import path, or `f(key=1)`'s key is not a read. */
function isPythonRead(node: SyntaxNode): boolean {
  const parent = node.parent;
  // A dotted decorator (`@app.route`) keeps every segment as a VariableName;
  // only the first one is a name in this file.
  if (node.prevSibling?.name === ".") {
    return false;
  }
  // A KeywordPattern's name is the case class's keyword; its capture is the
  // pattern on the other side of `=`.
  if (parent?.name === "KeywordPattern") {
    return false;
  }
  if (parent?.name === "ArgList" && node.nextSibling?.name === "AssignOp") {
    return false;
  }
  for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.name === "TypeDef" || ancestor.name === "ImportStatement") {
      return false;
    }
  }
  return true;
}

function undefinedNameMessage(name: string, suggestion?: string): string {
  const base = `\`${name}\` isn't defined`;
  return suggestion ? `${base}. Did you mean \`${suggestion}\`?` : base;
}

function testNameMessage(name: string, suggestion?: string): string {
  const base = `The tests call \`${name}\`, but your code doesn't define it`;
  return suggestion ? `${base}. Did you mean \`${suggestion}\`?` : base;
}

/**
 * The closest suggestion within the typo budget: one edit for short names,
 * two for longer ones. A case-only difference is half an edit, so `Add`
 * suggests itself for `add`. Definitions come before builtins on a tie.
 */
function closestName(
  name: string,
  definitions: ReadonlySet<string>,
  known?: ReadonlySet<string>,
): string | undefined {
  const limit = name.length <= 4 ? 1 : 2;
  let best: string | undefined;
  let bestDistance = Infinity;
  const consider = (candidate: string) => {
    if (candidate === name) {
      return;
    }
    const distance = nameDistance(name, candidate);
    if (distance <= limit && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  };
  for (const candidate of [...definitions].sort()) {
    consider(candidate);
  }
  if (known) {
    for (const candidate of [...known].sort()) {
      consider(candidate);
    }
  }
  return best;
}

function nameDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const distance = damerauLevenshtein(a.toLowerCase(), b.toLowerCase());
  return distance === 0 ? 0.5 : distance;
}

/** Optimal string alignment: the usual Damerau-Levenshtein for typos. */
function damerauLevenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const columns = b.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () =>
    new Array<number>(columns).fill(0),
  );
  for (let row = 0; row < rows; row += 1) {
    matrix[row][0] = row;
  }
  for (let column = 0; column < columns; column += 1) {
    matrix[0][column] = column;
  }
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + cost,
      );
      if (
        row > 1 &&
        column > 1 &&
        a[row - 1] === b[column - 2] &&
        a[row - 2] === b[column - 1]
      ) {
        matrix[row][column] = Math.min(
          matrix[row][column],
          matrix[row - 2][column - 2] + 1,
        );
      }
    }
  }
  return matrix[a.length][b.length];
}
