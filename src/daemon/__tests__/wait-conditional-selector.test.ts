import { expect, test, vi } from 'vitest';
import {
  type DeviceBinding,
  type RuntimeFacts,
  type RuntimeOperationFact,
  localRuntimeOwner,
  narrowDeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import {
  type PlatformRuntimeOperations,
  waitSelectorCaptureRuntimePlanUses,
} from '@agent-device/contracts/platform-runtime-operations';
import type { FindSelectorInput } from '@agent-device/contracts/selector-observation-runtime';
import { snapshotRuntimeOperationFacts } from '@agent-device/contracts/snapshot-runtime';
import { deviceShape } from '@agent-device/kernel/device';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import {
  makeAuthoringSession,
  makeIosAppSession,
  makeIosSession,
} from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { unavailableDeploymentSnapshotAndShutdownOperationFacts } from '../../__tests__/test-utils/runtime-operation-facts.ts';
import { handleSnapshotCommands } from '../handlers/snapshot.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import type { DaemonRequest, SessionState } from '../types.ts';

const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf' as const,
  hint: 'No native selector observation.',
});

function harness(options: {
  fact?: RuntimeOperationFact;
  found?: boolean;
  nodes?: Array<{ index: number; depth: number; type: string; identifier?: string }>;
}) {
  const findSelector = vi.fn(async (_input: FindSelectorInput) => ({
    found: options.found === true,
  }));
  const captureSnapshot = vi.fn(async () => ({
    nodes: options.nodes ?? [],
    backend: 'xctest' as const,
  }));
  const fact = options.fact ?? available;
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(IOS_SIMULATOR), providerMode: 'local' },
    operations: {
      ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
      ...snapshotRuntimeOperationFacts({
        capture: available,
        customActions: unavailable,
        withoutActiveApp: available,
      }),
      findSelector: fact,
    } as RuntimeFacts<PlatformRuntimeOperations>['operations'],
  };
  const binding = {
    device: IOS_SIMULATOR,
    owner: localRuntimeOwner('apple'),
    facts,
    operations: {
      captureSnapshot,
      captureSnapshotWithoutActiveApp: captureSnapshot,
      ...(fact.available ? { findSelector } : {}),
    },
    [Symbol.asyncDispose]: async () => undefined,
  } as unknown as DeviceBinding<PlatformRuntimeOperations>;
  const inspectFacts: InspectDeviceRuntimeFacts = vi.fn(async () => facts);
  const bindDevice = vi.fn(async (_device, use) =>
    narrowDeviceBinding(binding, use),
  ) as unknown as BindDeviceRuntime;
  return { findSelector, captureSnapshot, inspectFacts, bindDevice };
}

async function run(session: SessionState, runtime: ReturnType<typeof harness>) {
  const sessionStore = makeSessionStore('wait-conditional-selector-');
  sessionStore.set(session.name, session);
  const req = {
    command: 'wait',
    positionals: ['id=runner-only', '200'],
    token: 'token',
    session: session.name,
    flags: {},
    meta: { requestId: 'wait-conditional-selector' },
  } as unknown as DaemonRequest;
  const response = await handleSnapshotCommands({
    req,
    sessionName: session.name,
    logPath: '/tmp/wait-conditional-selector.log',
    sessionStore,
    inspectFacts: runtime.inspectFacts,
    bindDevice: runtime.bindDevice,
  });
  if (!response) throw new Error('wait route did not handle the request');
  return response;
}

test('an admitted positive native selector observation satisfies wait without a sparse tree', async () => {
  const runtime = harness({ found: true, nodes: [] });
  const response = await run(makeIosAppSession('wait-conditional-selector'), runtime);

  expect(response).toMatchObject({
    ok: true,
    data: { kind: 'selector', selector: 'id=runner-only' },
  });
  expect(runtime.inspectFacts).toHaveBeenCalledTimes(1);
  expect(runtime.bindDevice).toHaveBeenCalledTimes(1);
  expect(runtime.bindDevice).toHaveBeenCalledWith(
    IOS_SIMULATOR,
    waitSelectorCaptureRuntimePlanUses[0],
  );
  expect(runtime.findSelector).toHaveBeenCalledOnce();
  expect(runtime.findSelector.mock.calls[0]?.[0]).toMatchObject({
    selector: { key: 'id', value: 'runner-only' },
    options: { appBundleId: 'com.example.app' },
    execution: { requestId: 'wait-conditional-selector' },
  });
  expect(runtime.captureSnapshot).not.toHaveBeenCalled();
});

test('a negative native observation falls through to the same bound canonical capture', async () => {
  const runtime = harness({
    found: false,
    nodes: [{ index: 0, depth: 0, type: 'Button', identifier: 'runner-only' }],
  });
  const response = await run(makeIosAppSession('wait-conditional-selector'), runtime);

  expect(response.ok).toBe(true);
  expect(runtime.findSelector).toHaveBeenCalledOnce();
  expect(runtime.captureSnapshot).toHaveBeenCalled();
  expect(runtime.bindDevice).toHaveBeenCalledTimes(1);
});

test('an unavailable conditional observation preserves the capture-backed owner path', async () => {
  const runtime = harness({
    fact: unavailable,
    nodes: [{ index: 0, depth: 0, type: 'Button', identifier: 'runner-only' }],
  });
  const response = await run(makeIosAppSession('wait-conditional-selector'), runtime);

  expect(response.ok).toBe(true);
  expect(runtime.findSelector).not.toHaveBeenCalled();
  expect(runtime.captureSnapshot).toHaveBeenCalled();
  expect(runtime.inspectFacts).toHaveBeenCalledTimes(1);
  expect(runtime.bindDevice).toHaveBeenCalledTimes(1);
});

test('recording and no-app waits retain capture-owned evidence semantics', async () => {
  for (const session of [
    makeAuthoringSession('wait-conditional-selector', {
      appBundleId: 'com.example.app',
    }),
    makeIosSession('wait-conditional-selector'),
  ]) {
    const runtime = harness({
      found: true,
      nodes: [{ index: 0, depth: 0, type: 'Button', identifier: 'runner-only' }],
    });
    const response = await run(session, runtime);
    expect(response.ok).toBe(true);
    expect(runtime.findSelector).not.toHaveBeenCalled();
    expect(runtime.captureSnapshot).toHaveBeenCalled();
  }
});
