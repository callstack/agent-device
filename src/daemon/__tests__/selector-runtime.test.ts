import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { withAppleRunnerProvider } from '@agent-device/platform-apple/runner';
import type { SessionState } from '../types.ts';

const { mockRunAppleRunnerCommand } = vi.hoisted(() => ({
  mockRunAppleRunnerCommand: vi.fn(),
}));

import { queryDirectIosSelector } from '../direct-ios-selector.ts';

beforeEach(() => {
  mockRunAppleRunnerCommand.mockReset();
});

function makeSession(): SessionState {
  return { name: 'default', device: IOS_SIMULATOR, createdAt: Date.now(), actions: [] };
}

async function withRunner<T>(operation: () => Promise<T>): Promise<T> {
  return await withAppleRunnerProvider(
    mockRunAppleRunnerCommand,
    { deviceId: IOS_SIMULATOR.id },
    operation,
  );
}

// #1542: queryDirectIosSelector is the ONE querySelector client for the local
// XCTest runner — the offscreen refusal double-check probe
// (src/daemon/offscreen-target-probe.ts) reuses this exact function rather
// than opening a second client, so its request-shape and node-extraction
// contract is covered here, independent of any selector-runtime request.

test('queryDirectIosSelector: builds the querySelector runner command from key/value/appBundleId', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({ found: false, nodes: [] });
  const session = { ...makeSession(), appBundleId: 'com.example.demo' };

  await withRunner(() => queryDirectIosSelector(session, { key: 'id', value: 'submit-order' }, {}));

  const [device, command] = mockRunAppleRunnerCommand.mock.calls[0] ?? [];
  assert.equal(device, session.device);
  const { commandId: _commandId, ...commandWithoutId } = command as Record<string, unknown>;
  assert.deepEqual(commandWithoutId, {
    command: 'querySelector',
    selectorKey: 'id',
    selectorValue: 'submit-order',
    appBundleId: 'com.example.demo',
  });
});

test('queryDirectIosSelector: accepts a bare {key, value} selector — no `raw` field required', async () => {
  // The offscreen double-check derives a selector from a node's own
  // identifier/label (deriveDirectIosNodeSelector), which has no `raw`
  // string — this must type/run without one.
  mockRunAppleRunnerCommand.mockResolvedValue({
    found: true,
    nodes: [{ index: 0, rect: { x: 1, y: 2, width: 3, height: 4 }, hittable: true }],
  });

  const result = await withRunner(() =>
    queryDirectIosSelector(makeSession(), { key: 'label', value: 'Pickup' }, {}),
  );

  assert.equal(result.found, true);
  assert.deepEqual(result.node, {
    index: 0,
    rect: { x: 1, y: 2, width: 3, height: 4 },
    hittable: true,
  });
});

test('queryDirectIosSelector: found:false with no nodes reports not-found without a node', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({ found: false, nodes: [] });

  const result = await withRunner(() =>
    queryDirectIosSelector(makeSession(), { key: 'id', value: 'missing' }, {}),
  );

  assert.equal(result.found, false);
  assert.equal(result.node, undefined);
});

test('queryDirectIosSelector: surfaces text when the runner includes it', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({
    found: true,
    text: 'Ada Lovelace',
    nodes: [{ index: 0 }],
  });

  const result = await withRunner(() =>
    queryDirectIosSelector(makeSession(), { key: 'id', value: 'field-name' }, {}),
  );

  assert.equal(result.text, 'Ada Lovelace');
});

test('queryDirectIosSelector: propagates a runner AMBIGUOUS_MATCH rather than swallowing it', async () => {
  mockRunAppleRunnerCommand.mockRejectedValue(
    new AppError('AMBIGUOUS_MATCH', 'selector matched multiple elements'),
  );

  await assert.rejects(
    () =>
      withRunner(() =>
        queryDirectIosSelector(makeSession(), { key: 'label', value: 'Checkout form' }, {}),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'AMBIGUOUS_MATCH');
      return true;
    },
  );
});
