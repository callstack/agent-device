import fs from 'node:fs';
import path from 'node:path';
import { parseSync } from 'oxc-parser';

export type Shard = { index: number; count: number };

type Slice = { file: string; start: number; end: number; source: string };

function position(source: string, offset: number): string {
  const prefix = source.slice(0, offset);
  const line = prefix.split('\n').length;
  return `${line}:${offset - (prefix.lastIndexOf('\n') + 1)}`;
}

/** Partition at top-level statement boundaries so no mutant straddles a cut. */
function slices(file: string, source: string, budget: number): Slice[] {
  const parsed = parseSync(file, source);
  if (parsed.errors.length > 0)
    throw new Error(`Cannot shard ${file}: ${parsed.errors[0]!.message}`);
  const result: Slice[] = [];
  let start = 0;
  for (const statement of parsed.program.body) {
    if (statement.start > start && statement.end - start > budget) {
      result.push({ file, start, end: statement.start, source });
      start = statement.start;
    }
  }
  result.push({ file, start, end: source.length, source });
  return result;
}

/** Balance source ranges, including kernels whose entire source is one file. */
export function shardFiles(files: readonly string[], shard: Shard, root: string): string[] {
  const sources = files.map((file) => ({
    file,
    source: fs.readFileSync(path.join(root, file), 'utf8'),
  }));
  const budget = Math.ceil(
    sources.reduce((total, entry) => total + entry.source.length, 0) / shard.count,
  );
  const weighed = sources
    .flatMap(({ file, source }) => slices(file, source, budget))
    .sort(
      (a, b) =>
        b.end - b.start - (a.end - a.start) || a.file.localeCompare(b.file) || a.start - b.start,
    );
  const bins = Array.from({ length: shard.count }, () => ({ size: 0, slices: [] as Slice[] }));
  for (const slice of weighed) {
    const bin = bins.reduce((smallest, next) => (next.size < smallest.size ? next : smallest));
    bin.slices.push(slice);
    bin.size += slice.end - slice.start;
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
