import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend } from '../../../backend.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
} from '../../../runtime.ts';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const authority of ['runtime', 'command'] as const) {
  test(`duration wait observes ${authority} cancellation`, async () => {
    const controller = new AbortController();
    const sleepStarted = deferred();
    const releaseSleep = deferred();
    const reason = new Error(`${authority} wait canceled`);
    const device = createAgentDevice({
      backend: { platform: 'ios' } satisfies AgentDeviceBackend,
      artifacts: createLocalArtifactAdapter(),
      sessions: createMemorySessionStore(),
      policy: localCommandPolicy(),
      clock: {
        now: () => 0,
        sleep: async () => {
          sleepStarted.resolve();
          await releaseSleep.promise;
        },
      },
      ...(authority === 'runtime' ? { signal: controller.signal } : {}),
    });

    const waiting = device.selectors.wait({
      target: { kind: 'sleep', durationMs: 1_000 },
      ...(authority === 'command' ? { signal: controller.signal } : {}),
    });
    await sleepStarted.promise;
    controller.abort(reason);
    releaseSleep.resolve();

    await assert.rejects(waiting, (error) => error === reason);
  });
}
