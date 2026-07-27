// The checked-in regression corpus for the parser fuzz lane (#1414).
//
// Every input the fuzzer ever catches is appended here and replayed by the unit lane
// (scripts/fuzz/corpus-replay.test.ts), so a fixed parser stays fixed without waiting for
// the nightly to rediscover the case. Entries are sorted and deduplicated on write, which
// keeps the diff of an append small and the replay order deterministic.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FuzzTargetName } from './target-types.ts';

export type CorpusEntry = {
  target: FuzzTargetName;
  /** The failing input, verbatim. */
  input: string;
  /** Why it was added — the invariant it broke, or where it came from. */
  note: string;
};

// AGENT_DEVICE_FUZZ_CORPUS retargets the corpus file so the harness's own tests can exercise
// the real promotion path against a scratch file instead of mutating the checked-in one.
const CORPUS_PATH =
  process.env.AGENT_DEVICE_FUZZ_CORPUS ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'corpus', 'regressions.json');

export function readCorpus(corpusPath = CORPUS_PATH): CorpusEntry[] {
  const raw = fs.readFileSync(corpusPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${corpusPath} must contain a JSON array.`);
  return parsed.map((entry, index) => readEntry(entry, index, corpusPath));
}

function readEntry(entry: unknown, index: number, corpusPath: string): CorpusEntry {
  if (entry === null || typeof entry !== 'object') {
    throw new Error(`${corpusPath}[${index}] must be an object.`);
  }
  const record = entry as Record<string, unknown>;
  const { target, input, note } = record;
  if (typeof target !== 'string' || typeof input !== 'string' || typeof note !== 'string') {
    throw new Error(`${corpusPath}[${index}] needs string target, input, and note fields.`);
  }
  return { target: target as FuzzTargetName, input, note };
}

function entryKey(entry: CorpusEntry): string {
  return `${entry.target}\u0000${entry.input}`;
}

/** Merges `additions` into the corpus file. Returns the entries actually added. */
export function appendToCorpus(
  additions: readonly CorpusEntry[],
  corpusPath = CORPUS_PATH,
): CorpusEntry[] {
  const existing = readCorpus(corpusPath);
  const seen = new Set(existing.map(entryKey));
  const added = additions.filter((entry) => {
    if (seen.has(entryKey(entry))) return false;
    seen.add(entryKey(entry));
    return true;
  });
  if (added.length === 0) return [];
  const merged = [...existing, ...added].sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
  fs.writeFileSync(corpusPath, `${JSON.stringify(merged, null, 2)}\n`);
  return added;
}
