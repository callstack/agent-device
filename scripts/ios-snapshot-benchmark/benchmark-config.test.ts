import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtempForTest } from '../../src/__tests__/test-utils/tmp-dir.ts';
import { parseConfig } from './benchmark-config.ts';

test('proxy measurements retain the warm sample minimum', async () => {
  const stateDir = await mkdtempForTest('agent-device-ios-benchmark-config-');
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
  const stateDir = await mkdtempForTest('agent-device-ios-benchmark-config-');
  assert.throws(
    () => parseConfig(['--udid', 'simulator', '--state-dir', stateDir, '--unknown']),
    /Unknown option: --unknown/,
  );
});
