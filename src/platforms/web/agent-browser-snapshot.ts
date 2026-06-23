import type { RawSnapshotNode, Rect } from '../../utils/snapshot.ts';
import {
  isJsonObject,
  readBooleanProperty,
  readProperty,
  readStringProperty,
  type JsonObject,
} from './json-utils.ts';
import type { WebSnapshotResult } from './provider.ts';

type SnapshotRefRecord = {
  ref: string;
  data?: JsonObject;
};

type SnapshotDraftNode = {
  ref: string;
  node: RawSnapshotNode;
};

const MAX_CONCURRENT_BOX_FETCHES = 8;

export async function normalizeAgentBrowserSnapshot(
  data: unknown,
  fetchBox?: (ref: string) => Promise<Rect | undefined>,
): Promise<WebSnapshotResult> {
  const snapshotText = readStringProperty(data, 'snapshot') ?? '';
  const refs = collectSnapshotRefs(readProperty(data, 'refs'));
  const drafts = parseSnapshotDraftNodes(snapshotText, refs);

  if (fetchBox) await attachDraftRects(drafts, fetchBox);

  return {
    nodes: drafts.map((draft, index) => ({ ...draft.node, index })),
    truncated: readBooleanProperty(data, 'truncated'),
  };
}

async function attachDraftRects(
  drafts: SnapshotDraftNode[],
  fetchBox: (ref: string) => Promise<Rect | undefined>,
): Promise<void> {
  for (let index = 0; index < drafts.length; index += MAX_CONCURRENT_BOX_FETCHES) {
    const chunk = drafts.slice(index, index + MAX_CONCURRENT_BOX_FETCHES);
    const rects = await Promise.all(chunk.map((draft) => fetchBox(draft.ref)));
    for (const [chunkIndex, rect] of rects.entries()) {
      if (rect) chunk[chunkIndex]!.node.rect = rect;
    }
  }
}

function parseSnapshotDraftNodes(
  snapshotText: string,
  refs: SnapshotRefRecord[],
): SnapshotDraftNode[] {
  const byRef = new Map(refs.map((ref) => [ref.ref, ref]));
  const drafts: SnapshotDraftNode[] = [];
  const seenRefs = new Set<string>();
  const lastIndexByDepth = new Map<number, number>();

  for (const line of snapshotText.split(/\r?\n/)) {
    const ref = extractBrowserRef(line);
    if (!ref) continue;
    seenRefs.add(ref);
    const metadata = byRef.get(ref)?.data;
    const depth = inferSnapshotDepth(line);
    const node = snapshotNodeFromLine(line, metadata, depth);
    const parentIndex = findParentIndex(lastIndexByDepth, depth);
    if (parentIndex !== undefined) node.parentIndex = parentIndex;
    drafts.push({ ref, node: { ...node, index: drafts.length } });
    lastIndexByDepth.set(depth, drafts.length - 1);
  }

  for (const ref of refs) {
    if (seenRefs.has(ref.ref)) continue;
    drafts.push({
      ref: ref.ref,
      node: { ...snapshotNodeFromMetadata(ref.data), index: drafts.length },
    });
  }

  return drafts;
}

function snapshotNodeFromLine(
  line: string,
  metadata: JsonObject | undefined,
  depth: number,
): RawSnapshotNode {
  const type = extractRole(line) ?? readMetadataString(metadata, ['role', 'type']);
  return {
    index: 0,
    type,
    role: type,
    label: extractQuotedText(line) ?? readMetadataString(metadata, ['label', 'name', 'text']),
    value: extractValue(line) ?? readMetadataString(metadata, ['value']),
    depth,
    enabled: readMetadataBoolean(metadata, ['enabled']),
    focused: readMetadataBoolean(metadata, ['focused']),
  };
}

function snapshotNodeFromMetadata(metadata: JsonObject | undefined): RawSnapshotNode {
  const type = readMetadataString(metadata, ['role', 'type']);
  return {
    index: 0,
    type,
    role: type,
    label: readMetadataString(metadata, ['label', 'name', 'text']),
    value: readMetadataString(metadata, ['value']),
    enabled: readMetadataBoolean(metadata, ['enabled']),
    focused: readMetadataBoolean(metadata, ['focused']),
  };
}

function collectSnapshotRefs(value: unknown): SnapshotRefRecord[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const record = isJsonObject(entry) ? entry : undefined;
      const ref = normalizeBrowserRef(readMetadataString(record, ['ref', 'id']) ?? String(entry));
      return ref ? [{ ref, data: record }] : [];
    });
  }
  if (!isJsonObject(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    const ref = normalizeBrowserRef(key);
    if (!ref) return [];
    return [{ ref, data: isJsonObject(entry) ? entry : undefined }];
  });
}

function inferSnapshotDepth(line: string): number {
  const leadingWhitespace = line.match(/^\s*/)?.[0].length ?? 0;
  return Math.floor(leadingWhitespace / 2);
}

function findParentIndex(lastIndexByDepth: Map<number, number>, depth: number): number | undefined {
  for (let candidateDepth = depth - 1; candidateDepth >= 0; candidateDepth -= 1) {
    const parent = lastIndexByDepth.get(candidateDepth);
    if (parent !== undefined) return parent;
  }
  return undefined;
}

function extractBrowserRef(line: string): string | null {
  return normalizeBrowserRef(
    line.match(/\bref=['"]?(@?e\d+)['"]?/i)?.[1] ?? line.match(/@?(e\d+)\b/i)?.[1],
  );
}

function normalizeBrowserRef(value: string | undefined): string | null {
  const ref = value?.trim().replace(/^@/, '');
  return ref && /^e\d+$/i.test(ref) ? ref.toLowerCase() : null;
}

function extractRole(line: string): string | undefined {
  const cleaned = line
    .replace(/\[[^\]]*ref[^\]]*\]/gi, '')
    .replace(/@?e\d+\b/gi, '')
    .replace(/^[\s|├└─>*-]+/g, '')
    .trim();
  return cleaned.match(/^([A-Za-z][\w-]*)\b/)?.[1];
}

function extractQuotedText(line: string): string | undefined {
  return line.match(/"([^"]+)"/)?.[1] ?? line.match(/'([^']+)'/)?.[1];
}

function extractValue(line: string): string | undefined {
  return (
    extractTrailingAriaValue(line) ??
    line
      .match(/\bvalue=(?:"([^"]*)"|'([^']*)'|([^\s\]]+))/i)
      ?.slice(1)
      .find(isString) ??
    line
      .match(/\bvalue:\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))/i)
      ?.slice(1)
      .find(isString)
  );
}

function extractTrailingAriaValue(line: string): string | undefined {
  const value = line.match(/\]\s*:\s*(.+)$/)?.[1]?.trim();
  return value || undefined;
}

function readMetadataString(metadata: JsonObject | undefined, keys: string[]): string | undefined {
  if (!metadata) return undefined;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function readMetadataBoolean(
  metadata: JsonObject | undefined,
  keys: string[],
): boolean | undefined {
  if (!metadata) return undefined;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
