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
import type { SnapshotResult } from '@agent-device/contracts/snapshot-runtime';
import { IOS_SIMULATOR } from '@agent-device/test-kit';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import {
  legacyDispatchCapture,
  resetLegacySnapshotCapture,
} from '../../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { captureSnapshotWithInteractor } from '../../core/snapshot-interactor-capture.ts';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
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

beforeEach(() => {
  vi.mocked(emitDiagnostic).mockClear();
  resetLegacySnapshotCapture(vi.mocked(captureSnapshotWithInteractor));
});

test('target verification captures through the request-bound capture and records its producer', async () => {
  const fixture = selectorCaptureFixture({ snapshot: bridgeSaveButton });
  const scene = replayScriptScene(
    'agent-device-replay-capture-bound-',
    [SAVE_ANNOTATION, 'click id="save"'],
    {
      meta: { requestId: REQUEST_ID, cwd: '/work' },
      inspectFacts: fixture.inspectFacts,
      platformServices: daemonPlatformServicesFixture(),
      bindDevice: fixture.bindDevice,
    },
  );

  const response = await scene.replay();

  expect(response.ok).toBe(true);
  expect(scene.invoked.map((req) => req.command)).toEqual(['click']);
  // ADR 0019 §9 shape: the whole replay run admits once and binds once, on the session's device.
  expect(fixture.inspections).toEqual([IOS_SIMULATOR]);
  expect(fixture.binds).toEqual([IOS_SIMULATOR]);
  expect(fixture.captures).toHaveLength(1);
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

test('an owner that refuses the capture keeps verification on its own path and says so', async () => {
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
    [SAVE_ANNOTATION, 'click id="save"'],
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
  expect(scene.invoked.map((req) => req.command)).toEqual(['click']);
  expect(fixture.binds).toEqual([]);
  expect(legacyDispatchCapture).toHaveBeenCalled();
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
