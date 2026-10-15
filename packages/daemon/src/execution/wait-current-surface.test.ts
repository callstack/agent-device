import { expect, test, vi } from 'vitest';

import { ANDROID_EMULATOR } from '@agent-device/test-kit/device-fixtures';
import type { RequestCaptureProof } from '../core/capture-disclosure.ts';
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
function boundCapture(nodes: readonly Record<string, unknown>[]) {
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

test('the surface summary prefers content labels over chrome and identifier noise', async () => {
  const capture = boundCapture([
    {
      index: 0,
      depth: 0,
      type: 'XCUIElementTypeApplication',
      label: 'Expo Go',
      rect: { x: 0, y: 0, width: 393, height: 852 },
    },
    {
      index: 1,
      depth: 1,
      type: 'XCUIElementTypeImage',
      label: 'gearshape.fill',
      rect: { x: 12, y: 54, width: 24, height: 24 },
    },
    {
      index: 2,
      depth: 1,
      type: 'XCUIElementTypeOther',
      label: 'Tab Bar',
      rect: { x: 0, y: 760, width: 393, height: 92 },
    },
    {
      index: 3,
      depth: 1,
      type: 'XCUIElementTypeStaticText',
      label: 'Confirm catalog refresh',
      rect: { x: 48, y: 280, width: 297, height: 36 },
    },
    {
      index: 4,
      depth: 1,
      type: 'XCUIElementTypeButton',
      label: 'Keep browsing',
      rect: { x: 48, y: 360, width: 297, height: 48 },
    },
    {
      index: 5,
      depth: 1,
      type: 'XCUIElementTypeButton',
      identifier: 'host.exp.exponent:id/reload_button',
      rect: { x: 260, y: 54, width: 48, height: 48 },
    },
  ]);

  const result = await maybeWaitTimeoutSurfaceResponse(
    { req, session: undefined, device: ANDROID_EMULATOR, capture },
    {
      ok: false as const,
      error: {
        code: 'COMMAND_FAILED' as const,
        message: 'wait timed out for text: Impossible success text',
        details: { reason: 'wait_target_absent' },
      },
    },
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.message).toBe(
    'wait timed out for text: Impossible success text. Current surface: Confirm catalog refresh, Keep browsing.',
  );
  expect(result.error.details?.currentSurface).toEqual({
    labels: [
      'Confirm catalog refresh',
      'Keep browsing',
      'host.exp.exponent:id/reload_button',
      'Expo Go',
      'gearshape.fill',
      'Tab Bar',
    ],
    buttons: ['Keep browsing', 'host.exp.exponent:id/reload_button'],
  });
});

test('a capture-stalled wait failure is returned untouched without inspecting the surface', async () => {
  const capture = boundCapture([]);
  const response = {
    ok: false as const,
    error: {
      code: 'COMMAND_FAILED' as const,
      message: 'wait timed out for text: Receipt uploaded',
      details: { reason: 'wait_capture_stalled', retriable: true, readableCaptures: 0 },
    },
  };

  const result = await maybeWaitTimeoutSurfaceResponse(
    { req, session: undefined, device: ANDROID_EMULATOR, capture },
    response,
  );

  expect(result).toBe(response);
  expect(capture).not.toHaveBeenCalled();
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
  const captureProof: RequestCaptureProof = {};

  await maybeWaitTimeoutSurfaceResponse(
    { req, session: undefined, device: ANDROID_EMULATOR, capture, captureProof },
    {
      ok: false as const,
      error: {
        code: 'COMMAND_FAILED' as const,
        message: 'wait timed out for text: Agent Device Tester',
        details: { reason: 'wait_target_absent' },
      },
    },
  );

  expect(captureProof.targetActivation).toEqual(repair);
});
