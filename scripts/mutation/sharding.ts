import fs from 'node:fs';
import path from 'node:path';
import { parseSync } from 'oxc-parser';
import { Instrumenter } from '@stryker-mutator/instrumenter';

export type Shard = { index: number; count: number };

type Slice = { file: string; start: number; end: number; source: string; weight: number };

const silent = () => {};
const disabled = () => false;
const enabled = () => true;
const instrumenter = new Instrumenter({
  trace: silent,
  debug: silent,
  info: silent,
  warn: console.warn,
  error: console.error,
  fatal: console.error,
  isTraceEnabled: disabled,
  isDebugEnabled: disabled,
  isInfoEnabled: disabled,
  isWarnEnabled: enabled,
  isErrorEnabled: enabled,
  isFatalEnabled: enabled,
});

function position(source: string, offset: number): string {
  const prefix = source.slice(0, offset);
  const line = prefix.split('\n').length;
  return `${line}:${offset - (prefix.lastIndexOf('\n') + 1)}`;
}

/** Partition at top-level statement boundaries so no mutant straddles a cut. */
function slices(
  file: string,
  source: string,
  statements: readonly { start: number; weight: number }[],
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

/** Balance Stryker-generated mutations while retaining complete top-level statements. */
export async function shardFiles(
  files: readonly string[],
  shard: Shard,
  root: string,
  excludedMutations: readonly string[] = [],
): Promise<string[]> {
  const sources = files.map((file) => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const parsed = parseSync(file, source);
    if (parsed.errors.length > 0)
      throw new Error(`Cannot shard ${file}: ${parsed.errors[0]!.message}`);
    return { file, source, statements: parsed.program.body };
  });
  const generated = await instrumenter.instrument(
    sources.map(({ file, source }) => ({
      name: path.resolve(root, file),
      content: source,
      mutate: true,
    })),
    { excludedMutations: [...excludedMutations], ignorers: [] },
  );
  // Two groups per job give the packer room to spread mutation-dense files.
  const budget = Math.max(1, Math.ceil(generated.mutants.length / (shard.count * 2)));
  const weighed = sources
    .flatMap(({ file, source, statements }) => {
      const starts: number[] = [];
      let cursor = 0;
      for (const line of source.split('\n')) {
        starts.push(cursor);
        cursor += line.length + 1;
      }
      const offset = (location: { line: number; column: number }) =>
        starts[location.line]! + location.column;
      const mutants = generated.mutants.filter(
        (mutant) => mutant.fileName === path.resolve(root, file),
      );
      const weighted = statements.map((statement) => ({
        start: statement.start,
        weight: mutants.filter(
          (mutant) =>
            offset(mutant.location.start) >= statement.start &&
            offset(mutant.location.end) <= statement.end,
        ).length,
      }));
      if (weighted.reduce((sum, statement) => sum + statement.weight, 0) !== mutants.length)
        throw new Error(`Cannot shard ${file}: a mutation spans top-level statements`);
      return slices(file, source, weighted, budget).filter((slice) => slice.weight > 0);
    })
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
