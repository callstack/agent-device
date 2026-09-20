import { expect, test, vi } from 'vitest';

import { ANDROID_EMULATOR } from '../__tests__/test-utils/device-fixtures.ts';
import type { RequestActivationProof } from './capture-disclosure.ts';
import { maybeWaitTimeoutSurfaceResponse } from './wait-current-surface.ts';
import type { BoundSelectorCapture } from './selector-capture-binding.ts';

const req = {
  command: 'wait',
  positionals: ['Agent Device Tester', '10000'],
  session: 'android-e2e',
  token: 'test-token',
};

/**
 * The decoration capture rides wait's own request binding (ADR 0019), so the fake binds there —
 * not on the `snapshot-capture` module — and "no capture started" is provable as "the binding
 * was never invoked".
 */
function boundCapture(nodes: { index: number; depth: number; type: string; label?: string }[]) {
  return vi.fn(async () => ({ nodes, backend: 'android' })) as unknown as BoundSelectorCapture &
    ReturnType<typeof vi.fn>;
}

test('deadline-truncated wait does not start a post-deadline diagnostic capture', async () => {
  const capture = boundCapture([]);
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
    { req, session: undefined, device: ANDROID_EMULATOR, capture },
    response,
  );

  expect(result).toBe(response);
  expect(capture).not.toHaveBeenCalled();
});

test('wait surface decoration requires a structured wait timeout reason', async () => {
  const capture = boundCapture([]);
  const response = {
    ok: false as const,
    error: {
      code: 'COMMAND_FAILED' as const,
      message: 'wait timed out for text: Agent Device Tester',
    },
  };

  const result = await maybeWaitTimeoutSurfaceResponse(
    { req, session: undefined, device: ANDROID_EMULATOR, capture },
    response,
  );

  expect(result).toBe(response);
  expect(capture).not.toHaveBeenCalled();
});

test('an absent-target wait describes the current surface through its own request binding', async () => {
  const capture = boundCapture([
    { index: 0, depth: 0, type: 'TextView', label: 'Checkout' },
    { index: 1, depth: 1, type: 'Button', label: 'Pay now' },
  ]);
  const response = {
    ok: false as const,
    error: {
      code: 'COMMAND_FAILED' as const,
      message: 'wait timed out for text: Agent Device Tester',
      details: { reason: 'wait_target_absent', timeoutMs: 10_000 },
    },
  };

  const result = await maybeWaitTimeoutSurfaceResponse(
    { req, session: undefined, device: ANDROID_EMULATOR, capture },
    response,
  );

  expect(capture).toHaveBeenCalledTimes(1);
  expect(capture.mock.calls[0]?.[0]).toMatchObject({
    options: { interactiveOnly: true },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.message).toContain('Current surface: Checkout, Pay now');
  expect(result.error.details?.currentSurface).toMatchObject({
    labels: ['Checkout', 'Pay now'],
    buttons: ['Pay now'],
  });
});

/**
 * The decoration capture is a real capture: when it is the command's own foreground repair, the
 * timed-out wait that reads this surface owes the disclosure, and the proof has to be recorded where
 * that capture happens (#2682).
 */
test('the decoration capture records the foreground repair it paid for', async () => {
  const repair = {
    reason: 'stale_target',
    priorState: 'runningBackground',
    otherActiveApplicationPid: 4562,
  };
  const capture = vi.fn(async () => ({
    backend: 'xctest',
    targetActivation: repair,
    nodes: [{ index: 0, depth: 0, type: 'Button', label: 'Receipt' }],
  })) as unknown as BoundSelectorCapture;
  const activationProof: RequestActivationProof = {};

  await maybeWaitTimeoutSurfaceResponse(
    { req, session: undefined, device: ANDROID_EMULATOR, capture, activationProof },
    {
      ok: false as const,
      error: {
        code: 'COMMAND_FAILED' as const,
        message: 'wait timed out for text: Agent Device Tester',
        details: { reason: 'wait_target_absent' },
      },
    },
  );

  expect(activationProof.state).toMatchObject({ targetActivation: repair });
});
