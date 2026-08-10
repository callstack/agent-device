// Reading structural facts out of a TypeScript source file.
//
// Two gates here need the same thing: a list of string literals that a config or a registry
// declares (Vitest project names, affected-selector rule ids). Both could be had by importing
// the module and running it, and both are better read as structure — the same choice
// scripts/layering/bin-alias-fast-path.ts makes for bin.ts. A regex would match the literal
// wherever it appeared, including in comments and unrelated options; the parser sees where the
// literal actually sits.

import { parseSync } from 'oxc-parser';

export type Node = { type?: string; [key: string]: unknown };

export function isNode(value: unknown): value is Node {
  return value !== null && typeof value === 'object';
}

export function parseProgram(file: string, source: string): Node {
  return parseSync(file, source).program as unknown as Node;
}

/** Every child node reachable from `node`, ignoring its non-node fields. */
export function children(node: Node): Node[] {
  return Object.entries(node).flatMap(([key, value]) => {
    if (key === 'type') return [];
    if (Array.isArray(value)) return value.filter(isNode);
    return isNode(value) ? [value] : [];
  });
}

/** The static key of an object property, whether written bare or quoted. */
export function propertyKey(node: Node): string | null {
  if (node.type !== 'Property' && node.type !== 'ObjectProperty') return null;
  const key = node['key'];
  if (!isNode(key)) return null;
  if (key.type === 'Identifier' && typeof key['name'] === 'string') return key['name'];
  return typeof key['value'] === 'string' ? key['value'] : null;
}

/** The string value of a node's `value` field, when it is a string literal. */
export function stringValue(node: Node): string | null {
  const value = node['value'];
  if (!isNode(value)) return null;
  return typeof value['value'] === 'string' ? value['value'] : null;
}

/** The literal text of a node that is itself a string literal. */
export function literalText(node: unknown): string | null {
  return isNode(node) && typeof node['value'] === 'string' ? node['value'] : null;
}

export function findFirst(node: Node, predicate: (candidate: Node) => boolean): Node | null {
  if (predicate(node)) return node;
  for (const child of children(node)) {
    const found = findFirst(child, predicate);
    if (found) return found;
  }
  return null;
}

export function collect(node: Node, visit: (candidate: Node) => void): void {
  visit(node);
  for (const child of children(node)) collect(child, visit);
}

/** 1-based line of a node's start offset, for pointing a failure at real source. */
export function lineOf(source: string, node: unknown): number {
  const start = isNode(node) && typeof node['start'] === 'number' ? node['start'] : 0;
  let line = 1;
  for (let index = 0; index < start && index < source.length; index++) {
    if (source[index] === '\n') line++;
  }
  return line;
}

/** The name of a call expression's callee, when it is a plain identifier. */
export function calleeName(node: Node): string | null {
  if (node.type !== 'CallExpression') return null;
  const callee = node['callee'];
  return isNode(callee) && callee.type === 'Identifier' && typeof callee['name'] === 'string'
    ? callee['name']
    : null;
}
