/**
 * #4622: replay's target verification must read the screen through the SAME capture the commands it
 * dispatches read it through. Recorded `target-v1` evidence describes the tree one producer builds;
 * on an iOS simulator the Simulator AX bridge and the XCTest runner project one screen differently
 * (the runner wraps the screen's content in an `other "<screen title>"` node the bridge tree does
 * not have), so a verification that captured through the other one reported `identity-mismatch` on
 * `ancestry[...]` for a screen nobody had changed.
 *
 * These drive the whole `runReplayCommand` route, admit and bind at the request's own seams rather
 * than at the legacy interactor leaf, and read the producer back off the session's stored
 * observation: the recorded-evidence comparison and the store must agree on who built the tree.
 */
import { beforeEach, expect, test, vi } from 'vitest';
import type {
  CaptureSnapshotInput,
  SnapshotResult,
} from '@agent-device/contracts/snapshot-runtime';
import { IOS_SIMULATOR } from '@agent-device/test-kit';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { createRequestRuntimeBindings } from '../../core/request-runtime-binding.ts';
import { createRequestDispatchLedger } from '../../core/request-dispatch-ledger.ts';
import {
  platformRequestScopeFixture,
  unavailableBinding,
  unavailableDeviceRuntimeGateway,
} from '../../__tests__/support/unavailable-device-runtime-gateway.ts';
import { publishOpenSession } from '../session-lifecycle/internal/session-open-state.ts';
import {
  legacyDispatchCapture,
  resetLegacySnapshotCapture,
} from '../../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { captureSnapshotWithInteractor } from '../../core/snapshot-interactor-capture.ts';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { NO_BOOT_PROOF } from '../../__tests__/support/boot-ownership-fixtures.ts';
import { selectorCaptureFixture } from '../../__tests__/support/selector-capture-fixture.ts';
import {
  SAVE_ANNOTATION,
  replayScriptScene,
} from '../__tests__/replay-target/session-replay-scenario.fixtures.ts';

vi.mock('../../core/snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/device-selection/dispatch-resolve')>();
  return { ...actual, resolveTargetDevice: vi.fn() };
});

vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  return { ...actual, emitDiagnostic: vi.fn(actual.emitDiagnostic) };
});

const REQUEST_ID = 'replay-capture-request';

/** The bridge tree for the recorded Save button: the producer that wrote the annotation. */
function bridgeSaveButton(): SnapshotResult {
  return {
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        identifier: 'save',
        label: 'Save',
        rect: { x: 10, y: 10, width: 40, height: 20 },
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'xctest',
    producer: 'simulator-ax-bridge',
  };
}

function disclosures() {
  return vi
    .mocked(emitDiagnostic)
    .mock.calls.flatMap(([event]) =>
      event.phase === 'observation_capture_unavailable' && event.data
        ? [{ level: event.level, data: event.data }]
        : [],
    );
}

const verifiedClick = [SAVE_ANNOTATION, 'click id="save"'];

beforeEach(() => {
  vi.mocked(emitDiagnostic).mockClear();
  resetLegacySnapshotCapture(vi.mocked(captureSnapshotWithInteractor));
});

test('target verification captures through the request-bound capture and records its producer', async () => {
  const fixture = selectorCaptureFixture({ snapshot: bridgeSaveButton });
  const scene = replayScriptScene(
    'agent-device-replay-capture-bound-',
    [...verifiedClick, ...verifiedClick],
    {
      meta: { requestId: REQUEST_ID, cwd: '/work' },
      inspectFacts: fixture.inspectFacts,
      platformServices: daemonPlatformServicesFixture(),
      bindDevice: fixture.bindDevice,
    },
  );

  const response = await scene.replay();

  expect(response.ok).toBe(true);
  expect(scene.invoked.map((req) => req.command)).toEqual(['click', 'click']);
  // ADR 0019 §9 shape: the whole replay run admits once and binds once, on the session's device.
  expect(fixture.inspections).toEqual([IOS_SIMULATOR]);
  expect(fixture.binds).toEqual([IOS_SIMULATOR]);
  expect(fixture.captures).toHaveLength(2);
  // The legacy interactor leaf is no longer the route a verification takes: nothing reached it.
  expect(legacyDispatchCapture).not.toHaveBeenCalled();

  // What the platform was asked to capture: the fixed full-window diagnostic policy (#1264) plus
  // this request's identity, so the capture's diagnostics land on the replay request's record.
  expect(fixture.captures[0]).toMatchObject({
    options: {
      appBundleId: 'com.example.app',
      interactiveOnly: true,
      scope: undefined,
      raw: undefined,
      depth: undefined,
    },
    execution: { requestId: REQUEST_ID },
  });

  // The producer equality the issue asks for: the tree the recorded evidence was compared against,
  // and the one the session stores, are the bound owner's, not the runner's.
  expect(scene.sessionStore.get(scene.sessionName)?.snapshot).toMatchObject({
    backend: 'xctest',
    producer: 'simulator-ax-bridge',
  });
  expect(disclosures()).toEqual([]);
});

test.each(['close and reopen', 'open with refreshed device'])(
  'replay verifies with a fresh runtime after %s on the same booted device',
  async (lifecycle) => {
    const { inspectFacts } = selectorCaptureFixture();
    let generation = 0;
    const captures: number[] = [];
    const bind = vi.fn<typeof unavailableDeviceRuntimeGateway.bind>(async ({ device }) => {
      const attachedGeneration = generation;
      return {
        ...(await unavailableBinding(device)),
        facts: await inspectFacts(device),
        operations: {
          captureSnapshot: async () => {
            captures.push(attachedGeneration);
            if (attachedGeneration !== generation) throw new Error('Stale attachment');
            return bridgeSaveButton();
          },
        },
      };
    });
    const bindings = createRequestRuntimeBindings({
      gateway: { ...unavailableDeviceRuntimeGateway, inspectFacts, bind },
      dispatchLedger: createRequestDispatchLedger(),
      scope: platformRequestScopeFixture(),
      admitDeviceClaim: async () => {},
    });
    const closes = lifecycle === 'close and reopen';
    const scene = replayScriptScene(
      'agent-device-replay-capture-lifecycle-',
      [...verifiedClick, ...(closes ? ['close'] : []), 'open "Demo"', ...verifiedClick],
      { ...bindings, platformServices: daemonPlatformServicesFixture() },
    );
    try {
      const initial = scene.sessionStore.lookup(scene.sessionName)!;
      expect(initial.session.device.booted).toBe(true);
      const response = await scene.replay({
        invoke: async (req) => {
          if (req.command === 'close') scene.sessionStore.retire(initial);
          if (req.command === 'open') {
            generation++;
            publishOpenSession({
              req,
              sessionStore: scene.sessionStore,
              sessionName: scene.sessionName,
              existingRef: scene.sessionStore.lookup(scene.sessionName),
              device: closes ? initial.session.device : { ...initial.session.device },
              surface: 'app',
              appBundleId: initial.session.appBundleId,
              bootOwnership: NO_BOOT_PROOF,
            });
          }
          return { ok: true, data: {} };
        },
      });
      expect(response.ok).toBe(true);
      expect(scene.invoked.map((req) => req.command)).toEqual([
        'click',
        ...(closes ? ['close'] : []),
        'open',
        'click',
      ]);
      expect(bind).toHaveBeenCalledTimes(2);
      expect(captures).toEqual([0, 1]);
      expect(legacyDispatchCapture).not.toHaveBeenCalled();
      expect(disclosures()).toEqual([]);
    } finally {
      await bindings[Symbol.asyncDispose]();
    }
  },
);

// The replay cell binds `capture-only` with the cache bypassed, while every command the replay
// dispatches binds its action use through the request's device-key cache. Both bindings of one
// device are live in the same request: the cache must not hand the bypass cell the action
// projection, the two captures must not cross projections, and each binding's own dispose must
// still run exactly once when the request ends.
test('a bypassed capture binding and a cached action binding of one device coexist in one request', async () => {
  const fixture = selectorCaptureFixture({ snapshot: bridgeSaveButton });
  const disposals: string[] = [];
  const bind = vi.fn<typeof unavailableDeviceRuntimeGateway.bind>(async ({ device }) => ({
    ...(await unavailableBinding(device)),
    facts: await fixture.inspectFacts(device),
    operations: {
      captureSnapshot: async (input: CaptureSnapshotInput) => {
        fixture.captures.push(input);
        return bridgeSaveButton();
      },
    },
    [Symbol.asyncDispose]: async () => {
      disposals.push(device.id);
    },
  }));
  const bindings = createRequestRuntimeBindings({
    gateway: { ...unavailableDeviceRuntimeGateway, inspectFacts: fixture.inspectFacts, bind },
    dispatchLedger: createRequestDispatchLedger(),
    scope: platformRequestScopeFixture(),
    admitDeviceClaim: async () => {},
  });
  // What a dispatched click binds through the same request seam: the cached path, no bypass.
  const actionUse = { required: ['captureSnapshot'] as const, preferred: [] as const };
  const scene = replayScriptScene(
    'agent-device-replay-capture-coexist-',
    [...verifiedClick, ...verifiedClick],
    {
      meta: { requestId: REQUEST_ID, cwd: '/work' },
      inspectFacts: bindings.inspectFacts,
      platformServices: daemonPlatformServicesFixture(),
      bindDevice: bindings.bindDevice,
    },
  );
  try {
    const response = await scene.replay({
      invoke: async () => {
        const session = scene.sessionStore.get(scene.sessionName)!;
        await bindings.bindDevice(session.device, actionUse);
        return { ok: true, data: {} };
      },
    });
    expect(response.ok).toBe(true);
    // One bypass bind for the replay's one verification cell and one gateway bind feeding the
    // cached action projection: the two routes share one device without reusing each other's
    // binding, and the two dispatches reuse the cell and the cache entry, not new binds.
    expect(bind).toHaveBeenCalledTimes(2);
    expect(fixture.captures).toHaveLength(2);
    expect(disposals).toEqual([]);
  } finally {
    await bindings[Symbol.asyncDispose]();
  }
  // Both live bindings are adopted by the request cleanup, each disposed exactly once.
  expect(disposals).toHaveLength(2);
});

test.each(['admission-probe-failed', 'bind-failed'] as const)(
  'replay re-admits at the next verification after %s',
  async (outcome) => {
    const fixture = selectorCaptureFixture({ snapshot: bridgeSaveButton });
    const inspectFacts = vi.fn(fixture.inspectFacts);
    const beforeBind = vi.fn(async () => {});
    (outcome === 'admission-probe-failed' ? inspectFacts : beforeBind).mockRejectedValueOnce(
      new TypeError('Unavailable'),
    );
    legacyDispatchCapture.mockResolvedValue({ ...bridgeSaveButton(), producer: 'apple-runner' });
    const scene = replayScriptScene(
      'agent-device-replay-capture-retry-',
      [...verifiedClick, ...verifiedClick, ...verifiedClick],
      {
        inspectFacts,
        bindDevice: async (device, use) => {
          await beforeBind();
          return await fixture.bindDevice(device, use);
        },
        platformServices: daemonPlatformServicesFixture(),
      },
    );

    expect((await scene.replay()).ok).toBe(true);
    expect(scene.invoked.map((req) => req.command)).toEqual(['click', 'click', 'click']);
    expect(inspectFacts).toHaveBeenCalledTimes(2);
    expect(legacyDispatchCapture).toHaveBeenCalledTimes(1);
    expect(fixture.captures).toHaveLength(2);
    expect(disclosures()).toEqual([
      { level: 'warn', data: { command: 'replay', outcome, errorName: 'TypeError' } },
    ]);
  },
);

// A refusal is the owner's declared support for the cell's plan, so the cell keeps it for its
// lifetime: the second annotated step verifies through the owner's own path again WITHOUT a second
// facts probe or a second warning. (The two transient failure outcomes are the opposite class and
// are dropped by the re-admission test above.)
test('an owner that refuses the capture keeps verification on its own path and says so once', async () => {
  const fixture = selectorCaptureFixture({
    capture: { available: false, reason: 'unsupported-platform-leaf' },
    snapshot: bridgeSaveButton,
  });
  legacyDispatchCapture.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        identifier: 'save',
        label: 'Save',
        rect: { x: 10, y: 10, width: 40, height: 20 },
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'xctest',
    producer: 'apple-runner',
  });
  const scene = replayScriptScene(
    'agent-device-replay-capture-refused-',
    [...verifiedClick, ...verifiedClick],
    {
      meta: { requestId: REQUEST_ID, cwd: '/work' },
      inspectFacts: fixture.inspectFacts,
      platformServices: daemonPlatformServicesFixture(),
      bindDevice: fixture.bindDevice,
    },
  );

  const response = await scene.replay();

  // Refusing the optional binding costs the run nothing: the action still replays on the owner's
  // own snapshot path, which is what a caller with no composed runtime keeps doing.
  expect(response.ok).toBe(true);
  expect(scene.invoked.map((req) => req.command)).toEqual(['click', 'click']);
  expect(fixture.binds).toEqual([]);
  // One probe and one disclosure for the two steps: the cached refusal answers the second.
  expect(fixture.inspections).toHaveLength(1);
  expect(legacyDispatchCapture).toHaveBeenCalledTimes(2);
  expect(disclosures()).toEqual([
    {
      level: 'warn',
      data: {
        command: 'replay',
        outcome: 'refused',
        operation: 'captureSnapshot',
        reason: 'unsupported-platform-leaf',
      },
    },
  ]);
});

test('a replay run with no composed admission captures on the owner path without probing facts', async () => {
  legacyDispatchCapture.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        identifier: 'save',
        label: 'Save',
        rect: { x: 10, y: 10, width: 40, height: 20 },
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'xctest',
  });
  const scene = replayScriptScene('agent-device-replay-capture-unbound-', [
    SAVE_ANNOTATION,
    'click id="save"',
  ]);

  const response = await scene.replay();

  expect(response.ok).toBe(true);
  expect(legacyDispatchCapture).toHaveBeenCalled();
  expect(disclosures()).toEqual([]);
});
