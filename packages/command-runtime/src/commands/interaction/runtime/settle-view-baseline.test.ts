import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend } from '@agent-device/contracts/backend';
import type { SnapshotState } from '@agent-device/contracts/snapshot-model';
import { createLocalArtifactAdapter } from '@agent-device/host-kit/local-artifact-adapter';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { createAgentDevice } from '../../../runtime.ts';
import { createMemorySessionStore } from '../../../command-runtime/runtime-factory.ts';
import { ref, selector } from './selector-read-utils.ts';
import { createFakeClock } from './__tests__/settle-device-fixtures.ts';

// #4486: a full `snapshot` keeps wrapper nodes that the interactive view the settle loop reads
// omits. A press that changes nothing must not report those wrappers as removed.
//
// Budgets are injected (fake clock) — no real waiting.

const DIALOG_LABELS = ['Device name', 'Cancel', 'OK'];

function dialogNodes(labels: readonly string[], firstIndex = 0) {
  return labels.map((label, index) => ({
    index: firstIndex + index,
    depth: firstIndex === 0 ? 0 : 1,
    ...(firstIndex === 0 ? {} : { parentIndex: 0 }),
    type: label === 'Device name' ? 'StaticText' : 'Button',
    label,
    rect: { x: 10, y: 100 + DIALOG_LABELS.indexOf(label) * 60, width: 200, height: 40 },
    hittable: true,
  }));
}

/** The dialog as a full `snapshot` reads it: the wrapper the interactive view omits, then the dialog. */
function fullDialogTree(): SnapshotState {
  return {
    ...makeSnapshotState([
      { index: 0, depth: 0, type: 'Group', rect: { x: 0, y: 0, width: 400, height: 800 } },
      ...dialogNodes(DIALOG_LABELS, 1),
    ]),
    presentation: {},
  };
}

function interactiveTree(labels: readonly string[]): SnapshotState {
  return { ...makeSnapshotState(dialogNodes(labels)), presentation: { interactiveOnly: true } };
}

function createDevice(params: {
  refFrame: SnapshotState;
  capture: (call: number) => SnapshotState;
}) {
  let calls = 0;
  return createAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: async () => ({ snapshot: params.capture((calls += 1)) }),
      tap: async () => ({ ok: true }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([
      { name: 'default', snapshot: params.refFrame, refFrameSnapshot: params.refFrame },
    ]),
    policy: localCommandPolicy(),
    clock: createFakeClock(),
  });
}

test('a ref press after a full snapshot reports no removals the view change caused', async () => {
  const device = createDevice({
    refFrame: fullDialogTree(),
    capture: () => interactiveTree(DIALOG_LABELS),
  });

  const result = await device.interactions.press(ref('@e3'), { session: 'default', settle: {} });

  assert.equal(result.settle?.diff?.summary.removals, 0);
  // The tiny-tree readiness hint the settled screen earns is kept beside the view-change hint.
  assert.match(result.settle?.hint ?? '', /previous snapshot was a full tree.*nearly-empty tree/);
});

test('a ref press after a full snapshot still lists what the press added', async () => {
  const device = createDevice({
    refFrame: fullDialogTree(),
    // The press opens another screen: its controls are new, the dialog is gone.
    capture: () => interactiveTree(['Next', 'Back', 'Home', 'Menu', 'Help']),
  });

  const result = await device.interactions.press(ref('@e3'), { session: 'default', settle: {} });

  assert.equal(result.settle?.diff?.summary.additions, 5);
  assert.equal(result.settle?.diff?.summary.removals, 0);
  assert.ok(result.settle?.diff?.lines.every((line) => line.kind === 'added' && line.ref));
});

test('a ref press after an interactive snapshot still reports what left the screen', async () => {
  const device = createDevice({
    refFrame: interactiveTree(DIALOG_LABELS),
    capture: () => interactiveTree(['Cancel', 'OK']),
  });

  const result = await device.interactions.press(ref('@e1'), { session: 'default', settle: {} });

  assert.equal(result.settle?.diff?.summary.removals, 1);
  assert.doesNotMatch(result.settle?.hint ?? '', /full tree/);
});

test('a selector press keeps its diff although its resolution read a full tree', async () => {
  const device = createDevice({
    refFrame: interactiveTree(DIALOG_LABELS),
    // Capture 1 resolves the selector on a full tree; the settle loop then reads the interactive
    // view, where the dialog title is gone after the press.
    capture: (call) => (call === 1 ? fullDialogTree() : interactiveTree(['Cancel', 'OK'])),
  });

  const result = await device.interactions.press(selector('label=OK'), {
    session: 'default',
    settle: {},
  });

  assert.ok((result.settle?.diff?.summary.removals ?? 0) > 0);
  assert.doesNotMatch(result.settle?.hint ?? '', /full tree/);
});
