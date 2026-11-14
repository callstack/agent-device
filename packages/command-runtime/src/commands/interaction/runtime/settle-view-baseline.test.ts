import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend, BackendSnapshotOptions } from '@agent-device/contracts/backend';
import type { SnapshotState } from '@agent-device/contracts/snapshot-model';
import type { SnapshotPresentation } from '@agent-device/kernel/snapshot';
import { createLocalArtifactAdapter } from '@agent-device/host-kit/local-artifact-adapter';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { createAgentDevice } from '../../../runtime.ts';
import { createMemorySessionStore } from '../../../command-runtime/runtime-factory.ts';
import { ref, selector } from './selector-read-utils.ts';
import { createFakeClock } from './__tests__/settle-device-fixtures.ts';

// #4486: a post-action comparison reads one view. A settle captures in its baseline's presentation,
// the baseline is read in the agent's view (its ref frame's presentation), and verify and
// `diff snapshot` compare only trees read in one presentation. Budgets are injected (fake clock).

const DIALOG = ['Device name', 'Cancel', 'OK'];

function dialogNodes(labels: readonly string[], wrapper: boolean) {
  const offset = wrapper ? 1 : 0;
  return [
    ...(wrapper
      ? [
          {
            index: 0,
            depth: 0,
            type: 'Group',
            label: 'Dialog',
            rect: { x: 0, y: 0, width: 400, height: 800 },
          },
        ]
      : []),
    ...labels.map((label, index) => ({
      index: offset + index,
      depth: offset,
      ...(wrapper ? { parentIndex: 0 } : {}),
      type: label === 'Device name' ? 'StaticText' : 'Button',
      label,
      rect: { x: 10, y: 100 + index * 60, width: 200, height: 40 },
      hittable: true,
    })),
  ];
}

/** The screen as each view reads it: the full tree keeps a wrapper the interactive view omits. */
function screen(
  labels: readonly string[],
  presentation: SnapshotPresentation | undefined,
): SnapshotState {
  const full = presentation?.interactiveOnly !== true;
  return { ...makeSnapshotState(dialogNodes(labels, full)), presentation };
}

const FULL: SnapshotPresentation = {};
const INTERACTIVE: SnapshotPresentation = { interactiveOnly: true };

function viewOf(options: BackendSnapshotOptions | undefined): SnapshotPresentation {
  return {
    ...(options?.interactiveOnly === true ? { interactiveOnly: true } : {}),
    ...(options?.scope !== undefined ? { scope: options.scope } : {}),
    ...(options?.depth !== undefined ? { depth: options.depth } : {}),
    ...(options?.raw !== undefined ? { raw: options.raw } : {}),
    ...(options?.customActions !== undefined ? { customActions: options.customActions } : {}),
  };
}

/**
 * A backend that answers every capture in the view it was asked for, as the daemon stamps it.
 * `before` and `after` are the dialog labels on screen before and after the action; `views`
 * records the view of every capture taken after it.
 */
function createDevice(params: {
  frame: SnapshotState;
  before?: readonly string[];
  after?: readonly string[];
}) {
  let acted = false;
  const views: SnapshotPresentation[] = [];
  const device = createAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: async (_context, options) => {
        const view = viewOf(options);
        if (acted) views.push(view);
        return {
          snapshot: screen(acted ? (params.after ?? DIALOG) : (params.before ?? DIALOG), view),
        };
      },
      tap: async () => {
        acted = true;
        return { ok: true };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter({ cwd: process.cwd() }),
    sessions: createMemorySessionStore([
      { name: 'default', snapshot: params.frame, refFrameSnapshot: params.frame },
    ]),
    policy: localCommandPolicy(),
    clock: createFakeClock(),
  });
  return { device, views };
}

const removed = (lines: Array<{ kind: string; text: string }> | undefined) =>
  (lines ?? []).filter((line) => line.kind === 'removed').map((line) => line.text);

test.each([FULL, undefined])(
  'a ref press after a full snapshot (%j) settles without false removals',
  async (presentation) => {
    const { device, views } = createDevice({ frame: screen(DIALOG, presentation) });

    const result = await device.interactions.press(ref('@e3'), { session: 'default', settle: {} });

    assert.ok(views.length > 0 && views.every((view) => view.interactiveOnly !== true));
    assert.deepEqual(result.settle?.diff?.summary, { additions: 0, removals: 0, unchanged: 4 });
  },
);

test('a ref press after snapshot -i settles on the interactive view and lists what left', async () => {
  const { device, views } = createDevice({
    frame: screen(DIALOG, INTERACTIVE),
    after: ['Cancel', 'OK'],
  });

  const result = await device.interactions.press(ref('@e1'), { session: 'default', settle: {} });

  assert.ok(views.length > 0 && views.every((view) => view.interactiveOnly === true));
  assert.deepEqual(removed(result.settle?.diff?.lines).length, 1);
});

test.each([
  { interactiveOnly: true, scope: 'Device name' },
  { depth: 2 },
  { raw: true },
  { customActions: true },
])('a ref press preserves snapshot presentation %j when settling', async (presentation) => {
  const { device, views } = createDevice({ frame: screen(DIALOG, presentation) });

  const result = await device.interactions.press(ref('@e1'), { session: 'default', settle: {} });

  assert.ok(views.length > 0);
  for (const view of views) assert.deepEqual(view, presentation);
  assert.deepEqual(result.settle?.diff?.summary, {
    additions: 0,
    removals: 0,
    unchanged: presentation.interactiveOnly ? 3 : 4,
  });
});

test('a selector press resolved on the full tree still diffs in the ref frame view', async () => {
  // `label=Dialog` names the wrapper only the full tree holds, so resolution falls back to it.
  const { device, views } = createDevice({ frame: screen(DIALOG, INTERACTIVE) });

  const result = await device.interactions.press(selector('label=Dialog'), {
    session: 'default',
    settle: {},
  });

  assert.ok(views.length > 0 && views.every((view) => view.interactiveOnly === true));
  assert.deepEqual(removed(result.settle?.diff?.lines), []);
});

test.each([FULL, undefined])(
  'verify after a full snapshot (%j) reads unchanged content in the full view',
  async (presentation) => {
    const { device, views } = createDevice({ frame: screen(DIALOG, presentation) });

    const result = await device.interactions.press(ref('@e3'), {
      session: 'default',
      verify: true,
    });

    assert.deepEqual(views, [FULL]);
    assert.equal(result.evidence?.changedFromBefore, false);
  },
);

test('diff snapshot -i after a full snapshot starts a baseline instead of listing the view change', async () => {
  const { device } = createDevice({ frame: screen(DIALOG, FULL) });

  const interactive = await device.capture.diffSnapshot({
    session: 'default',
    interactiveOnly: true,
  });
  assert.equal(interactive.baselineInitialized, true);
  assert.deepEqual(interactive.summary, { additions: 0, removals: 0, unchanged: 3 });

  const again = await device.capture.diffSnapshot({ session: 'default', interactiveOnly: true });
  assert.equal(again.baselineInitialized, false);
  assert.deepEqual(again.summary, { additions: 0, removals: 0, unchanged: 3 });
});

test('diff snapshot starts a baseline when only an older ref frame matches the requested view', async () => {
  const { device } = createDevice({ frame: screen(DIALOG, INTERACTIVE) });
  // Selector reads replace the operational snapshot without issuing a new ref frame.
  await device.selectors.get({
    session: 'default',
    target: selector('label=Dialog'),
    property: 'text',
  });

  const result = await device.capture.diffSnapshot({ session: 'default', interactiveOnly: true });

  assert.equal(result.baselineInitialized, true);
  assert.deepEqual(result.summary, { additions: 0, removals: 0, unchanged: 3 });
});
