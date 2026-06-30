import type { XmlNode } from './xml.ts';

export function findFirstXmlNode(
  nodes: XmlNode[],
  predicate: (node: XmlNode) => boolean,
): XmlNode | undefined {
  for (const node of nodes) {
    if (predicate(node)) return node;
    const descendant = findFirstXmlNode(node.children, predicate);
    if (descendant) return descendant;
  }
  return undefined;
}

export function findAllXmlNodes(
  nodes: XmlNode[],
  predicate: (node: XmlNode) => boolean,
): XmlNode[] {
  const matches: XmlNode[] = [];
  for (const node of nodes) {
    if (predicate(node)) matches.push(node);
    matches.push(...findAllXmlNodes(node.children, predicate));
  }
  return matches;
}

function readFirstChildText(node: XmlNode, childName: string): string | null {
  const child = node.children.find((candidate) => candidate.name === childName);
  return child?.text ?? null;
}

export function readSchemaColumns(document: XmlNode[], schemaName: string): string[] {
  const schema = findFirstXmlNode(
    document,
    (node) => node.name === 'schema' && node.attributes.name === schemaName,
  );
  if (!schema) return [];
  return schema.children
    .filter((child) => child.name === 'col')
    .map((column) => readFirstChildText(column, 'mnemonic') ?? '');
}

export function parseDirectXmlNumber(element: XmlNode | undefined): number | null {
  if (!element || element.children.some((child) => child.name === 'sentinel')) return null;
  if (!element.text) return null;
  const value = Number(element.text);
  return Number.isFinite(value) ? value : null;
}

export function resolveXmlNumber(
  element: XmlNode | undefined,
  references: Map<string, { numberValue?: number | null }>,
): number | null {
  if (!element) return null;
  if (element.attributes.ref) return references.get(element.attributes.ref)?.numberValue ?? null;
  return parseDirectXmlNumber(element);
}
