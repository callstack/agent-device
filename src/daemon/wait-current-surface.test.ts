import { beforeEach, expect, test, vi } from 'vitest';

const captureSnapshot = vi.hoisted(() => vi.fn());

vi.mock('./handlers/snapshot-capture.ts', () => ({ captureSnapshot }));

import { ANDROID_EMULATOR } from '../__tests__/test-utils/index.ts';
import { maybeWaitTimeoutSurfaceResponse } from './wait-current-surface.ts';

beforeEach(() => {
  captureSnapshot.mockReset();
});

test('deadline-truncated wait does not start a post-deadline diagnostic capture', async () => {
  const response = {
    ok: false as const,
    error: {
      code: 'COMMAND_FAILED' as const,
      message: 'wait timed out for text: Agent Device Tester',
      details: {
        reason: 'wait_deadline_exceeded',
        captureTruncated: true,
        timeoutMs: 10_000,
      },
    },
  };

  const result = await maybeWaitTimeoutSurfaceResponse(
    {
      req: {
        command: 'wait',
        positionals: ['Agent Device Tester', '10000'],
        session: 'android-e2e',
        token: 'test-token',
      },
      session: undefined,
      device: ANDROID_EMULATOR,
    },
    response,
  );

  expect(result).toBe(response);
  expect(captureSnapshot).not.toHaveBeenCalled();
});
