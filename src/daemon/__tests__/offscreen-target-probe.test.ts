import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import type { SessionState } from '../types.ts';

const { mockRunAppleRunnerCommand } = vi.hoisted(() => ({
  mockRunAppleRunnerCommand: vi.fn(),
}));

vi.mock('../../platforms/apple/core/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../platforms/apple/core/runner-client.ts')>();
  return { ...actual, runAppleRunnerCommand: mockRunAppleRunnerCommand };
});

import { confirmIosOffscreenTargetVisible } from '../offscreen-target-probe.ts';

beforeEach(() => {
  mockRunAppleRunnerCommand.mockReset();
});

function makeSession(): SessionState {
  return { name: 'default', device: IOS_SIMULATOR, createdAt: Date.now(), actions: [] };
}

const ROOT_VIEWPORT = { x: 0, y: 0, width: 402, height: 874 };

test('confirmIosOffscreenTargetVisible: returns the live rect when the runner confirms hittable + inside the viewport', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({
    found: true,
    nodes: [{ index: 0, rect: { x: 126, y: 136, width: 75, height: 38 }, hittable: true }],
  });

  const rect = await confirmIosOffscreenTargetVisible({
    session: makeSession(),
    node: { identifier: 'shipping-pickup' },
    rootViewport: ROOT_VIEWPORT,
    requestOptions: {},
  });

  assert.deepEqual(rect, { x: 126, y: 136, width: 75, height: 38 });
  assert.equal(mockRunAppleRunnerCommand.mock.calls[0]?.[1].selectorKey, 'id');
  assert.equal(mockRunAppleRunnerCommand.mock.calls[0]?.[1].selectorValue, 'shipping-pickup');
});

test('confirmIosOffscreenTargetVisible: null when the node has no usable id/label (never calls the runner)', async () => {
  const rect = await confirmIosOffscreenTargetVisible({
    session: makeSession(),
    node: {},
    rootViewport: ROOT_VIEWPORT,
    requestOptions: {},
  });

  assert.equal(rect, null);
  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 0);
});

test('confirmIosOffscreenTargetVisible: null when the runner reports not found', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({ found: false, nodes: [] });

  const rect = await confirmIosOffscreenTargetVisible({
    session: makeSession(),
    node: { label: 'Pickup' },
    rootViewport: ROOT_VIEWPORT,
    requestOptions: {},
  });

  assert.equal(rect, null);
});

test('confirmIosOffscreenTargetVisible: null on an ambiguous match / any runner error (fail closed)', async () => {
  mockRunAppleRunnerCommand.mockRejectedValue(
    new AppError('AMBIGUOUS_MATCH', 'selector matched multiple elements'),
  );

  const rect = await confirmIosOffscreenTargetVisible({
    session: makeSession(),
    node: { label: 'Checkout form' },
    rootViewport: ROOT_VIEWPORT,
    requestOptions: {},
  });

  assert.equal(rect, null);
});

test('confirmIosOffscreenTargetVisible: null when the live read is not hittable, even with a plausible rect', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({
    found: true,
    nodes: [{ index: 0, rect: { x: 126, y: 136, width: 75, height: 38 }, hittable: false }],
  });

  const rect = await confirmIosOffscreenTargetVisible({
    session: makeSession(),
    node: { identifier: 'shipping-pickup' },
    rootViewport: ROOT_VIEWPORT,
    requestOptions: {},
  });

  assert.equal(rect, null);
});

test('confirmIosOffscreenTargetVisible: null when the live rect is hittable but outside the root viewport', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({
    found: true,
    nodes: [{ index: 0, rect: { x: 5000, y: 5000, width: 75, height: 38 }, hittable: true }],
  });

  const rect = await confirmIosOffscreenTargetVisible({
    session: makeSession(),
    node: { identifier: 'shipping-pickup' },
    rootViewport: ROOT_VIEWPORT,
    requestOptions: {},
  });

  assert.equal(rect, null);
});
