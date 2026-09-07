/** Shared AST helpers for permanent layering policies. */
export type ProductionSource = Readonly<{ path: string; source: string }>;

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

/**
 * Named bindings captured by destructuring a dynamic import
 * (`const { a, b: local } = await import('...')` captures `a` and `b`), keyed by the import
 * expression's source offset. Namespace-form and bare dynamic imports capture nothing.
 */
export function destructuredDynamicImportBindings(
  program: unknown,
): ReadonlyMap<number, readonly string[]> {
  const bindings = new Map<number, readonly string[]>();
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
        const names: string[] = [];
        const properties = (id as Record<string, unknown>).properties;
        if (Array.isArray(properties)) {
          for (const property of properties) {
            if (
              property !== null &&
              typeof property === 'object' &&
              (property as Record<string, unknown>).type === 'Property' &&
              (property as Record<string, unknown>).computed !== true
            ) {
              const name = propertyName((property as Record<string, unknown>).key);
              if (name) names.push(name);
            }
          }
        }
        bindings.set(init.start, names);
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(program);
  return bindings;
}
