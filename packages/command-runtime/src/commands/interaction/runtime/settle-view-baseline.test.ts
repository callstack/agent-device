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

// #4486: a full `snapshot` keeps wrapper nodes the interactive view omits. A settle on its refs reads
// the full tree too, so an unchanged screen reports no change and wrappers are never false removals.
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

type Screen = { full: SnapshotState; interactive: SnapshotState };

const DIALOG: Screen = { full: fullDialogTree(), interactive: interactiveTree(DIALOG_LABELS) };

/**
 * A backend that answers each capture in the view it was asked for. `screens` is the screen before
 * the press and after it; `views` records the view of every capture taken after the press.
 */
function createDevice(params: { refFrame: SnapshotState; before: Screen; after: Screen }) {
  let pressed = false;
  const views: Array<'full' | 'interactive'> = [];
  const device = createAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: async (_context, options) => {
        const screen = pressed ? params.after : params.before;
        if (pressed) views.push(options?.interactiveOnly === true ? 'interactive' : 'full');
        return { snapshot: options?.interactiveOnly === true ? screen.interactive : screen.full };
      },
      tap: async () => {
        pressed = true;
        return { ok: true };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([
      { name: 'default', snapshot: params.refFrame, refFrameSnapshot: params.refFrame },
    ]),
    policy: localCommandPolicy(),
    clock: createFakeClock(),
  });
  return { device, views };
}

function removedLabels(lines: Array<{ kind: string; text: string }> | undefined): string[] {
  return (lines ?? []).filter((line) => line.kind === 'removed').map((line) => line.text);
}

test('a ref press after a full snapshot settles on the full tree and reports no false removals', async () => {
  const { device, views } = createDevice({
    refFrame: DIALOG.full,
    before: DIALOG,
    after: DIALOG,
  });

  const result = await device.interactions.press(ref('@e3'), { session: 'default', settle: {} });

  assert.ok(views.length > 0 && views.every((view) => view === 'full'));
  assert.deepEqual(result.settle?.diff?.summary, { additions: 0, removals: 0, unchanged: 4 });
});

test('a ref press after a full snapshot still reports what changed on the full tree', async () => {
  const next = ['Next', 'Back'];
  const { device } = createDevice({
    refFrame: DIALOG.full,
    before: DIALOG,
    after: {
      full: {
        ...makeSnapshotState([
          { index: 0, depth: 0, type: 'Group', rect: { x: 0, y: 0, width: 400, height: 800 } },
          ...dialogNodes(next, 1),
        ]),
        presentation: {},
      },
      interactive: interactiveTree(next),
    },
  });

  const result = await device.interactions.press(ref('@e3'), { session: 'default', settle: {} });

  assert.equal(result.settle?.diff?.summary.additions, 2);
  assert.equal(result.settle?.diff?.summary.removals, 3);
  assert.ok(removedLabels(result.settle?.diff?.lines).some((text) => text.includes('Device name')));
});

test('a ref press after an interactive snapshot settles on the interactive view', async () => {
  const titleGone = interactiveTree(['Cancel', 'OK']);
  const { device, views } = createDevice({
    refFrame: DIALOG.interactive,
    before: DIALOG,
    after: { full: DIALOG.full, interactive: titleGone },
  });

  const result = await device.interactions.press(ref('@e1'), { session: 'default', settle: {} });

  assert.ok(views.length > 0 && views.every((view) => view === 'interactive'));
  assert.deepEqual(removedLabels(result.settle?.diff?.lines).length, 1);
});

test('a selector press settles on the interactive view although its resolution read a full tree', async () => {
  const titleGone = interactiveTree(['Cancel', 'OK']);
  const { device, views } = createDevice({
    refFrame: DIALOG.interactive,
    before: DIALOG,
    after: { full: DIALOG.full, interactive: titleGone },
  });

  const result = await device.interactions.press(selector('label=OK'), {
    session: 'default',
    settle: {},
  });

  assert.ok(views.length > 0 && views.every((view) => view === 'interactive'));
  assert.ok(removedLabels(result.settle?.diff?.lines).some((text) => text.includes('Device name')));
});
