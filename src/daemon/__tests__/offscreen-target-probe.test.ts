import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_SIMULATOR } from '@agent-device/test-kit/device-fixtures';
import type {
  QuerySelectorInput,
  QuerySelectorResult,
} from '@agent-device/contracts/selector-observation-runtime';
import type { SessionState } from '../session-state.ts';

import { confirmIosOffscreenTargetVisible } from '../offscreen-target-probe.ts';

function makeSession(): SessionState {
  return { name: 'default', device: IOS_SIMULATOR, createdAt: Date.now(), actions: [] };
}

type ProbeQuery = (input: QuerySelectorInput) => Promise<QuerySelectorResult>;

function probeWith(querySelector: ProbeQuery, node: { identifier?: string; label?: string }) {
  return confirmIosOffscreenTargetVisible({
    session: makeSession(),
    node,
    rootViewport: ROOT_VIEWPORT,
    querySelector,
    execution: {},
  });
}

const ROOT_VIEWPORT = { x: 0, y: 0, width: 402, height: 874 };

function found(rect: { x: number; y: number; width: number; height: number }, hittable: boolean) {
  return async (): Promise<QuerySelectorResult> => ({ found: true, node: { rect, hittable } });
}

test('confirmIosOffscreenTargetVisible: returns the live rect when the owner confirms hittable + inside the viewport', async () => {
  const rect = await probeWith(found({ x: 126, y: 136, width: 75, height: 38 }, true), {
    identifier: 'shipping-pickup',
  });

  assert.deepEqual(rect, { x: 126, y: 136, width: 75, height: 38 });
});

test('confirmIosOffscreenTargetVisible: forwards the derived id/label selector and the session app scope', async () => {
  const querySelector = vi.fn<ProbeQuery>(found({ x: 1, y: 2, width: 3, height: 4 }, true));

  await confirmIosOffscreenTargetVisible({
    session: { ...makeSession(), appBundleId: 'com.example.demo' },
    node: { label: 'Pickup' },
    rootViewport: ROOT_VIEWPORT,
    querySelector,
    execution: { requestId: 'req-1' },
  });

  assert.deepEqual(querySelector.mock.calls[0]?.[0], {
    selector: { key: 'label', value: 'Pickup' },
    options: { appBundleId: 'com.example.demo' },
    execution: { requestId: 'req-1' },
  });
});

test('confirmIosOffscreenTargetVisible: a session without an app sends no options bag', async () => {
  const querySelector = vi.fn<ProbeQuery>(found({ x: 1, y: 2, width: 3, height: 4 }, true));

  await confirmIosOffscreenTargetVisible({
    session: makeSession(),
    node: { label: 'Pickup' },
    rootViewport: ROOT_VIEWPORT,
    querySelector,
    execution: {},
  });

  assert.equal('options' in (querySelector.mock.calls[0]?.[0] ?? {}), false);
});

test('confirmIosOffscreenTargetVisible: null when the node has no usable id/label (never calls the operation)', async () => {
  const querySelector = vi.fn<ProbeQuery>(found({ x: 1, y: 2, width: 3, height: 4 }, true));

  const rect = await confirmIosOffscreenTargetVisible({
    session: makeSession(),
    node: {},
    rootViewport: ROOT_VIEWPORT,
    querySelector,
    execution: {},
  });

  assert.equal(rect, null);
  assert.equal(querySelector.mock.calls.length, 0);
});

test('confirmIosOffscreenTargetVisible: null when the owner reports not found', async () => {
  const rect = await probeWith(async () => ({ found: false }), { label: 'Pickup' });

  assert.equal(rect, null);
});

test('confirmIosOffscreenTargetVisible: null on an ambiguous match / any owner error (fail closed)', async () => {
  const rect = await probeWith(
    async () => {
      throw new AppError('AMBIGUOUS_MATCH', 'selector matched multiple elements');
    },
    { label: 'Checkout form' },
  );

  assert.equal(rect, null);
});

test('confirmIosOffscreenTargetVisible: null when the live read is not hittable, even with a plausible rect', async () => {
  const rect = await probeWith(found({ x: 126, y: 136, width: 75, height: 38 }, false), {
    identifier: 'shipping-pickup',
  });

  assert.equal(rect, null);
});

test('confirmIosOffscreenTargetVisible: null when the live rect is hittable but outside the root viewport', async () => {
  const rect = await probeWith(found({ x: 5000, y: 5000, width: 75, height: 38 }, true), {
    identifier: 'shipping-pickup',
  });

  assert.equal(rect, null);
});

test('confirmIosOffscreenTargetVisible: null when the owner answers found without a usable node', async () => {
  const rect = await probeWith(async () => ({ found: true }) as QuerySelectorResult, {
    identifier: 'shipping-pickup',
  });

  assert.equal(rect, null);
});
