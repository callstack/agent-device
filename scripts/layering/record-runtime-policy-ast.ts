export type RecordRuntimeProductionSource = Readonly<{ path: string; source: string }>;

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
