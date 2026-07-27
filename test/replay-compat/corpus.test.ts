import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReplayInput } from '../../src/compat/replay-input.ts';
import { AppError } from '../../src/kernel/errors.ts';
import {
  REPLAY_COMPAT_CORPUS,
  REPLAY_COMPAT_RELEASED_TAGS,
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

function readCorpusScript(entry: ReplayCompatEntry): Buffer {
  return readFileSync(join(CORPUS_DIR, entry.file));
}

/** Git's own object id for a blob, so a mined entry's bytes carry their history. */
function gitBlobId(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
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
  // The verdict is asserted through `parseReplayInput` — the same composition
  // (and the same ordering of the action parse and the metadata read) that
  // `replay`/`test` hit — so a multi-fault script reports the code and hint
  // production really surfaces, and moving the boundary breaks this gate.
  test.each(REPLAY_COMPAT_CORPUS.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    const script = readCorpusScript(entry).toString('utf8');
    if (entry.verdict.kind === 'parses') {
      expect(() => {
        parseReplayInput(script, undefined);
      }).not.toThrow();
      return;
    }
    let thrown: unknown;
    try {
      parseReplayInput(script, undefined);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, `expected ${entry.id} to fail parsing`).toBeInstanceOf(AppError);
    const error = thrown as AppError;
    expect(error.code).toBe(entry.verdict.code);
    expect(error.message).toContain(entry.verdict.hint);
  });

  // The freeze rule needs teeth: a mined entry's bytes must still hash to the
  // git object id of the blob it was mined from, so "update the script until the
  // parser agrees" cannot pass as a corpus update. `pnpm check:replay-compat`
  // re-derives the same ids from history, which this hash alone cannot do.
  test.each(REPLAY_COMPAT_CORPUS.map((entry) => [entry.id, entry] as const))(
    '%s is byte-identical to its pinned source',
    (_id, entry) => {
      const bytes = readCorpusScript(entry);
      if (entry.provenance.kind === 'mined') {
        expect(gitBlobId(bytes)).toBe(entry.provenance.blob);
        return;
      }
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.provenance.sha256);
    },
  );

  test('every corpus script is claimed by exactly one manifest entry', () => {
    const claimed = REPLAY_COMPAT_CORPUS.map((entry) => entry.file);
    expect([...claimed].sort()).toEqual(listCorpusScriptFiles().sort());
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  test('entry ids are unique and name a released producing version', () => {
    const ids = REPLAY_COMPAT_CORPUS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of REPLAY_COMPAT_CORPUS) {
      expect(REPLAY_COMPAT_RELEASED_TAGS, entry.id).toContain(entry.recordedBy);
      expect(entry.file, entry.id).toContain(`.${entry.recordedBy}.ad`);
    }
  });

  test('the corpus covers every compat surface it is required to freeze', () => {
    const covered = new Set(REPLAY_COMPAT_CORPUS.flatMap((entry) => entry.covers));
    expect([...covered].sort()).toEqual([...REQUIRED_COVERAGE].sort());
  });
});
