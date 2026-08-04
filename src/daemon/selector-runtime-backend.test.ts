import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { createSelectorRuntimeForDevice } from './selector-runtime-backend.ts';
import { SessionStore } from './session-store.ts';
import type { SessionState } from './types.ts';
import { mkdtempForTestSync } from '../__tests__/test-utils/tmp-dir.ts';

vi.mock('../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../platforms/apple/core/runner/runner-client.ts')>();
  return {
    ...actual,
    runAppleRunnerCommand: vi.fn(async () => ({ found: false })),
  };
});

import { runAppleRunnerCommand } from '../platforms/apple/core/runner/runner-client.ts';

const mockRunnerCommand = vi.mocked(runAppleRunnerCommand);
const device: SessionState['device'] = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone Simulator',
  kind: 'simulator',
  booted: true,
};

beforeEach(() => {
  mockRunnerCommand.mockReset();
});

test('wait text passes its poll deadline signal to the Apple runner fast path', async () => {
  const sessionName = 'ios-wait-deadline';
  const sessionStore = new SessionStore(
    path.join(mkdtempForTestSync('selector-runtime-'), 'sessions'),
  );
  const session: SessionState = {
    name: sessionName,
    device,
    appBundleId: 'com.example.fixture',
    createdAt: Date.now(),
    actions: [],
  };
  sessionStore.set(sessionName, session);
  let observedSignal: AbortSignal | undefined;
  mockRunnerCommand.mockImplementation(
    async (_device, _command, options) =>
      await new Promise((resolve) => {
        observedSignal = options?.signal;
        if (options?.signal?.aborted) {
          resolve({ found: false });
          return;
        }
        options?.signal?.addEventListener('abort', () => resolve({ found: false }), { once: true });
      }),
  );
  const runtime = createSelectorRuntimeForDevice({
    req: {
      token: 't',
      session: sessionName,
      command: 'wait',
      positionals: ['Never appears', '10'],
      flags: {},
    },
    sessionName,
    sessionStore,
    session,
    device,
  });

  await expect(
    runtime.selectors.waitForText('Never appears', { session: sessionName, timeoutMs: 10 }),
  ).rejects.toThrow(/timed out/i);
  expect(observedSignal).toBeDefined();
  expect(observedSignal?.aborted).toBe(true);
});
