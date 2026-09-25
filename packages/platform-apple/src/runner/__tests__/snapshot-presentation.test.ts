import { AppError } from '@agent-device/kernel/errors';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { IosSystemSurfaceProvenance } from '@agent-device/contracts/ios-system-surface';
import type { AppleRunnerSnapshotResult } from '../snapshot-presentation.ts';
import { presentAppleRunnerSnapshot, readAppleSnapshotResult } from '../snapshot-presentation.ts';

const NO_VIEWPORT_ROOT = { index: 0, type: 'Application', label: 'App' };

function presentSparse(overrides: Partial<AppleRunnerSnapshotResult> = {}) {
  return () =>
    presentAppleRunnerSnapshot('device-1', undefined, {
      nodes: [NO_VIEWPORT_ROOT],
      truncated: true,
      quality: {
        state: 'sparse',
        backend: 'private-ax',
        reason: 'no usable snapshot backend',
        reasonCode: 'sparse-tree',
      },
      ...overrides,
    });
}

function catchPresent(overrides: Partial<AppleRunnerSnapshotResult> = {}): AppError {
  try {
    presentSparse(overrides)();
  } catch (error) {
    assert.ok(error instanceof AppError);
    return error;
  }
  assert.fail('expected the presentation to refuse the payload');
}

test('a sparse-declared payload keeps the engine reason and adds the runner verdict', () => {
  const error = catchPresent();

  assert.equal(error.code, 'COMMAND_FAILED');
  assert.equal(error.message, 'regular iOS snapshot presentation requires a valid viewport');
  assert.deepEqual(error.details?.snapshotQuality, {
    state: 'sparse',
    backend: 'private-ax',
    reason: 'no usable snapshot backend',
    reasonCode: 'sparse-tree',
  });
  assert.match(String(error.details?.hint), /No snapshot backend could read this screen/);
  assert.match(String(error.details?.hint), /screenshot as visual truth and coordinate taps/);
});

test('the refusal carries the viewport reason the payload actually produced', () => {
  assert.equal(catchPresent().details?.reason, 'missing-viewport');
  assert.equal(
    catchPresent({ nodes: [{ ...NO_VIEWPORT_ROOT, rect: { x: 0, y: 0, width: 0, height: 0 } }] })
      .details?.reason,
    'invalid-viewport',
  );
});

test('a backend the runner deferred to stays a refusal rather than becoming a retry', () => {
  const deferred = catchPresent({
    quality: { state: 'sparse', backend: 'private-ax', reasonCode: 'deferred' },
  });

  assert.equal(deferred.details?.retriable, undefined);
  assert.equal(deferred.details?.reason, 'missing-viewport');
});

test('a sparse capture of a presented system surface names the surface host', () => {
  const error = catchPresent({
    systemSurface: { bundleId: 'com.apple.SafariViewService', kind: 'web-auth' },
  });

  assert.match(
    String(error.details?.hint),
    /com\.apple\.SafariViewService hosts the surface presented over the app/,
  );
  assert.deepEqual(error.details?.systemSurface, {
    bundleId: 'com.apple.SafariViewService',
    kind: 'web-auth',
  });
});

// The registry, not the wire, decides the kind: a payment host stamped with the wrong kind reads
// back as `payment`, and a bundle id the registry does not know is dropped rather than surfaced.
test('the wire reader takes surface kind from the registry and drops unregistered hosts', () => {
  const mismatched = readAppleSnapshotResult({
    systemSurface: { bundleId: 'com.apple.PassbookUIService', kind: 'web-auth' },
  });
  assert.deepEqual(mismatched.systemSurface, {
    bundleId: 'com.apple.PassbookUIService',
    kind: 'payment',
  });

  const unregistered = readAppleSnapshotResult({
    systemSurface: { bundleId: 'com.example.notahost', kind: 'payment' },
  });
  assert.equal(unregistered.systemSurface, undefined);
});

test('a sparse payload failing another invariant still carries the verdict', () => {
  const error = catchPresent({
    nodes: [
      { ...NO_VIEWPORT_ROOT, rect: { x: 0, y: 0, width: 390, height: 844 } },
      { index: 1, parentIndex: 9, type: 'Button', label: 'Orphan' },
    ],
  });

  assert.equal(error.details?.reason, 'invalid-presented-payload');
  assert.deepEqual(error.details?.snapshotQuality, {
    state: 'sparse',
    backend: 'private-ax',
    reason: 'no usable snapshot backend',
    reasonCode: 'sparse-tree',
  });
});

test('an undeclared rootless payload keeps the plain engine invariant', () => {
  const error = catchPresent({ quality: { state: 'healthy', backend: 'tree' } });

  assert.deepEqual(error.details, { reason: 'missing-viewport', field: 'viewport' });
});

test('a sparse verdict still presents the nodes it did read', () => {
  const nodes = presentAppleRunnerSnapshot('device-1', undefined, {
    nodes: [
      {
        index: 0,
        type: 'Application',
        label: 'App',
        rect: { x: 0, y: 0, width: 390, height: 844 },
      },
      {
        index: 1,
        parentIndex: 0,
        type: 'Button',
        label: 'Not Now',
        rect: { x: 40, y: 400, width: 80, height: 40 },
        hittable: true,
      },
    ],
    truncated: true,
    quality: { state: 'sparse', backend: 'private-ax', reasonCode: 'sparse-tree' },
  });

  assert.deepEqual(
    nodes.map((node) => node.label),
    ['App', 'Not Now'],
  );
});

const SYSTEM_SHEET: IosSystemSurfaceProvenance = {
  bundleId: 'com.apple.SafariViewService',
  kind: 'web-auth',
};

test('a presented system surface travels with an undeclared-payload refusal as typed provenance', () => {
  try {
    presentAppleRunnerSnapshot('device-1', undefined, {
      nodes: [NO_VIEWPORT_ROOT],
      quality: { state: 'healthy', backend: 'tree' },
      systemSurface: SYSTEM_SHEET,
    });
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.deepEqual((error.details as Record<string, unknown>).systemSurface, SYSTEM_SHEET);
    assert.equal((error.details as Record<string, unknown>).snapshotQuality, undefined);
    return;
  }
  assert.fail('expected the presentation to refuse the payload');
});

test('readAppleSnapshotResult keeps registry-known system surface provenance only', () => {
  const known = readAppleSnapshotResult({
    nodes: [],
    systemSurface: { bundleId: 'com.apple.SafariViewService', kind: 'web-auth' },
  });
  assert.deepEqual(known.systemSurface, SYSTEM_SHEET);

  const unknown = readAppleSnapshotResult({
    nodes: [],
    systemSurface: { bundleId: 'com.example.PhishingService', kind: 'web-auth' },
  });
  assert.equal(unknown.systemSurface, undefined);
});

test('a healthy payload with valid viewport roots still presents', () => {
  const screen: RawSnapshotNode = {
    index: 0,
    type: 'Application',
    rect: { x: 0, y: 0, width: 390, height: 844 },
  };
  const button: RawSnapshotNode = {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    label: 'Not Now',
    rect: { x: 16, y: 400, width: 80, height: 32 },
    hittable: true,
  };
  const nodes = presentAppleRunnerSnapshot('device-1', undefined, {
    nodes: [screen, button],
  });
  assert.deepEqual(
    nodes.map((node) => node.index),
    [0, 1],
  );
});

// A runner capture with no viewport box omits `hittable` on the nodes it could not decide (#2891);
// the host presents them undecided rather than minting a value.
test('a runner payload with the hittable bit absent presents without declaring it', () => {
  const nodes: RawSnapshotNode[] = [
    {
      index: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 390, height: 844 },
      hittable: false,
    },
    { index: 1, parentIndex: 0, type: 'Other', rect: { x: 0, y: 0, width: 390, height: 844 } },
    {
      index: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Not Now',
      rect: { x: 16, y: 400, width: 80, height: 32 },
    },
  ];
  for (const interactiveOnly of [false, true]) {
    const presented = presentAppleRunnerSnapshot('device-1', { interactiveOnly }, { nodes });
    const button = presented.find((node) => node.label === 'Not Now');
    assert.ok(button, `interactiveOnly=${interactiveOnly}: the undecided button is presented`);
    assert.equal('hittable' in button, false);
  }
});

// The keyboard band the runner measured for a capture (#2660). The strictness budget that decides
// what cannot be placed belongs to `readSnapshotKeyboardBandFact` in @agent-device/kernel, which owns
// that table; this seam owns only the forwarding, so a published band must arrive unchanged and a
// producer that never looked must stay silent.

test('the reader forwards each published keyboard band shape unchanged', () => {
  // The landscape band #2653 confirmed on iPhone 17 Pro: the runner answers `app.keyboards` in the
  // app's own orientation space, so the daemon reads these numbers beside node rects unchanged.
  assert.deepEqual(
    readAppleSnapshotResult({
      keyboard: { kind: 'visible', frame: { x: 0, y: 198, width: 874, height: 204 } },
    }).keyboard,
    { kind: 'visible', frame: { x: 0, y: 198, width: 874, height: 204 } },
  );
  assert.deepEqual(readAppleSnapshotResult({ keyboard: { kind: 'absent' } }).keyboard, {
    kind: 'absent',
  });
  assert.deepEqual(
    readAppleSnapshotResult({
      keyboard: { kind: 'unmeasurable', reason: 'keyboard-frame-query-timeout' },
    }).keyboard,
    { kind: 'unmeasurable', reason: 'keyboard-frame-query-timeout' },
  );
});

test('a capture from a tier that never reads the keyboard publishes no fact at all', () => {
  // The query sweep and private-AX tiers answer with no `keyboard` key, which is how the daemon
  // learns to keep deriving the band from that tree instead of being told the screen is clear.
  assert.equal(readAppleSnapshotResult({ nodes: [] }).keyboard, undefined);
});
