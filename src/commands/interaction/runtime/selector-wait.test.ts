import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend, BackendSnapshotOptions } from '../../../backend.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
} from '../../../runtime.ts';
import { makeSnapshotState } from '../../../__tests__/test-utils/index.ts';
import { createSelectorDevice, selectorReadSnapshot } from './__tests__/test-utils/index.ts';

test('runtime focused selector waits against a full snapshot', async () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Cell',
      label: 'Profiles and Accounts',
      focused: true,
    },
  ]);
  let captureOptions: BackendSnapshotOptions | undefined;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async (_context, options) => {
        captureOptions = options;
        return { snapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
  });

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'selector', selector: 'focused=true', timeoutMs: 1000 },
  });

  assert.equal(result.kind, 'selector');
  assert.equal(result.selector, 'focused=true');
  assert.equal(result.waitedMs >= 0, true);
  assert.equal(captureOptions?.interactiveOnly, false);
});

test('runtime wait can use backend text search', async () => {
  const device = createSelectorDevice(selectorReadSnapshot(), {
    findText: true,
    now: 10,
  });

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'text', text: 'Ready', timeoutMs: 100 },
  });

  assert.deepEqual(result, { kind: 'text', text: 'Ready', waitedMs: 0 });
});
