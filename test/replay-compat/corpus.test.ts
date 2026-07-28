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
import { findProvenanceKindViolations, requiredProvenanceKind } from './provenance-rules.ts';

const CORPUS_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * Every historical surface the corpus exists to hold still. Keyed by the coverage
 * union so the typechecker — not a hand-kept list — forces a new surface to be
 * required here; a tag with no entry means the corpus stopped covering a compat
 * surface #1417 named.
 */
const REQUIRED_COVERAGE_KEYS: Record<ReplayCompatCoverage, true> = {
  'context-header': true,
  'env-vars': true,
  quoting: true,
  'retired-gesture': true,
  'target-annotation': true,
  'wait-landmark': true,
};

const REQUIRED_COVERAGE = Object.keys(REQUIRED_COVERAGE_KEYS) as ReplayCompatCoverage[];

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

  // Reclassifying a mined entry as `derived` would let edited bytes be re-pinned
  // by digest inside this same manifest and skipped by the historical verifier,
  // so the corpus area — not the manifest line — fixes the kind.
  test('provenance kind is fixed by corpus area', () => {
    expect(findProvenanceKindViolations(REPLAY_COMPAT_CORPUS)).toEqual([]);
    for (const entry of REPLAY_COMPAT_CORPUS) {
      expect(entry.provenance.kind, entry.id).toBe(requiredProvenanceKind(entry.file));
    }
  });

  test('a mined entry relabelled as derived is rejected', () => {
    const mined = REPLAY_COMPAT_CORPUS.find((entry) => entry.provenance.kind === 'mined');
    expect(mined).toBeDefined();
    const reclassified: ReplayCompatEntry = {
      ...(mined as ReplayCompatEntry),
      provenance: { kind: 'derived', from: 'hand-written', sha256: 'f'.repeat(64) },
    };
    expect(findProvenanceKindViolations([reclassified])).toHaveLength(1);
    expect(findProvenanceKindViolations([reclassified])[0]).toContain('must stay "mined"');
  });

  test('a corpus area with no declared provenance kind is rejected', () => {
    expect(() => requiredProvenanceKind('scripts/handwritten/whatever.v0.20.0.ad')).toThrow(
      /no declared provenance kind/,
    );
  });

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

  // The corpus is a parser-compat suite, not a device matrix: every entry must
  // say which form or refusal it is the sole witness of, and the count stays a
  // reviewable set of deliberate entries rather than a mirror of the replay
  // fixtures. Raising the ceiling is allowed; doing it silently is not.
  //
  // 30 is headroom over the 22 witnesses the shipped grammar needs today: enough
  // for the next few retirements without another pruning pass, small enough that
  // a re-mirrored fixture tree (52 entries at first cut) cannot land quietly.
  test('every entry states why it exists, and the corpus stays small', () => {
    for (const entry of REPLAY_COMPAT_CORPUS) {
      expect(entry.note.trim(), entry.id).not.toBe('');
    }
    expect(REPLAY_COMPAT_CORPUS.length).toBeLessThanOrEqual(30);
  });

  test('the corpus covers every compat surface it is required to freeze', () => {
    const covered = new Set(REPLAY_COMPAT_CORPUS.flatMap((entry) => entry.covers));
    expect([...covered].sort()).toEqual([...REQUIRED_COVERAGE].sort());
  });
});
