export type EconomySample = { text: string } | { data: unknown };

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
      refs: new Set(sample.text.match(/@e\d+(?:~s\d+)?/g) ?? []).size,
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
    refs: counters.refs,
    hints: counters.hints,
    shape,
  };
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
