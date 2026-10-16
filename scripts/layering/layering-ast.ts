/** Shared AST helpers for permanent layering policies. */
export type ProductionSource = Readonly<{ path: string; source: string }>;

export type AstNode = Record<string, unknown>;

export function asNode(value: unknown): AstNode | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as AstNode)
    : undefined;
}

export function nodeList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function memberName(node: Record<string, unknown>): string | undefined {
  const property = node.property as Record<string, unknown> | undefined;
  if (!property) return undefined;
  return node.computed === true
    ? propertyName(property)
    : property.type === 'Identifier'
      ? String(property.name)
      : undefined;
}

export function propertyName(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const value = node as Record<string, unknown>;
  return value.type === 'Identifier' || value.type === 'Literal'
    ? ((value.name as string | undefined) ?? (value.value as string | undefined))
    : undefined;
}

export function memberPath(node: unknown): string[] | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const record = node as Record<string, unknown>;
  if (record.type === 'Identifier') {
    return typeof record.name === 'string' ? [record.name] : undefined;
  }
  if (record.type === 'ChainExpression') return memberPath(record.expression);
  if (record.type !== 'MemberExpression' || record.computed === true) return undefined;
  const object = memberPath(record.object);
  const name = propertyName(record.property);
  return object && name ? [...object, name] : undefined;
}

export function visitAst(node: unknown, visitor: (node: Record<string, unknown>) => void): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) visitAst(child, visitor);
    return;
  }
  const record = node as Record<string, unknown>;
  visitor(record);
  for (const child of Object.values(record)) visitAst(child, visitor);
}

const IMPORT_WRAPPER_TYPES = new Set([
  'AwaitExpression',
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
]);

function unwrapImportInit(node: unknown): Record<string, unknown> | null {
  let current = node;
  while (current !== null && typeof current === 'object') {
    const record = current as Record<string, unknown>;
    if (typeof record.type !== 'string' || !IMPORT_WRAPPER_TYPES.has(record.type)) {
      return record.type === 'ImportExpression' ? record : null;
    }
    current =
      record.type === 'AwaitExpression' || record.type === 'ParenthesizedExpression'
        ? record.argument
        : record.expression;
  }
  return null;
}

export type DestructuredDynamicImport = Readonly<{
  /** Export names captured from static (non-computed) property keys. */
  symbols: readonly string[];
}>;

/**
 * Bindings captured by destructuring a dynamic import
 * (`const { a, b: local } = await import('...')` captures `a` and `b`), keyed by the import
 * expression's source offset. A rest element or a computed key names no export and is skipped.
 * Namespace-form and bare dynamic imports capture nothing.
 */
export function destructuredDynamicImportBindings(
  program: unknown,
): ReadonlyMap<number, DestructuredDynamicImport> {
  const captures = new Map<number, DestructuredDynamicImport>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.type === 'VariableDeclarator') {
      const init = unwrapImportInit(record.init);
      const id = record.id;
      if (
        init !== null &&
        typeof init.start === 'number' &&
        id !== null &&
        typeof id === 'object' &&
        (id as Record<string, unknown>).type === 'ObjectPattern'
      ) {
        const symbols: string[] = [];
        const properties = (id as Record<string, unknown>).properties;
        if (Array.isArray(properties)) {
          for (const property of properties) {
            if (
              property === null ||
              typeof property !== 'object' ||
              (property as Record<string, unknown>).type !== 'Property' ||
              (property as Record<string, unknown>).computed === true
            ) {
              continue;
            }
            const name = propertyName((property as Record<string, unknown>).key);
            if (name) symbols.push(name);
          }
        }
        captures.set(init.start, { symbols });
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(program);
  return captures;
}

function patternNames(pattern: unknown, into: string[]): void {
  const node = asNode(pattern);
  if (node === undefined) return;
  switch (node.type) {
    case 'Identifier':
      into.push(node.name as string);
      break;
    case 'ObjectPattern':
      for (const property of nodeList(node.properties)) {
        const entry = asNode(property);
        patternNames(entry?.type === 'Property' ? entry.value : entry, into);
      }
      break;
    case 'ArrayPattern':
      for (const element of nodeList(node.elements)) patternNames(element, into);
      break;
    case 'AssignmentPattern':
      patternNames(node.left, into);
      break;
    case 'RestElement':
      patternNames(node.argument, into);
      break;
    case 'TSParameterProperty':
      patternNames(node.parameter, into);
      break;
  }
}

function lexicalNames(statements: unknown[], into: string[]): void {
  for (const statement of statements) {
    const node = asNode(statement);
    if (node?.type === 'VariableDeclaration' && node.kind !== 'var') {
      for (const declarator of nodeList(node.declarations)) {
        patternNames(asNode(declarator)?.id, into);
      }
    } else if (node?.type === 'FunctionDeclaration' || node?.type === 'ClassDeclaration') {
      patternNames(node.id, into);
    }
  }
}

function isFunctionNode(node: AstNode): boolean {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  );
}

function hoistedVarNames(node: unknown, into: string[]): void {
  for (const child of Array.isArray(node) ? node : [node]) {
    const record = asNode(child);
    if (record === undefined || isFunctionNode(record)) continue;
    if (record.type === 'VariableDeclaration' && record.kind === 'var') {
      for (const declarator of nodeList(record.declarations)) {
        patternNames(asNode(declarator)?.id, into);
      }
    }
    for (const value of Object.values(record)) hoistedVarNames(value, into);
  }
}

/** Names `node` itself declares for its own subtree: parameters, `var`s, block-level lexical declarations. */
function scopeBindings(node: AstNode): string[] {
  const names: string[] = [];
  if (isFunctionNode(node)) {
    for (const param of nodeList(node.params)) patternNames(param, names);
    if (node.type === 'FunctionExpression') patternNames(node.id, names);
    hoistedVarNames(node.body, names);
  } else if (
    node.type === 'BlockStatement' ||
    node.type === 'StaticBlock' ||
    node.type === 'TSModuleBlock'
  ) {
    lexicalNames(nodeList(node.body), names);
  } else if (node.type === 'ClassExpression') {
    patternNames(node.id, names);
  } else if (node.type === 'SwitchStatement') {
    for (const switchCase of nodeList(node.cases)) {
      lexicalNames(nodeList(asNode(switchCase)?.consequent), names);
    }
  } else if (node.type === 'ForStatement') {
    lexicalNames([node.init], names);
  } else if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
    lexicalNames([node.left], names);
  } else if (node.type === 'CatchClause') {
    patternNames(node.param, names);
  }
  return names;
}

/**
 * `visitAst` that also hands the visitor the names declared by the enclosing scopes: function
 * parameters and `var`s, block-level `let`/`const`/`function`/`class`, loop heads and `catch`
 * parameters. A `with` statement or `eval` can rebind names invisibly and is not modelled.
 */
export function visitAstScoped(
  node: unknown,
  shadowed: ReadonlySet<string>,
  visitor: (node: AstNode, shadowed: ReadonlySet<string>) => void,
): void {
  if (Array.isArray(node)) {
    for (const child of node) visitAstScoped(child, shadowed, visitor);
    return;
  }
  const record = asNode(node);
  if (record === undefined) return;
  const declared = scopeBindings(record);
  const scope = declared.length > 0 ? new Set([...shadowed, ...declared]) : shadowed;
  visitor(record, scope);
  for (const child of Object.values(record)) visitAstScoped(child, scope, visitor);
}
