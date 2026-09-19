import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { familyNames, loadLegibilityInputs } from './load.ts';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

test('the live inputs cover the layering file set with coupling and scrub names per family', () => {
  const inputs = loadLegibilityInputs(repoRoot);
  assert.equal(inputs.corpus.files.length > 0, true);
  assert.deepEqual(inputs.corpus.families, [...inputs.corpus.families].sort());
  for (const family of inputs.corpus.families) {
    assert.equal(inputs.coupling.has(family), true, `coupling row for ${family}`);
    assert.equal(inputs.namesByFamily.get(family)!.includes(family), true, `names for ${family}`);
  }
  // Every file's evidence targets resolve inside the corpus, never to a test or a foreign path.
  for (const file of inputs.corpus.files) {
    for (const target of file.imports) {
      assert.equal(inputs.corpus.byId.has(target), true, `${file.id} -> ${target}`);
    }
  }
});

test('scrub names are the family ids only; a differing source folder stays visible', () => {
  const inputs = loadLegibilityInputs(repoRoot);
  const daemon = inputs.namesByFamily.get('daemon-server');
  if (daemon) assert.deepEqual(daemon, ['daemon-server']);
  assert.deepEqual(familyNames(inputs.corpus).get('(root)'), ['(root)']);
  assert.deepEqual([...familyNames(inputs.corpus).keys()], inputs.corpus.families);
});
