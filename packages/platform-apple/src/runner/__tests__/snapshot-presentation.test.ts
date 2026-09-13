import { AppError } from '@agent-device/kernel/errors';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AppleRunnerSnapshotResult } from '../snapshot-presentation.ts';
import { presentAppleRunnerSnapshot } from '../snapshot-presentation.ts';

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
