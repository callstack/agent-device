import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { ANDROID_EMULATOR, IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import type { SessionState } from '../types.ts';

const { mockRunAppleRunnerCommand } = vi.hoisted(() => ({
  mockRunAppleRunnerCommand: vi.fn(),
}));

vi.mock('../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, runAppleRunnerCommand: mockRunAppleRunnerCommand };
});

import {
  deriveDirectIosNodeSelector,
  isDirectIosSelectorFallbackError,
  isIosDirectElementReadEligible,
  readDirectIosElementProbe,
} from '../direct-ios-selector.ts';

beforeEach(() => {
  mockRunAppleRunnerCommand.mockReset();
});

function makeSession(platform: 'ios' | 'android' = 'ios'): SessionState {
  return {
    name: platform,
    device: platform === 'android' ? ANDROID_EMULATOR : IOS_SIMULATOR,
    createdAt: Date.now(),
    actions: [],
  };
}

test('runner ELEMENT_OFFSCREEN delegates normally but stays typed for Maestro replay', () => {
  const error = new AppError('ELEMENT_OFFSCREEN', 'element resolved off-screen at (-161, 265)');
  assert.equal(isDirectIosSelectorFallbackError(error), true);
  assert.equal(isDirectIosSelectorFallbackError(error, { allowElementNotFound: false }), true);
  assert.equal(isDirectIosSelectorFallbackError(error, { delegateSemanticFailures: true }), true);
  assert.equal(isDirectIosSelectorFallbackError(error, { delegateSemanticFailures: false }), false);
});

test('runner ELEMENT_NOT_FOUND falls back for query callers that allow it', () => {
  const error = new AppError('ELEMENT_NOT_FOUND', 'element not found');
  assert.equal(isDirectIosSelectorFallbackError(error), false);
  assert.equal(isDirectIosSelectorFallbackError(error, { allowElementNotFound: true }), true);
});

test('semantic failures delegate to the runtime path for interaction dispatches (ADR 0011)', () => {
  const notFound = new AppError('ELEMENT_NOT_FOUND', 'element not found');
  const ambiguous = new AppError('AMBIGUOUS_MATCH', 'multiple');
  assert.equal(
    isDirectIosSelectorFallbackError(notFound, { delegateSemanticFailures: true }),
    true,
  );
  assert.equal(
    isDirectIosSelectorFallbackError(ambiguous, { delegateSemanticFailures: true }),
    true,
  );
});

test('maestro replay dispatches preserve the runner semantic error shapes (no fallback)', () => {
  const notFound = new AppError('ELEMENT_NOT_FOUND', 'element not found');
  const ambiguous = new AppError('AMBIGUOUS_MATCH', 'multiple');
  assert.equal(
    isDirectIosSelectorFallbackError(notFound, { delegateSemanticFailures: false }),
    false,
  );
  assert.equal(
    isDirectIosSelectorFallbackError(ambiguous, { delegateSemanticFailures: false }),
    false,
  );
});

test('AMBIGUOUS_MATCH does not fall back on the query path (allowElementNotFound callers)', () => {
  const ambiguous = new AppError('AMBIGUOUS_MATCH', 'multiple');
  assert.equal(isDirectIosSelectorFallbackError(ambiguous), false);
  assert.equal(isDirectIosSelectorFallbackError(ambiguous, { allowElementNotFound: true }), false);
});

test('transport-level COMMAND_FAILED errors fall back, semantic ones do not', () => {
  assert.equal(
    isDirectIosSelectorFallbackError(new AppError('COMMAND_FAILED', 'fetch failed')),
    true,
  );
  assert.equal(
    isDirectIosSelectorFallbackError(
      new AppError('COMMAND_FAILED', 'Runner command deadline exceeded: timed out'),
    ),
    true,
  );
  assert.equal(
    isDirectIosSelectorFallbackError(new AppError('COMMAND_FAILED', 'element covered by overlay')),
    false,
  );
});

test('#1542 isIosDirectElementReadEligible: iOS local sessions are eligible, Android is not', () => {
  assert.equal(isIosDirectElementReadEligible(makeSession('ios')), true);
  assert.equal(isIosDirectElementReadEligible(makeSession('android')), false);
  assert.equal(isIosDirectElementReadEligible(undefined), false);
});

test('#1542 deriveDirectIosNodeSelector: prefers id, falls back to label, null when neither is usable', () => {
  assert.deepEqual(
    deriveDirectIosNodeSelector({ identifier: 'shipping-pickup', label: 'Pickup' }),
    {
      key: 'id',
      value: 'shipping-pickup',
    },
  );
  assert.deepEqual(deriveDirectIosNodeSelector({ label: 'Checkout form' }), {
    key: 'label',
    value: 'Checkout form',
  });
  assert.equal(deriveDirectIosNodeSelector({ identifier: '   ', label: '  ' }), null);
  assert.equal(deriveDirectIosNodeSelector({}), null);
});

test('#1542 readDirectIosElementProbe: returns the fresh rect + live hittable on a clean querySelector hit', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({
    found: true,
    nodes: [{ index: 0, rect: { x: 34, y: 136, width: 74, height: 37 }, hittable: true }],
  });

  const probe = await readDirectIosElementProbe(
    makeSession('ios'),
    { identifier: 'shipping-pickup' },
    {},
  );

  assert.deepEqual(probe, { rect: { x: 34, y: 136, width: 74, height: 37 }, hittable: true });
  assert.equal(mockRunAppleRunnerCommand.mock.calls[0]?.[1].command, 'querySelector');
  assert.equal(mockRunAppleRunnerCommand.mock.calls[0]?.[1].selectorKey, 'id');
  assert.equal(mockRunAppleRunnerCommand.mock.calls[0]?.[1].selectorValue, 'shipping-pickup');
});

test('#1542 readDirectIosElementProbe: hittable defaults to false when the runner omits it', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({
    found: true,
    nodes: [{ index: 0, rect: { x: 34, y: 900, width: 74, height: 37 } }],
  });

  const probe = await readDirectIosElementProbe(makeSession('ios'), { label: 'Pickup' }, {});

  assert.deepEqual(probe, { rect: { x: 34, y: 900, width: 74, height: 37 }, hittable: false });
});

test('#1542 readDirectIosElementProbe: fails closed (null) when the node has no id/label', async () => {
  const probe = await readDirectIosElementProbe(makeSession('ios'), {}, {});

  assert.equal(probe, null);
  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 0);
});

test('#1542 readDirectIosElementProbe: fails closed (null) when the runner reports not found', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({ found: false, nodes: [] });

  const probe = await readDirectIosElementProbe(makeSession('ios'), { label: 'Pickup' }, {});

  assert.equal(probe, null);
});

test('#1542 readDirectIosElementProbe: fails closed (null) on an ambiguous match / any runner error', async () => {
  mockRunAppleRunnerCommand.mockRejectedValue(
    new AppError('AMBIGUOUS_MATCH', 'selector matched multiple elements'),
  );

  const probe = await readDirectIosElementProbe(makeSession('ios'), { label: 'Pickup' }, {});

  assert.equal(probe, null);
});
