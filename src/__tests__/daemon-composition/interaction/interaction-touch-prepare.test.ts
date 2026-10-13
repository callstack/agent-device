import { beforeEach, expect, test, vi } from 'vitest';
import type { CommandFlags } from '@agent-device/contracts/command';
import {
  type DeviceBinding,
  type RuntimeFacts,
  localRuntimeOwner,
  narrowDeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { snapshotRuntimeOperationFacts } from '@agent-device/contracts/snapshot-runtime';
import {
  type FillPointInput,
  type TapPointInput,
  touchRuntimeOperationFacts,
} from '@agent-device/contracts/touch-runtime';
import { attachRefs, type RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createUnavailableRuntimeFactsForTest } from '@agent-device/test-kit/runtime-operation-facts';
import { makeIosAppSession } from '@agent-device/daemon/testing/__tests__/support/session-factories';
import { makeSessionStore } from '@agent-device/daemon/testing/__tests__/support/store-factory';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '@agent-device/daemon/testing/request-runtime-binding';
import { composedPlatformServicesFixture } from '../platform-services-fixture.ts';
import { testCreateCommandSurface } from '../command-surface-fixture.ts';
import { handleInteractionCommands } from '@agent-device/daemon/testing/interaction/index';
import type { SessionStore } from '@agent-device/daemon/testing/session-store';

// #3510: the capture an interaction's post-action observation polls. A coordinate-targeted press or
// fill acts through a use that declares no capture, so before this its settle loop read the screen
// through the session's legacy snapshot path while the command the caller ran next read the
// request-bound runtime: on an iOS simulator, two projections of one screen.

const available = Object.freeze({ available: true } as const);
const refused = Object.freeze({ available: false, reason: 'unsupported-platform-leaf' } as const);

const TREE: RawSnapshotNode[] = [
  { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    identifier: 'save',
    label: 'Save',
    rect: { x: 10, y: 20, width: 100, height: 40 },
    hittable: true,
  },
];

/** The tree only the request-bound capture can produce, so producer identity is decidable. */
const BRIDGE_PRODUCED = Object.freeze({
  nodes: TREE,
  backend: 'xctest' as const,
  producer: 'simulator-ax-bridge' as const,
});

const mockInteractorCapture = vi.hoisted(() => vi.fn());
vi.mock('@agent-device/daemon/testing/snapshot-interactor-capture', () => ({
  captureSnapshotWithInteractor: mockInteractorCapture,
}));

const contextFromFlags = (_flags: CommandFlags | undefined) => ({});

/** An owner that captures, taps points, fills points, and does nothing else. */
function settleFixture() {
  const binds: Array<Readonly<{ device: DeviceInfo; required: readonly string[] }>> = [];
  let captures = 0;
  const facts = (device: DeviceInfo): RuntimeFacts<PlatformRuntimeOperations> => {
    const base = createUnavailableRuntimeFactsForTest(device, localRuntimeOwner('apple'));
    return Object.freeze({
      device: base.device,
      operations: {
        ...base.operations,
        ...snapshotRuntimeOperationFacts({
          capture: available,
          customActions: refused,
          withoutActiveApp: available,
        }),
        ...touchRuntimeOperationFacts({
          unsupported: refused,
          tap: available,
          longPress: refused,
          fill: available,
        }),
      },
    });
  };
  const capture = async () => {
    captures += 1;
    return BRIDGE_PRODUCED;
  };
  const inspectFacts: InspectDeviceRuntimeFacts = async (device) => facts(device);
  const bindDevice: BindDeviceRuntime = async (device, use) => {
    binds.push({ device, required: [...use.required] });
    return await narrowDeviceBinding(
      Object.freeze({
        device,
        owner: localRuntimeOwner('apple'),
        facts: facts(device),
        operations: Object.freeze({
          captureSnapshot: capture,
          captureSnapshotWithoutActiveApp: capture,
          tapPoint: async (input: TapPointInput) => ({ x: input.point.x, y: input.point.y }),
          fillPoint: async (input: FillPointInput) => ({ x: input.point.x, y: input.point.y }),
        }),
        [Symbol.asyncDispose]: async () => undefined,
      }) as unknown as DeviceBinding<PlatformRuntimeOperations>,
      use,
    );
  };
  return {
    binds,
    inspectFacts,
    bindDevice,
    captureCount: () => captures,
  };
}

const SETTLE_FLAGS = { settle: true, settleQuietMs: 25, timeoutMs: 2_000 } satisfies CommandFlags;

function publishSession(sessionStore: SessionStore, sessionName: string) {
  const session = makeIosAppSession(sessionName);
  session.snapshot = {
    nodes: attachRefs(TREE),
    createdAt: Date.now(),
    backend: 'xctest',
    producer: 'apple-runner',
  };
  sessionStore.publish(sessionName, session);
  return session;
}

async function runCommand(
  sessionStore: SessionStore,
  sessionName: string,
  command: string,
  positionals: string[],
  bindings: ReturnType<typeof settleFixture>,
  flags: CommandFlags = {},
  inspectFacts: InspectDeviceRuntimeFacts = bindings.inspectFacts,
) {
  return await handleInteractionCommands({
    createCommandSurface: testCreateCommandSurface,
    req: { token: 't', session: sessionName, command, positionals, flags: { ...flags } },
    sessionName,
    sessionStore,
    contextFromFlags,
    platformServices: composedPlatformServicesFixture(),
    inspectFacts,
    bindDevice: bindings.bindDevice,
  });
}

function settled(response: unknown) {
  return (response as { data: { settle?: { settled: boolean } } }).data.settle;
}

beforeEach(() => {
  mockInteractorCapture.mockReset();
});

// The observation's bind is a second, capture-only use beside the action's exact one — taken once
// for the request, not once per capture.
test.each([
  ['press', ['10', '20'], ['tapPoint']],
  ['fill', ['10', '20', 'kit'], ['fillPoint']],
] as const)(
  'a coordinate %s with --settle observes through the capture the request admitted',
  async (command, positionals, actionUse) => {
    const sessionStore = makeSessionStore();
    const sessionName = `point-${command}-settle`;
    const session = publishSession(sessionStore, sessionName);
    const bindings = settleFixture();

    const response = await runCommand(
      sessionStore,
      sessionName,
      command,
      [...positionals],
      bindings,
      SETTLE_FLAGS,
    );

    expect(response?.ok).toBe(true);
    expect(settled(response)).toMatchObject({ settled: true });
    expect(bindings.binds.map((bind) => bind.required)).toEqual([actionUse, ['captureSnapshot']]);
    // The tree the observation published is the bound capture's, and the legacy path was never asked
    // for a tree: one producer for the whole request, which is what lets the refs the settle response
    // issued resolve against the tree the caller's next `snapshot` reads.
    expect(session.snapshot?.producer).toBe('simulator-ax-bridge');
    expect(bindings.captureCount()).toBeGreaterThan(1);
    expect(mockInteractorCapture).not.toHaveBeenCalled();
  },
);

test('a coordinate press without --settle binds no observation capture', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'point-press-no-settle';
  publishSession(sessionStore, sessionName);
  const bindings = settleFixture();

  const response = await runCommand(sessionStore, sessionName, 'press', ['10', '20'], bindings);

  expect(response?.ok).toBe(true);
  expect(bindings.binds.map((bind) => bind.required)).toEqual([['tapPoint']]);
});

test('an observation capture the owner cannot admit still lets the coordinate press act', async () => {
  // The action's own facts inspection answers first, then the observation's admission is asked. An
  // owner that fails the second ask must not cost the first: settling is best-effort by contract, so
  // the tap still lands and the observation degrades to the owner's own snapshot path (#3510).
  const sessionStore = makeSessionStore();
  const sessionName = 'point-press-probe-failure';
  publishSession(sessionStore, sessionName);
  const bindings = settleFixture();
  mockInteractorCapture.mockResolvedValue(BRIDGE_PRODUCED);
  let inspections = 0;

  const response = await runCommand(
    sessionStore,
    sessionName,
    'press',
    ['10', '20'],
    bindings,
    SETTLE_FLAGS,
    async (device) => {
      inspections += 1;
      // Stands in for the Apple facts probe re-throwing a cancelled host read on the second ask.
      if (inspections > 1)
        throw Object.assign(new Error('probe cancelled'), { name: 'AbortError' });
      return await bindings.inspectFacts(device);
    },
  );

  expect(response?.ok).toBe(true);
  expect(settled(response)).toMatchObject({ settled: true });
  expect(mockInteractorCapture).toHaveBeenCalled();
});

test('a tree-resolved press reuses the capture its action binding already carries', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'selector-press-settle';
  publishSession(sessionStore, sessionName);
  const bindings = settleFixture();

  const response = await runCommand(
    sessionStore,
    sessionName,
    'press',
    ['label="Save"'],
    bindings,
    SETTLE_FLAGS,
  );

  expect(response?.ok).toBe(true);
  // No extra bind: this route's use already requires the capture, which is why a selector press
  // never had the split a coordinate press had.
  expect(bindings.binds.map((bind) => bind.required)).toEqual([['captureSnapshot', 'tapPoint']]);
  expect(sessionStore.get(sessionName)?.snapshot?.producer).toBe('simulator-ax-bridge');
});
