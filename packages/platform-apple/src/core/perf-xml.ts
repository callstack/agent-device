import type { XmlNode } from '@agent-device/xml';

function findFirstXmlNode(
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

function parseDirectXmlNumber(element: XmlNode | undefined): number | null {
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

type XmlProcess = { pid?: number; name?: string };

export type XmlReference = {
  numberValue?: number | null;
  process?: XmlProcess | null;
};

export function rememberXmlReferences(
  elements: XmlNode[],
  references: Map<string, XmlReference>,
): void {
  for (const element of elements) {
    rememberXmlReferences(element.children, references);
    if (!element.attributes.id) continue;
    references.set(element.attributes.id, {
      numberValue: parseDirectXmlNumber(element),
      process: readDirectXmlProcess(element),
    });
  }
}

export function resolveXmlProcess(
  element: XmlNode | undefined,
  references: Map<string, XmlReference>,
): XmlProcess | null {
  if (!element) return null;
  if (element.attributes.ref) return references.get(element.attributes.ref)?.process ?? null;
  return readDirectXmlProcess(element);
}

function readDirectXmlProcess(element: XmlNode | undefined): XmlProcess | null {
  if (!element || element.children.some((child) => child.name === 'sentinel')) return null;
  const pidNode = findFirstXmlNode(element.children, (child) => child.name === 'pid');
  const pid = parseDirectXmlNumber(pidNode);
  const name = (element.attributes.fmt ?? '')
    .trim()
    .replace(/\s+\(\d+\)$/, '')
    .trim();
  if (pid === null && name.length === 0) return null;
  return {
    pid: pid ?? undefined,
    name: name.length > 0 ? name : undefined,
  };
}

export function indexXmlNodesById(document: XmlNode[]): Map<string, XmlNode> {
  return new Map(
    findAllXmlNodes(document, (node) => Boolean(node.attributes.id)).flatMap((node) => {
      const id = node.attributes.id;
      return id ? [[id, node] as const] : [];
    }),
  );
}

export function resolveXmlReference(
  node: XmlNode | undefined,
  nodesById: Map<string, XmlNode>,
): XmlNode | undefined {
  if (!node) return undefined;
  return node.attributes.ref ? nodesById.get(node.attributes.ref) : node;
}
