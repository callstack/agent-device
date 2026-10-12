import { daemonPlatformServicesFixture } from './platform-services-fixture.ts';
import { expect, test } from 'vitest';
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
import { createUnavailableRuntimeFactsForTest } from '@agent-device/test-kit/runtime-operation-facts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { makeSession as makeStoredSession } from '../../__tests__/test-utils/session-factories.ts';
import { dispatchGetViaRuntime } from '../selector-runtime.ts';
import { testCreateCommandSurface } from './command-surface-fixture.ts';

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
