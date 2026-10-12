import fs from 'node:fs';
import path from 'node:path';
import { parseSync } from 'oxc-parser';

export type Shard = { index: number; count: number };

type Slice = { file: string; start: number; end: number; source: string; weight: number };

/** Syntax density approximates mutation work without counting comments or string length. */
function syntaxWeight(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + syntaxWeight(entry), 0);
  const node = value as Record<string, unknown>;
  const own = typeof node.type === 'string' && !node.type.startsWith('TS') ? 1 : 0;
  return own + Object.values(node).reduce<number>((sum, entry) => sum + syntaxWeight(entry), 0);
}

function position(source: string, offset: number): string {
  const prefix = source.slice(0, offset);
  const line = prefix.split('\n').length;
  return `${line}:${offset - (prefix.lastIndexOf('\n') + 1)}`;
}

/** Partition at top-level statement boundaries so no mutant straddles a cut. */
function slices(
  file: string,
  source: string,
  statements: readonly { start: number; end: number; weight: number }[],
  budget: number,
): Slice[] {
  const result: Slice[] = [];
  let start = 0;
  let weight = 0;
  for (const statement of statements) {
    if (weight > 0 && weight + statement.weight > budget) {
      result.push({ file, start, end: statement.start, source, weight });
      start = statement.start;
      weight = 0;
    }
    weight += statement.weight;
  }
  result.push({ file, start, end: source.length, source, weight });
  return result;
}

/** Balance source ranges, including kernels whose entire source is one file. */
export function shardFiles(files: readonly string[], shard: Shard, root: string): string[] {
  const sources = files.map((file) => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const parsed = parseSync(file, source);
    if (parsed.errors.length > 0)
      throw new Error(`Cannot shard ${file}: ${parsed.errors[0]!.message}`);
    const statements = parsed.program.body.map((statement) => ({
      start: statement.start,
      end: statement.end,
      weight: syntaxWeight(statement),
    }));
    return { file, source, statements };
  });
  const budget = Math.ceil(
    sources.reduce(
      (total, entry) =>
        total + entry.statements.reduce((sum, statement) => sum + statement.weight, 0),
      0,
    ) / shard.count,
  );
  const weighed = sources
    .flatMap(({ file, source, statements }) => slices(file, source, statements, budget))
    .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file) || a.start - b.start);
  const bins = Array.from({ length: shard.count }, () => ({ size: 0, slices: [] as Slice[] }));
  for (const slice of weighed) {
    const bin = bins.reduce((smallest, next) => (next.size < smallest.size ? next : smallest));
    bin.slices.push(slice);
    bin.size += slice.weight;
  }
  const selected = bins[shard.index - 1]!.slices;
  if (selected.length === 0)
    throw new Error(`Mutation shard ${shard.index}/${shard.count} has no sources`);
  return selected
    .map(({ file, source, start, end }) =>
      start === 0 && end === source.length
        ? file
        : `${file}:${position(source, start)}-${position(source, end)}`,
    )
    .sort();
}
