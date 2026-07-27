// Failure reporting for the parser fuzz lane (#1414).
//
// A nightly failure has to be actionable from the run log alone, so every failing case is
// written as an artifact and printed with two copy-pasteable commands: one that reproduces it
// and one that promotes it into the checked-in corpus the unit lane replays.

import fs from 'node:fs';
import path from 'node:path';
import { appendToCorpus, type CorpusEntry } from './corpus.ts';
import { describeFailure, type FuzzFailure } from './invariant.ts';

export type ReportedFailure = FuzzFailure & { artifact?: string };

function writeArtifact(artifactDir: string, failure: FuzzFailure, ordinal: number): string {
  fs.mkdirSync(artifactDir, { recursive: true });
  const file = path.join(artifactDir, `${failure.target}-${failure.kind}-${ordinal}.json`);
  fs.writeFileSync(file, `${JSON.stringify(failure, null, 2)}\n`);
  return file;
}

function corpusEntryFor(failure: FuzzFailure): CorpusEntry {
  return {
    target: failure.target,
    input: failure.input,
    note: `${failure.kind}: ${failure.detail}`,
  };
}

/** Writes an artifact per failure and prints repro + promote commands. */
export function reportFailures(
  failures: readonly FuzzFailure[],
  artifactDir: string,
): { reported: ReportedFailure[]; reproCommands: string[] } {
  if (failures.length === 0) return { reported: [], reproCommands: [] };
  process.stdout.write(`\n${failures.length} invariant violation(s):\n`);
  const reported: ReportedFailure[] = [];
  const reproCommands: string[] = [];
  failures.forEach((failure, ordinal) => {
    const artifact = writeArtifact(artifactDir, failure, ordinal);
    const repro = `pnpm fuzz:parsers --input-file ${artifact}`;
    reproCommands.push(repro);
    reported.push({ ...failure, artifact });
    process.stdout.write(`\n${describeFailure(failure)}\n`);
    process.stdout.write(`  input:    ${JSON.stringify(failure.input)}\n`);
    process.stdout.write(`  repro:    ${repro}\n`);
    process.stdout.write(`  promote:  ${repro} --append-corpus\n`);
  });
  return { reported, reproCommands };
}

/** Appends failing cases to the checked-in corpus, printing what was added. */
export function promoteFailures(failures: readonly FuzzFailure[]): CorpusEntry[] {
  if (failures.length === 0) return [];
  const added = appendToCorpus(failures.map(corpusEntryFor));
  process.stdout.write(
    added.length === 0
      ? '\nRegression corpus already contains every failing case.\n'
      : `\nAppended ${added.length} case(s) to the regression corpus.\n`,
  );
  return added;
}
