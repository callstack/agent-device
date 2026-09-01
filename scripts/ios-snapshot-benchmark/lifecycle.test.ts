import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTest } from '../../src/__tests__/test-utils/tmp-dir.ts';
import {
  assertOwnedDerivedPath,
  clearDerivedData,
  ensureBenchmarkOwner,
  parseRunningAppPids,
} from './lifecycle.ts';

test('parses only exact UIKit application labels', () => {
  const output = [
    'PID Status Label',
    '1000\t0\tUIKitApplication:com.callstack.agentdevicelab[abc][rb-legacy]',
    '1001\t0\tUIKitApplication:com.callstack.agentdevicelab-extra[def][rb-legacy]',
    '1002\t0\tcom.apple.some-service',
  ].join('\n');
  assert.deepEqual(parseRunningAppPids(output, 'com.callstack.agentdevicelab'), [1000]);
});

test('clears only a benchmark-owned derived-data descendant', async () => {
  const stateDir = await mkdtempForTest('agent-device-ios-benchmark-lifecycle-');
  const derivedPath = path.join(stateDir, 'derived-data', 'cold', 'quiet');
  ensureBenchmarkOwner(stateDir);
  fs.mkdirSync(derivedPath, { recursive: true });
  fs.writeFileSync(path.join(derivedPath, 'result'), 'fixture');
  clearDerivedData(derivedPath, stateDir);
  assert.equal(fs.existsSync(derivedPath), false);
  assert.throws(
    () => assertOwnedDerivedPath(path.join(stateDir, '..', 'outside'), stateDir),
    /descendant of the benchmark state directory/,
  );
});
