import { parseXmlDocumentSync, type XmlNode } from '@agent-device/xml';

export type AppleTimeProfileFunction = {
  symbol: string;
  binary?: string;
  selfSampleMs: number;
  selfSamplePercent: number;
};

export type AppleTimeProfileSummary = {
  sampleCount: number;
  totalSampleWeightMs: number;
  topFunctions: AppleTimeProfileFunction[];
};

const DEFAULT_TOP_FUNCTION_LIMIT = 10;

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

export function parseAppleTimeProfileSummary(
  xml: string,
  limit = DEFAULT_TOP_FUNCTION_LIMIT,
): AppleTimeProfileSummary {
  const document = parseXmlDocumentSync(xml);
  const nodesById = indexXmlNodesById(document);
  const weightsByFunction = new Map<
    string,
    { symbol: string; binary?: string; weightNs: number }
  >();
  let sampleCount = 0;
  let totalWeightNs = 0;

  for (const row of findAllXmlNodes(document, (node) => node.name === 'row')) {
    const weightNs = readRowWeightNs(row, nodesById);
    const leafFrame = readLeafFrame(row, nodesById);
    if (weightNs === undefined || !leafFrame) continue;
    const symbol = leafFrame.attributes.name?.trim() || '<unknown>';
    const binary = readFrameBinaryName(leafFrame, nodesById);
    const key = `${binary ?? ''}\u0000${symbol}`;
    const previous = weightsByFunction.get(key);
    weightsByFunction.set(key, {
      symbol,
      binary,
      weightNs: (previous?.weightNs ?? 0) + weightNs,
    });
    sampleCount += 1;
    totalWeightNs += weightNs;
  }

  const boundedLimit = Math.max(0, Math.floor(limit));
  const topFunctions = [...weightsByFunction.values()]
    .sort(
      (left, right) => right.weightNs - left.weightNs || left.symbol.localeCompare(right.symbol),
    )
    .slice(0, boundedLimit)
    .map(({ symbol, binary, weightNs }) => ({
      symbol,
      binary,
      selfSampleMs: round(weightNs / 1_000_000, 3),
      selfSamplePercent: totalWeightNs > 0 ? round((weightNs / totalWeightNs) * 100, 1) : 0,
    }));

  return {
    sampleCount,
    totalSampleWeightMs: round(totalWeightNs / 1_000_000, 3),
    topFunctions,
  };
}

function indexXmlNodesById(document: XmlNode[]): Map<string, XmlNode> {
  return new Map(
    findAllXmlNodes(document, (node) => Boolean(node.attributes.id)).flatMap((node) => {
      const id = node.attributes.id;
      return id ? [[id, node] as const] : [];
    }),
  );
}

function resolveReference(
  node: XmlNode | undefined,
  nodesById: Map<string, XmlNode>,
): XmlNode | undefined {
  if (!node) return undefined;
  return node.attributes.ref ? nodesById.get(node.attributes.ref) : node;
}

function readRowWeightNs(row: XmlNode, nodesById: Map<string, XmlNode>): number | undefined {
  const weight = resolveReference(
    row.children.find((node) => node.name === 'weight'),
    nodesById,
  );
  if (!weight?.text) return undefined;
  const value = Number(weight.text);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function readLeafFrame(row: XmlNode, nodesById: Map<string, XmlNode>): XmlNode | undefined {
  const backtrace = resolveReference(
    row.children.find((node) => node.name === 'backtrace'),
    nodesById,
  );
  return resolveReference(
    backtrace?.children.find((node) => node.name === 'frame'),
    nodesById,
  );
}

function readFrameBinaryName(frame: XmlNode, nodesById: Map<string, XmlNode>): string | undefined {
  const binary = resolveReference(
    frame.children.find((node) => node.name === 'binary'),
    nodesById,
  );
  return binary?.attributes.name?.trim() || undefined;
}

function round(value: number, fractionDigits: number): number {
  const scale = 10 ** fractionDigits;
  return Math.round(value * scale) / scale;
}
