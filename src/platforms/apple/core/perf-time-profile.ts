import { parseXmlDocumentSync, type XmlNode } from '@agent-device/xml';
import { roundPercent } from '../../perf-utils.ts';
import { findAllXmlNodes, indexXmlNodesById, resolveXmlReference } from './perf-xml.ts';

const APPLE_TIME_PROFILE_FUNCTION_LIMIT = 10;

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

export function parseAppleTimeProfileSummary(
  xml: string,
  limit = APPLE_TIME_PROFILE_FUNCTION_LIMIT,
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
    const frame = readInnermostFrame(row, nodesById);
    if (weightNs === undefined || !frame) continue;
    const symbol = frame.attributes.name?.trim() || '<unknown>';
    const binary = readFrameBinaryName(frame, nodesById);
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
      selfSampleMs: roundMilliseconds(weightNs),
      selfSamplePercent: totalWeightNs > 0 ? roundPercent((weightNs / totalWeightNs) * 100) : 0,
    }));

  return {
    sampleCount,
    totalSampleWeightMs: roundMilliseconds(totalWeightNs),
    topFunctions,
  };
}

function readRowWeightNs(row: XmlNode, nodesById: Map<string, XmlNode>): number | undefined {
  const weight = resolveXmlReference(
    row.children.find((node) => node.name === 'weight'),
    nodesById,
  );
  if (!weight?.text) return undefined;
  const value = Number(weight.text);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function readInnermostFrame(row: XmlNode, nodesById: Map<string, XmlNode>): XmlNode | undefined {
  const backtrace = resolveXmlReference(
    row.children.find((node) => node.name === 'backtrace'),
    nodesById,
  );
  // xctrace lists a sampled backtrace from the innermost frame outward. The first
  // frame therefore owns self time; a focused multi-frame test pins this ordering.
  return resolveXmlReference(
    backtrace?.children.find((node) => node.name === 'frame'),
    nodesById,
  );
}

function readFrameBinaryName(frame: XmlNode, nodesById: Map<string, XmlNode>): string | undefined {
  const binary = resolveXmlReference(
    frame.children.find((node) => node.name === 'binary'),
    nodesById,
  );
  return binary?.attributes.name?.trim() || undefined;
}

function roundMilliseconds(nanoseconds: number): number {
  return Math.round((nanoseconds / 1_000_000) * 1000) / 1000;
}
