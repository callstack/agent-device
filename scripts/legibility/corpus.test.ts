import assert from 'node:assert/strict';
import { test } from 'node:test';
import { miniCorpus } from './__fixtures__/mini-corpus.ts';

const corpus = miniCorpus();

test('families and file order come from the gate partition, sorted', () => {
  assert.deepEqual(corpus.families, ['(root)', 'alpha', 'beta']);
  assert.deepEqual(
    corpus.files.map((file) => file.id),
    [
      'packages/alpha/src/a.ts',
      'packages/alpha/src/b.ts',
      'src/beta/x.ts',
      'src/beta/y.ts',
      'src/beta/z.ts',
      'src/gamma.ts',
    ],
  );
  assert.equal(corpus.byId.get('src/gamma.ts')!.family, '(root)');
});

test('imports are value imports only, resolved to repository paths; externals are verbatim', () => {
  const a = corpus.byId.get('packages/alpha/src/a.ts')!;
  assert.deepEqual(a.imports, ['packages/alpha/src/b.ts']);
  assert.deepEqual(a.externals, ['node:fs']);
  const z = corpus.byId.get('src/beta/z.ts')!;
  assert.deepEqual(z.imports, ['packages/alpha/src/b.ts'], 'the dynamic import does not count');
  const gamma = corpus.byId.get('src/gamma.ts')!;
  assert.deepEqual(gamma.imports, ['src/beta/x.ts']);
  assert.deepEqual(gamma.externals, ['zod']);
  assert.deepEqual(corpus.byId.get('packages/alpha/src/b.ts')!.imports, []);
});

test('first-touch subjects are stripped, kept raw, and carry the rename flag', () => {
  assert.deepEqual(corpus.byId.get('packages/alpha/src/a.ts')!.firstTouch, {
    sha: 'c1',
    subject: 'add alpha module',
    rawSubject: 'feat(alpha): add alpha module (#1)',
    viaRename: false,
  });
  assert.equal(corpus.byId.get('src/beta/z.ts')!.firstTouch!.viaRename, true);
  assert.equal(corpus.byId.get('src/beta/y.ts')!.firstTouch, null);
});

test('test mirrors are attached per file', () => {
  assert.equal(corpus.byId.get('src/beta/x.ts')!.testMirror!.rule, 'sibling-tests');
  assert.equal(corpus.byId.get('src/beta/z.ts')!.testMirror, null);
});
