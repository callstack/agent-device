import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend, BackendSnapshotResult } from '@agent-device/contracts/backend';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import { createMemorySessionStore } from '../../../command-runtime/runtime-factory.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import { createAgentDevice } from '../../../runtime.ts';
import { ref, selector } from './selector-read-utils.ts';
import {
  buttonSnapshot,
  createFakeClock,
  createSettleDevice,
  welcomeSnapshot,
} from './__tests__/settle-device-fixtures.ts';

test('a stalled settle capture receives its deadline signal and the press still succeeds', async () => {
  const before = buttonSnapshot();
  let captureCalls = 0;
  let observedAbort = false;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: (context) => {
        captureCalls += 1;
        if (captureCalls === 1) return Promise.resolve({ snapshot: before });
        return new Promise<BackendSnapshotResult>((_resolve, reject) => {
          assert.ok(context.signal);
          context.signal.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              reject(context.signal?.reason);
            },
            { once: true },
          );
        });
      },
      tap: async () => ({ ok: true }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot: before }]),
    policy: localCommandPolicy(),
    clock: createFakeClock(),
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    settle: { quietMs: 25, timeoutMs: 75 },
  });

  assert.equal(result.kind, 'selector');
  assert.ok(result.settle);
  assert.equal(result.settle.settled, false);
  assert.equal(result.settle.diff, undefined);
  assert.match(result.settle.hint ?? '', /capture stalled past the settle budget/i);
  assert.equal(observedAbort, true);
});

test('fill on a @ref with --settle carries the settle observation on its result', async () => {
  const before = buttonSnapshot();
  const after = welcomeSnapshot();
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? before : after };
    },
  });

  const result = await device.interactions.fill(ref('@e1'), 'hello', {
    session: 'default',
    settle: {},
  });

  assert.equal(result.kind, 'ref');
  assert.ok(result.settle);
  assert.equal(result.settle.settled, true);
  assert.ok(result.settle.diff);
});
