import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { SessionState } from '../../core/session-state.ts';
import { makeIosSession } from '../../__tests__/support/session-factories.ts';
import { activateCompleteRefFrame } from '../../core/ref-frame.ts';

/**
 * #2714: a directional scroll answers with the movement it OBSERVED, and refuses to spend a
 * distance it did not earn. The observation math lives in `scroll-movement.test.ts`; these cases
 * prove the claim reaches the command, and that it stays out of every path that was never entitled
 * to read the screen — a runtime without a capture, a Maestro replay, a `--settle` caller, the macOS
 * desktop — or that the evidence for it was never there.
 */
export const SCREEN_CONTAINER = { x: 18, y: 178, width: 366, height: 662 };

export function automationScreen(rowOffset: number, hiddenBelow = true): SnapshotNode[] {
  return [
    {
      ref: 'e1',
      index: 1,
      depth: 0,
      type: 'ScrollView',
      identifier: 'lab-list',
      rect: SCREEN_CONTAINER,
      ...(hiddenBelow ? { hiddenContentBelow: true } : {}),
    },
    {
      ref: 'e2',
      index: 2,
      parentIndex: 1,
      depth: 1,
      type: 'StaticText',
      label: 'Row one',
      rect: { x: 24, y: 200 + rowOffset, width: 300, height: 20 },
    },
    {
      ref: 'e3',
      index: 3,
      parentIndex: 1,
      depth: 1,
      type: 'StaticText',
      label: 'Row two',
      rect: { x: 24, y: 260 + rowOffset, width: 300, height: 20 },
    },
  ];
}

export function frozenCaptures(frames: SnapshotNode[][]) {
  const queue = [...frames];
  let calls = 0;
  return {
    calls: () => calls,
    captureSnapshot: async () => {
      const next = queue.shift();
      if (next === undefined)
        throw new Error('scroll observed more captures than the case provided');
      calls += 1;
      return { nodes: next, backend: 'xctest', producer: 'apple-runner' };
    },
  };
}

export function sessionWithStoredScreen(
  nodes: SnapshotNode[],
  overrides?: Partial<SessionState>,
): SessionState {
  const session = makeIosSession('scroll-runtime', {
    snapshot: buildSnapshotState({ nodes, backend: 'xctest', producer: 'apple-runner' }, undefined),
    ...overrides,
  });
  activateCompleteRefFrame(session);
  return session;
}
