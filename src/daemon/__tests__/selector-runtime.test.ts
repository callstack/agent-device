import { daemonPlatformServicesFixture } from './platform-services-fixture.ts';
import { expect, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import type { QuerySelectorInput } from '@agent-device/contracts/selector-observation-runtime';
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
import { testCreateCommandSurface } from './command-surface-fixture.ts';

import { queryDirectIosSelector } from '../direct-ios-selector.ts';

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
      createCommandSurface: testCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
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

// #1542: queryDirectIosSelector is the daemon-side adapter for the off-screen rescue's live
// read. The runner request shape is the Apple owner's contract (its `querySelector` runtime
// operation, pinned by packages/platform-apple); what the daemon owns here is the projection:
// the session's app scope rides along, and the verdict passes through unchanged.

test('queryDirectIosSelector: forwards the selector with the session appBundleId scope', async () => {
  const session = { ...makeSession(), appBundleId: 'com.example.demo' };
  const querySelector = vi.fn(async (_input: QuerySelectorInput) => ({ found: false }) as const);

  await queryDirectIosSelector(session, { key: 'id', value: 'submit-order' }, querySelector, {
    execution: { requestId: 'req-1' },
  });

  assert.deepEqual(querySelector.mock.calls[0]?.[0], {
    selector: { key: 'id', value: 'submit-order' },
    options: { appBundleId: 'com.example.demo' },
    execution: { requestId: 'req-1' },
  });
});

test('queryDirectIosSelector: a session without an app sends no options bag', async () => {
  let received: QuerySelectorInput | undefined;
  const querySelector = vi.fn(async (input: QuerySelectorInput) => {
    received = input;
    return { found: false } as const;
  });

  await queryDirectIosSelector(makeSession(), { key: 'label', value: 'Pickup' }, querySelector, {
    execution: {},
  });

  assert.ok(received);
  assert.equal('options' in received, false);
});

test('queryDirectIosSelector: passes the node projection through when the owner reports one', async () => {
  const node = { rect: { x: 1, y: 2, width: 3, height: 4 }, hittable: true };
  const querySelector = vi.fn(
    async (_input: QuerySelectorInput) => ({ found: true, node }) as const,
  );

  const result = await queryDirectIosSelector(
    makeSession(),
    { key: 'label', value: 'Pickup' },
    querySelector,
    {
      execution: {},
    },
  );

  assert.equal(result.found, true);
  assert.deepEqual(result.node, node);
});

test('queryDirectIosSelector: found:false with no node reports not-found without a node', async () => {
  const querySelector = vi.fn(async (_input: QuerySelectorInput) => ({ found: false }) as const);

  const result = await queryDirectIosSelector(
    makeSession(),
    { key: 'id', value: 'missing' },
    querySelector,
    {
      execution: {},
    },
  );

  assert.equal(result.found, false);
  assert.equal(result.node, undefined);
});

test('queryDirectIosSelector: propagates an AMBIGUOUS_MATCH refusal from the owner rather than swallowing it', async () => {
  const querySelector = vi.fn(async (_input: QuerySelectorInput) => {
    throw new AppError('AMBIGUOUS_MATCH', 'selector matched multiple elements');
  });

  await assert.rejects(
    () =>
      queryDirectIosSelector(
        makeSession(),
        { key: 'label', value: 'Checkout form' },
        querySelector,
        { execution: {} },
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'AMBIGUOUS_MATCH');
      return true;
    },
  );
});
