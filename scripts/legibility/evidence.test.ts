import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MINI_CORPUS_NAMES, miniCorpus } from './__fixtures__/mini-corpus.ts';
import {
  auditOwnFamilyLeaks,
  conditionLabel,
  evidenceLine,
  MAX_LEAK_RATE,
  READER_CONDITION,
  taskText,
  WITHHELD_CONDITION,
} from './evidence.ts';
import { createScrubber } from './redaction.ts';

const corpus = miniCorpus();
const scrubber = createScrubber([...MINI_CORPUS_NAMES.values()].flat());
const familyOf = (id: string) => corpus.byId.get(id)!.family;
const namesOf = (family: string) => MINI_CORPUS_NAMES.get(family)!;
const linesFor = (condition: Parameters<typeof evidenceLine>[1]) =>
  new Map(corpus.files.map((file) => [file.id, evidenceLine(file, condition, scrubber)]));

test('the reader condition shows real paths and the test basename, and never the own path', () => {
  const a = corpus.byId.get('packages/alpha/src/a.ts')!;
  assert.equal(
    evidenceLine(a, READER_CONDITION, scrubber),
    'imports: packages/alpha/src/b.ts | external: node:fs | test: a.test.ts | subject: add «x» module',
  );
  assert.ok(!evidenceLine(a, READER_CONDITION, scrubber).includes('a.ts |'));
});

test('the withheld condition is the reader line with every family name scrubbed out of the paths', () => {
  const a = corpus.byId.get('packages/alpha/src/a.ts')!;
  assert.equal(
    evidenceLine(a, WITHHELD_CONDITION, scrubber),
    'imports: packages/«x»/src/b.ts | external: node:fs | test: a.test.ts | subject: add «x» module',
  );
  const y = corpus.byId.get('src/beta/y.ts')!;
  assert.equal(
    evidenceLine(y, WITHHELD_CONDITION, scrubber),
    'imports: packages/«x»/src/b.ts, src/«x»/z.ts | external: (none) | test: y.test.ts | subject: (none)',
  );
});

test('the subject stays redacted under both conditions, since it narrates a change not a layout', () => {
  const a = corpus.byId.get('packages/alpha/src/a.ts')!;
  for (const condition of [READER_CONDITION, WITHHELD_CONDITION]) {
    assert.match(evidenceLine(a, condition, scrubber), /subject: add «x» module$/);
  }
});

test('the two conditions tell the model different things about what it may read', () => {
  assert.match(taskText(READER_CONDITION), /real repository paths/);
  assert.ok(!taskText(READER_CONDITION).includes('«x»'));
  assert.match(taskText(WITHHELD_CONDITION), /replaced by «x»/);
});

test('the leak-reference conditions relax exactly one rule each, on top of the reader line', () => {
  const a = corpus.byId.get('packages/alpha/src/a.ts')!;
  assert.match(
    evidenceLine(a, { ...READER_CONDITION, withTestDir: true }, scrubber),
    /test: packages\/alpha\/src\/a\.test\.ts \| subject: add «x» module$/,
  );
  assert.match(
    evidenceLine(a, { ...READER_CONDITION, rawSubject: true }, scrubber),
    /test: a\.test\.ts \| subject: feat\(alpha\): add alpha module \(#1\)$/,
  );
});

test('condition labels say which one is a score', () => {
  assert.equal(conditionLabel(READER_CONDITION), 'reader (scored)');
  assert.equal(conditionLabel(WITHHELD_CONDITION), 'name-withheld ablation (not a score)');
  assert.equal(
    conditionLabel({ ...READER_CONDITION, withTestDir: true, rawSubject: true }),
    'leak reference: reader (scored) + with-test-dir + raw-subject',
  );
});

test('a planted own-family subject is named by the audit and gone once names are withheld', () => {
  const raw = linesFor({ ...READER_CONDITION, rawSubject: true });
  const leak = auditOwnFamilyLeaks(raw, familyOf, namesOf);
  // Real paths carry the family by design here; the raw subject adds more. `(root)` reduces to
  // the word "root", so "gamma at the repo root" leaks it too.
  assert.deepEqual(leak.leaking, [
    'packages/alpha/src/a.ts',
    'packages/alpha/src/b.ts',
    'src/beta/x.ts',
    'src/beta/y.ts',
    'src/gamma.ts',
  ]);
  assert.equal(leak.files, 6);
  assert.equal(leak.rate, 5 / 6);
  assert.equal(leak.rate > MAX_LEAK_RATE, true);

  assert.deepEqual(auditOwnFamilyLeaks(linesFor(WITHHELD_CONDITION), familyOf, namesOf), {
    files: 6,
    leaking: [],
    rate: 0,
  });
});

test('the reader audit measures name echo rather than a defect', () => {
  const echo = auditOwnFamilyLeaks(linesFor(READER_CONDITION), familyOf, namesOf);
  // Paths carry the family, which is what the echo rate counts; the subject does not leak.
  assert.deepEqual(echo.leaking, ['packages/alpha/src/a.ts', 'src/beta/x.ts', 'src/beta/y.ts']);
  assert.equal(echo.rate > MAX_LEAK_RATE, true);
});
