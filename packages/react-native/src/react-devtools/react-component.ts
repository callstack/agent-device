export type ComponentKind = 'class' | 'function' | 'forwardRef' | 'memo' | 'unknown';

export const COMPONENT_KINDS: Readonly<Record<number, ComponentKind>> = {
  0: 'unknown',
  1: 'class',
  5: 'function',
  6: 'forwardRef',
  8: 'memo',
  15: 'function',
};

export function componentKind(type: number): ComponentKind {
  return Object.hasOwn(COMPONENT_KINDS, type) ? COMPONENT_KINDS[type]! : 'unknown';
}

const HOC_PATTERN = /^([A-Za-z0-9_$]+)\((.+)\)$/;

/** Splits DevTools wrapper names; tree views unwrap only React's transparent wrappers. */
export function splitDisplayName(
  displayName: string,
  reactWrappersOnly = false,
): { name: string; wrappers: string[] } {
  const wrappers: string[] = [];
  let name = displayName;
  for (let match = HOC_PATTERN.exec(name); match; match = HOC_PATTERN.exec(name)) {
    if (reactWrappersOnly && match[1] !== 'Memo' && match[1] !== 'ForwardRef') break;
    wrappers.push(match[1]!);
    name = match[2]!;
  }
  return { name, wrappers };
}

export function componentName(displayName: string): string {
  return splitDisplayName(displayName, true).name;
}

export function componentRef(node: { id: number }): string {
  return `@c${node.id}`;
}

export function kindLabel(elementType: number): string {
  const kind = componentKind(elementType);
  return kind === 'memo' || kind === 'class' || kind === 'forwardRef' ? ` [${kind}]` : '';
}
