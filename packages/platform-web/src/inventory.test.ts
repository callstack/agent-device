import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { PlatformRequestScope } from '@agent-device/contracts/platform';
import { createWebInventory } from './inventory.ts';

const scope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => undefined },
  progress: { report: () => undefined },
};

test('Web inventory exposes the established static browser target without host probing', async () => {
  assert.deepEqual(await createWebInventory().discover({}, scope), [
    {
      platform: 'web',
      id: 'agent-browser-chrome',
      name: 'Agent Browser Chrome',
      kind: 'device',
      target: 'desktop',
      booted: true,
    },
  ]);
});
