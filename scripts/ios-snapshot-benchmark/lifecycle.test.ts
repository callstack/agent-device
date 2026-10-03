import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseRunningAppPids } from './lifecycle.ts';

test('parses only exact UIKit application labels', () => {
  const output = [
    'PID Status Label',
    '1000\t0\tUIKitApplication:com.callstack.agentdevicelab[abc][rb-legacy]',
    '1001\t0\tUIKitApplication:com.callstack.agentdevicelab-extra[def][rb-legacy]',
    '1002\t0\tcom.apple.some-service',
  ].join('\n');
  assert.deepEqual(parseRunningAppPids(output, 'com.callstack.agentdevicelab'), [1000]);
});
