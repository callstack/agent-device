import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTest } from '../../src/__tests__/test-utils/tmp-dir.ts';
import { parseConfig } from './benchmark-config.ts';
import { createBenchmarkStateRoot } from './state-ownership.ts';

test('proxy measurements retain the warm sample minimum', async () => {
  const stateDir = createBenchmarkStateRoot();
  const args = [
    '--mode',
    'proxy',
    '--udid',
    'simulator',
    '--state',
    'cold',
    '--state-dir',
    stateDir,
  ];
  assert.throws(() => parseConfig([...args, '--samples', '10']), /at least 20/);
  assert.equal(parseConfig([...args, '--samples', '20']).samples, 20);
});

test('unknown benchmark flags fail closed', async () => {
  const stateDir = createBenchmarkStateRoot();
  assert.throws(
    () => parseConfig(['--udid', 'simulator', '--state-dir', stateDir, '--unknown']),
    /Unknown option: --unknown/,
  );
});

test('derived data is confined to the owned benchmark state directory', async () => {
  const stateDir = createBenchmarkStateRoot();
  assert.doesNotThrow(() =>
    parseConfig([
      '--udid',
      'simulator',
      '--state-dir',
      stateDir,
      '--derived-path',
      path.join(stateDir, 'derived-data', 'cell'),
    ]),
  );
  assert.throws(
    () =>
      parseConfig([
        '--udid',
        'simulator',
        '--state-dir',
        stateDir,
        '--derived-path',
        path.join(stateDir, '..', 'unowned-derived-data'),
      ]),
    /descendant of the benchmark state directory/,
  );
});

test('caller-supplied state directories must already be benchmark-owned', async () => {
  const unmarked = await mkdtempForTest('agent-device-ios-benchmark-unmarked-');
  assert.throws(
    () => parseConfig(['--udid', 'simulator', '--state-dir', unmarked]),
    /not benchmark-owned/,
  );
  const stateDir = createBenchmarkStateRoot();
  assert.equal(parseConfig(['--udid', 'simulator', '--state-dir', stateDir]).stateDir, stateDir);
});
