export type EconomySample = { text: string } | { data: unknown };

// Rendered @ref token grammar (optionally generation-pinned, e.g. `@e12~s3`).
// Shared so ref counting and the routine-workflow oracle agree on what a ref is.
export const REF_TOKEN_PATTERN = /@e\d+(?:~s\d+)?/g;

export type EconomyMetrics = {
  bytes: number;
  lines: number;
  refs: number;
  hints: number;
  shape: string;
};

export function measureEconomySample(sample: EconomySample): EconomyMetrics {
  if ('text' in sample) {
    return {
      bytes: Buffer.byteLength(sample.text),
      lines: sample.text.length === 0 ? 0 : sample.text.split('\n').length,
      refs: new Set(sample.text.match(REF_TOKEN_PATTERN) ?? []).size,
      hints: (sample.text.match(/(?:^|\n)hint:/gi) ?? []).length,
      shape: 'text',
    };
  }

  const serialized = JSON.stringify(sample.data);
  const counters = { refs: 0, hints: 0 };
  const shape = [...new Set(collectShape(sample.data, '$', counters))].sort().join('|');
  return {
    bytes: Buffer.byteLength(serialized),
    lines: 1,
    refs: counters.refs + textOnlyToolResultRefs(sample.data),
    hints: counters.hints,
    shape,
  };
}

/**
 * A text-only MCP tool result carries its refs in the text the model reads. A result with
 * structuredContent counts its refs there, so no ref is counted twice.
 */
function textOnlyToolResultRefs(data: unknown): number {
  if (!data || typeof data !== 'object' || 'structuredContent' in data) return 0;
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content)) return 0;
  const text = content
    .map((entry) => (entry as { text?: unknown }).text)
    .filter((entry): entry is string => typeof entry === 'string')
    .join('\n');
  return new Set(text.match(REF_TOKEN_PATTERN) ?? []).size;
}

function collectShape(
  value: unknown,
  path: string,
  counters: { refs: number; hints: number },
): string[] {
  if (Array.isArray(value)) return collectArrayShape(value, path, counters);
  if (!value || typeof value !== 'object') return [`${path}:${typeof value}`];
  return collectObjectShape(value, path, counters);
}

function collectArrayShape(
  value: unknown[],
  path: string,
  counters: { refs: number; hints: number },
): string[] {
  return [`${path}:array`, ...value.flatMap((entry) => collectShape(entry, `${path}[]`, counters))];
}

function collectObjectShape(
  value: object,
  path: string,
  counters: { refs: number; hints: number },
): string[] {
  const paths = [`${path}:object`];
  for (const [key, entry] of Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (entry === undefined) continue;
    if (key === 'ref' && typeof entry === 'string') counters.refs++;
    if (key === 'hint' && typeof entry === 'string' && entry.length > 0) counters.hints++;
    paths.push(...collectShape(entry, `${path}.${key}`, counters));
  }
  return paths;
}
