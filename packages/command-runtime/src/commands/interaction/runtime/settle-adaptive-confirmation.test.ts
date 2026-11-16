import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotProvenance, SnapshotState } from '@agent-device/contracts/snapshot-model';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { ref, selector } from './selector-read-utils.ts';
import { createSettleDevice, welcomeSnapshot } from './__tests__/settle-device-fixtures.ts';
import {
  elementCatalogTabSnapshot,
  elementSettingsTabSnapshot,
} from './stable-capture.fixtures.ts';

// The internal adaptive confirmation prototype: a capture that differs from a fresh pre-action
// baseline settles once one short confirmation agrees with it; every escalation keeps the quiet
// window. Each case runs the same capture sequence with the switch on and off, so the difference
// is the rule's and not the fixture's. Budgets run on the injected clock; captures cost nothing.

const DEFAULT_QUIET_MS = 500;

/** The welcome screen after a press relabels its heading in place: no broad replacement. */
function relabeled(label = 'Welcome back!'): SnapshotState {
  const base = welcomeSnapshot();
  return {
    ...base,
    nodes: base.nodes.map((node) => (node.index === 0 ? { ...node, label } : node)),
  };
}

function withProvenance<P extends SnapshotProvenance>(state: SnapshotState, provenance: P) {
  return { ...state, ...provenance };
}

function withSpinner(snapshot: SnapshotState): SnapshotState {
  return makeSnapshotState([
    ...snapshot.nodes,
    {
      index: snapshot.nodes.length,
      depth: 1,
      parentIndex: 0,
      type: 'ActivityIndicator',
      label: 'In progress',
      rect: { x: 10, y: 400, width: 20, height: 20 },
    },
  ]);
}

/**
 * An @ref press on the stored tree, whose loop captures follow `loop` (the last one repeats). The
 * native ref route captures nothing before the action, so the stored tree is the baseline, fresh
 * here because the daemon reports that observation current.
 */
async function press(params: {
  stored?: SnapshotState;
  loop: SnapshotState[];
  adaptive: boolean;
  quietMs?: number;
  target?: Parameters<ReturnType<typeof createSettleDevice>['interactions']['press']>[0];
}) {
  let captures = 0;
  const device = createSettleDevice({
    stored: params.stored ?? welcomeSnapshot(),
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: params.loop[Math.min(captures, params.loop.length) - 1]! };
    },
  });
  const result = await device.interactions.press(params.target ?? ref('@e2'), {
    session: 'default',
    settle: {
      ...(params.adaptive ? { earlyExit: 'adaptive' as const, observationCurrent: true } : {}),
      ...(params.quietMs === undefined ? {} : { quietMs: params.quietMs }),
    },
  });
  assert.ok(result.settle);
  return result.settle;
}

test('a changed capture that the next capture confirms settles before the quiet window', async () => {
  const loop = [relabeled(), relabeled()];

  const adaptive = await press({ loop, adaptive: true });
  const quiet = await press({ loop, adaptive: false });

  assert.equal(adaptive.settled, true);
  assert.equal(adaptive.captures, 2);
  assert.ok(adaptive.waitedMs < 200, `adaptive held ${adaptive.waitedMs}ms`);
  // The run reports the span the confirming pair held, not the window it never waited out.
  assert.equal(adaptive.quietMs, adaptive.waitedMs);
  assert.ok(quiet.quietMs >= DEFAULT_QUIET_MS);
  assert.ok(adaptive.diff?.lines.some((line) => line.text.includes('Welcome back!')));
  assert.equal(quiet.settled, true);
  assert.ok(quiet.waitedMs >= DEFAULT_QUIET_MS, `quiet window held ${quiet.waitedMs}ms`);
});

test('a confirmation that disagrees falls back to the full quiet window', async () => {
  const adaptive = await press({
    loop: [relabeled('Loading'), relabeled('Welcome back!')],
    adaptive: true,
  });

  assert.equal(adaptive.settled, true);
  assert.ok(adaptive.waitedMs >= DEFAULT_QUIET_MS, `adaptive held ${adaptive.waitedMs}ms`);
  assert.ok(adaptive.diff?.lines.some((line) => line.text.includes('Welcome back!')));
});

test('a capture that still matches the baseline keeps the quiet window', async () => {
  const adaptive = await press({ loop: [welcomeSnapshot()], adaptive: true });

  assert.equal(adaptive.settled, true);
  assert.ok(adaptive.waitedMs >= DEFAULT_QUIET_MS, `adaptive held ${adaptive.waitedMs}ms`);
});

test('a change that arrives after an unchanged capture is confirmed on its own', async () => {
  const adaptive = await press({
    loop: [welcomeSnapshot(), relabeled(), relabeled()],
    adaptive: true,
  });

  assert.equal(adaptive.settled, true);
  assert.equal(adaptive.captures, 3);
  assert.ok(adaptive.waitedMs < DEFAULT_QUIET_MS, `adaptive held ${adaptive.waitedMs}ms`);
});

test('a busy indicator on the changed screen keeps the quiet window', async () => {
  const loop = [withSpinner(relabeled())];

  const adaptive = await press({ loop, adaptive: true });

  assert.equal(adaptive.settled, true);
  assert.ok(adaptive.waitedMs >= DEFAULT_QUIET_MS, `adaptive held ${adaptive.waitedMs}ms`);
});

test('a confirmation from another producer keeps the quiet window', async () => {
  const adaptive = await press({
    loop: [
      withProvenance(relabeled(), { backend: 'xctest', producer: 'apple-runner' }),
      withProvenance(relabeled(), { backend: 'xctest', producer: 'appium-source' }),
    ],
    adaptive: true,
  });

  assert.equal(adaptive.settled, true);
  assert.ok(adaptive.waitedMs >= DEFAULT_QUIET_MS, `adaptive held ${adaptive.waitedMs}ms`);
});

test('a presented surface the baseline did not show keeps the quiet window', async () => {
  const adaptive = await press({
    stored: { ...welcomeSnapshot(), presentedSurface: 'absent' },
    loop: [{ ...relabeled(), presentedSurface: 'presented' }],
    adaptive: true,
  });

  assert.equal(adaptive.settled, true);
  assert.ok(adaptive.waitedMs >= DEFAULT_QUIET_MS, `adaptive held ${adaptive.waitedMs}ms`);
});

test('a broad replacement owed the confirmation floor keeps the floor', async () => {
  const settings = elementSettingsTabSnapshot();

  const adaptive = await press({
    stored: { ...elementCatalogTabSnapshot(), presentedSurface: 'unknown' },
    loop: [settings],
    adaptive: true,
    target: ref(`@${elementCatalogTabSnapshot().nodes.find((node) => node.ref)!.ref}`),
  });

  assert.equal(adaptive.settled, true);
  assert.ok(adaptive.waitedMs >= 1_500, `adaptive lost the floor: ${adaptive.waitedMs}ms`);
});

test('a broad replacement under a requested window above the floor keeps that window', async () => {
  // The floor raises nothing here, but the run still proved a broad replacement.
  const adaptive = await press({
    stored: { ...elementCatalogTabSnapshot(), presentedSurface: 'unknown' },
    loop: [elementSettingsTabSnapshot()],
    adaptive: true,
    quietMs: 2_000,
    target: ref(`@${elementCatalogTabSnapshot().nodes.find((node) => node.ref)!.ref}`),
  });

  assert.equal(adaptive.settled, true);
  assert.ok(
    adaptive.waitedMs >= 2_000,
    `adaptive lost the requested window: ${adaptive.waitedMs}ms`,
  );
});

test('a point press whose baseline is the stored tree keeps the quiet window', async () => {
  // The pre-action evidence capture fails, so the baseline falls back to the stored tree, which may
  // predate a side effect: a change against it does not prove the action's effect.
  let captures = 0;
  const device = createSettleDevice({
    stored: welcomeSnapshot(),
    captureSnapshot: () => {
      captures += 1;
      if (captures === 1) throw new Error('capture unavailable');
      return { snapshot: relabeled() };
    },
  });

  const result = await device.interactions.press(
    { kind: 'point', x: 50, y: 100 },
    { session: 'default', settle: { earlyExit: 'adaptive' } },
  );

  assert.equal(result.settle?.settled, true);
  assert.ok(result.settle.waitedMs >= DEFAULT_QUIET_MS, `held ${result.settle.waitedMs}ms`);
});

test('a capture that holds the baseline beside a new screen keeps the quiet window', async () => {
  // A navigation transition can publish both screens at once and hold that union across captures.
  const base = welcomeSnapshot();
  const union = makeSnapshotState([
    ...base.nodes,
    ...['Detail', 'Buy', 'Share'].map((label, offset) => ({
      index: base.nodes.length + offset,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label,
      rect: { x: 200, y: 20 + offset * 60, width: 100, height: 40 },
    })),
  ]);

  const adaptive = await press({ loop: [union], adaptive: true });

  assert.equal(adaptive.settled, true);
  assert.ok(adaptive.waitedMs >= DEFAULT_QUIET_MS, `adaptive held ${adaptive.waitedMs}ms`);
});

for (const [label, observationCurrent, early] of [
  ['a current observation is a fresh baseline', true, true],
  ['a frame the daemon reports outdated keeps the quiet window', false, false],
] as const) {
  test(`a selector press read in another view than the frame: ${label}`, async () => {
    // The resolution capture carries no presentation, the frame is interactive-only, so the settle
    // baseline is the frame itself and only the daemon can say whether it is current.
    const frame = { ...welcomeSnapshot(), presentation: { interactiveOnly: true } };
    let captures = 0;
    const device = createSettleDevice({
      stored: frame,
      refFrame: frame,
      captureSnapshot: () => {
        captures += 1;
        return { snapshot: captures === 1 ? welcomeSnapshot() : relabeled() };
      },
    });

    const result = await device.interactions.press(selector('label=Next'), {
      session: 'default',
      settle: { earlyExit: 'adaptive', observationCurrent },
    });

    assert.equal(result.settle?.settled, true);
    assert.equal(result.settle.waitedMs < DEFAULT_QUIET_MS, early, `${result.settle.waitedMs}ms`);
  });
}

for (const [label, observationCurrent, early] of [
  ['a current observation is a fresh baseline', true, true],
  ['a frame the daemon reports outdated keeps the quiet window', false, false],
] as const) {
  test(`an @ref press on the stored frame: ${label}`, async () => {
    // The ref route resolves against the stored frame and captures nothing before the action, so the
    // frame is the baseline. After `wait text` (or an Android freshness read) the frame stays active
    // but no longer describes the screen, and only the daemon knows that.
    const frame = welcomeSnapshot();
    let captures = 0;
    const device = createSettleDevice({
      stored: frame,
      refFrame: frame,
      captureSnapshot: () => {
        captures += 1;
        return { snapshot: relabeled() };
      },
    });

    const result = await device.interactions.press(ref('@e2'), {
      session: 'default',
      settle: { earlyExit: 'adaptive', observationCurrent },
    });

    assert.equal(captures > 0, true);
    assert.equal(result.settle?.settled, true);
    assert.equal(result.settle.waitedMs < DEFAULT_QUIET_MS, early, `${result.settle.waitedMs}ms`);
  });
}

test('a capture on an iOS system surface the baseline did not show keeps the quiet window', async () => {
  // An app action can raise an in-place system surface (a web sign-in sheet, #2438); two equal
  // captures of it are not the app settling.
  const sheet = { ...relabeled(), iosSystemSurfaceBundleId: 'com.apple.SafariViewService' };

  const adaptive = await press({ loop: [sheet], adaptive: true });

  assert.equal(adaptive.settled, true);
  assert.ok(adaptive.waitedMs >= DEFAULT_QUIET_MS, `adaptive held ${adaptive.waitedMs}ms`);
});
