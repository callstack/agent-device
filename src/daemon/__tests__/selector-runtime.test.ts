import { beforeEach, expect, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { withAppleRunnerProvider } from '@agent-device/platform-apple/runner';
import type { SessionState } from '../session-state.ts';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import {
  snapshotRuntimeOperationFacts,
  type SnapshotResult,
} from '@agent-device/contracts/snapshot-runtime';
import { createUnavailableRuntimeFactsForTest } from '../../__tests__/test-utils/runtime-operation-facts.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { makeSession as makeStoredSession } from '../../__tests__/test-utils/session-factories.ts';
import { dispatchGetViaRuntime } from '../selector-runtime.ts';

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

test.each(['rebuild', 'retire'] as const)(
  'get text records in its captured lifetime after a held native read across %s',
  async (transition) => {
    const store = makeSessionStore();
    const address = 'cwd:held-get:default';
    const device = {
      platform: 'web',
      id: 'web',
      name: 'Web',
      kind: 'device',
      booted: true,
    } as const;
    const ref = store.publish(address, makeStoredSession('default', { device }));
    const owner = localRuntimeOwner('web');
    const base = createUnavailableRuntimeFactsForTest(device, owner);
    const available = { available: true } as const;
    const facts = {
      ...base,
      operations: {
        ...base.operations,
        ...snapshotRuntimeOperationFacts({
          capture: available,
          customActions: available,
          withoutActiveApp: available,
        }),
        readTextAtPoint: available,
      },
    };
    let startRead!: () => void;
    let releaseRead!: () => void;
    const reading = new Promise<void>((resolve) => {
      startRead = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const capture = async (): Promise<SnapshotResult> => ({
      backend: 'web',
      producer: 'agent-browser',
      nodes: [
        { index: 0, type: 'Window', rect: { x: 0, y: 0, width: 400, height: 800 } },
        {
          index: 1,
          parentIndex: 0,
          type: 'TextField',
          label: 'Input',
          rect: { x: 20, y: 20, width: 80, height: 30 },
          hittable: true,
        },
      ],
    });
    const binding: DeviceBinding<PlatformRuntimeOperations> = {
      device,
      owner,
      facts,
      operations: {
        captureSnapshot: capture,
        captureSnapshotWithCustomActions: capture,
        captureSnapshotWithoutActiveApp: capture,
        readTextAtPoint: async () => {
          startRead();
          await released;
          return { status: 'read', text: 'Native value' };
        },
      },
      [Symbol.asyncDispose]: async () => {},
    };
    const running = dispatchGetViaRuntime({
      req: {
        token: 't',
        session: 'default',
        command: 'get',
        positionals: ['text', 'label="Input"'],
        flags: {},
      },
      sessionName: address,
      sessionStore: store,
      inspectFacts: async () => facts,
      bindDevice: async (_device, use) => narrowDeviceBinding(binding, use),
    });
    await reading;
    let current = ref.session;
    if (transition === 'rebuild')
      current = store.update(ref, { actions: [], appName: 'Rebuilt during read' });
    else {
      store.retire(ref);
      current = store.publish(address, makeStoredSession('default', { device })).session;
    }
    releaseRead();
    const response = await running;
    if (transition === 'rebuild') {
      expect(response).toMatchObject({ ok: true, data: { text: 'Native value' } });
      expect(current.actions.map((action) => action.command)).toEqual(['get']);
      expect(current.appName).toBe('Rebuilt during read');
      expect(ref.session.actions).toEqual([]);
    } else {
      expect(response).toMatchObject({ ok: true, data: { text: 'Native value' } });
      expect(ref.session.actions).toEqual([]);
      expect(current.actions).toEqual([]);
    }
  },
);

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
