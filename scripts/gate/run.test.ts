// The runner resolves a CheckId to the registry's command and forwards the rest.

import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveGate } from './run.ts';

const scripts = {
  lint: 'oxlint .',
  'check:fallow': 'fallow audit',
  'test:replay:macos': 'node src/bin.ts test test/integration/replays/macos',
};

test('a registered gate resolves to its package script', () => {
  assert.deepEqual(resolveGate('lint', scripts, []), ['pnpm', 'run', 'lint']);
});

test('lane-specific flags are forwarded verbatim, with or without a `--` separator', () => {
  const expected = ['pnpm', 'run', 'test:replay:macos', '--retries', '2'];
  assert.deepEqual(resolveGate('replay-macos', scripts, ['--retries', '2']), expected);
  assert.deepEqual(resolveGate('replay-macos', scripts, ['--', '--retries', '2']), expected);
});

test('a lane supplying --base replaces the default rather than passing it twice', () => {
  assert.deepEqual(resolveGate('fallow', scripts, ['--base', 'origin/release']), [
    'pnpm',
    'run',
    'check:fallow',
    '--base',
    'origin/release',
  ]);
  assert.deepEqual(resolveGate('fallow', scripts, []), [
    'pnpm',
    'run',
    'check:fallow',
    '--base',
    'origin/main',
  ]);
});

test('an unknown gate fails loudly and lists what is registered', () => {
  assert.throws(
    () => resolveGate('laering', scripts, []),
    (error: Error) => {
      assert.match(error.message, /Unknown gate "laering"/);
      assert.match(error.message, /Registered gates: .*\blayering\b/);
      return true;
    },
  );
});

test('a registered check whose script was renamed away fails instead of silently skipping', () => {
  assert.throws(
    () => resolveGate('lint', { 'lint:new': 'oxlint .' }, []),
    /references package.json script "lint", which does not exist/,
  );
});
