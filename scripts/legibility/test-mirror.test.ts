import assert from 'node:assert/strict';
import { test } from 'node:test';
import { targetDagZone } from '../layering/model.ts';
import { MINI_CORPUS_TESTS } from './__fixtures__/mini-corpus.ts';
import {
  familyRoot,
  indexTestFiles,
  mirroredProductionPath,
  resolveTestMirror,
} from './test-mirror.ts';

const index = indexTestFiles(MINI_CORPUS_TESTS);

test('resolves in priority order: same directory, sibling __tests__, family root', () => {
  assert.deepEqual(resolveTestMirror('packages/alpha/src/a.ts', index, targetDagZone), {
    path: 'packages/alpha/src/a.test.ts',
    basename: 'a.test.ts',
    foreign: false,
    rule: 'same-dir',
  });
  assert.deepEqual(resolveTestMirror('src/beta/x.ts', index, targetDagZone), {
    path: 'src/beta/__tests__/x.test.ts',
    basename: 'x.test.ts',
    foreign: false,
    rule: 'sibling-tests',
  });
  assert.deepEqual(resolveTestMirror('src/beta/y.ts', index, targetDagZone), {
    path: 'src/beta/test/deep/y.test.ts',
    basename: 'y.test.ts',
    foreign: false,
    rule: 'family-root',
  });
});

test('a same-basename test in another family is not a mirror', () => {
  assert.equal(resolveTestMirror('src/beta/z.ts', index, targetDagZone), null);
  assert.equal(resolveTestMirror('packages/alpha/src/b.ts', index, targetDagZone), null);
});

test('a (root) file mirrored under src/__tests__ is its own family, not foreign', () => {
  assert.deepEqual(resolveTestMirror('src/gamma.ts', index, targetDagZone), {
    path: 'src/__tests__/gamma.test.ts',
    basename: 'gamma.test.ts',
    foreign: false,
    rule: 'sibling-tests',
  });
  assert.equal(mirroredProductionPath('src/__tests__/gamma.test.ts'), 'src/gamma.test.ts');
  assert.equal(targetDagZone(mirroredProductionPath('src/__tests__/gamma.test.ts')), '(root)');
});

test('marks a match foreign when its mirrored location belongs to another family', () => {
  const daemon = indexTestFiles(['src/daemon/__tests__/shared.test.ts']);
  const familyOf = (file: string) => (file.startsWith('src/daemon/') ? 'daemon-server' : 'other');
  const mirror = resolveTestMirror('src/daemon/shared.ts', daemon, familyOf);
  assert.equal(mirror?.foreign, false);
  const elsewhere = resolveTestMirror('src/daemon/shared.ts', daemon, () =>
    Math.random().toString(),
  );
  assert.equal(elsewhere?.foreign, true);
});

test('family roots follow the package or folder the file lives in', () => {
  assert.equal(familyRoot('packages/alpha/src/deep/a.ts'), 'packages/alpha/src');
  assert.equal(familyRoot('src/beta/deep/x.ts'), 'src/beta');
  assert.equal(familyRoot('src/gamma.ts'), 'src');
});
