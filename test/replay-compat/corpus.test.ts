import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../../src/kernel/errors.ts';
import { parseReplayScriptDetailed, readReplayScriptMetadata } from '../../src/replay/script.ts';
import {
  REPLAY_COMPAT_CORPUS,
  type ReplayCompatCoverage,
  type ReplayCompatEntry,
} from './manifest.ts';

const CORPUS_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * Every historical surface the corpus exists to hold still. A coverage tag with
 * no entry means the corpus stopped covering a compat surface #1417 named.
 */
const REQUIRED_COVERAGE: ReplayCompatCoverage[] = [
  'context-header',
  'env-vars',
  'quoting',
  'retired-gesture',
  'target-annotation',
  'wait-landmark',
];

function readCorpusScript(entry: ReplayCompatEntry): string {
  return readFileSync(join(CORPUS_DIR, entry.file), 'utf8');
}

/** The whole parse surface a `.ad` file meets before replay executes anything. */
function parseCorpusScript(script: string): void {
  readReplayScriptMetadata(script);
  parseReplayScriptDetailed(script);
}

function listCorpusScriptFiles(): string[] {
  const areas = readdirSync(join(CORPUS_DIR, 'scripts'), { withFileTypes: true });
  return areas.flatMap((area) =>
    readdirSync(join(CORPUS_DIR, 'scripts', area.name))
      .filter((name) => name.endsWith('.ad'))
      .map((name) => `scripts/${area.name}/${name}`),
  );
}

describe('replay-compat corpus', () => {
  test.each(REPLAY_COMPAT_CORPUS.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    const script = readCorpusScript(entry);
    if (entry.verdict.kind === 'parses') {
      expect(() => {
        parseCorpusScript(script);
      }).not.toThrow();
      return;
    }
    let thrown: unknown;
    try {
      parseCorpusScript(script);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, `expected ${entry.id} to fail parsing`).toBeInstanceOf(AppError);
    const error = thrown as AppError;
    expect(error.code).toBe(entry.verdict.code);
    expect(error.message).toContain(entry.verdict.hint);
  });

  test('every corpus script is claimed by exactly one manifest entry', () => {
    const claimed = REPLAY_COMPAT_CORPUS.map((entry) => entry.file);
    expect([...claimed].sort()).toEqual(listCorpusScriptFiles().sort());
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  test('entry ids are unique and name the producing released version', () => {
    const ids = REPLAY_COMPAT_CORPUS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of REPLAY_COMPAT_CORPUS) {
      expect(entry.recordedBy, entry.id).toMatch(/^v\d+\.\d+\.\d+$/);
      expect(entry.source, entry.id).toContain(entry.recordedBy);
      expect(entry.file, entry.id).toContain(`.${entry.recordedBy}.ad`);
    }
  });

  test('the corpus covers every compat surface it is required to freeze', () => {
    const covered = new Set(REPLAY_COMPAT_CORPUS.flatMap((entry) => entry.covers));
    expect([...covered].sort()).toEqual([...REQUIRED_COVERAGE].sort());
  });
});
