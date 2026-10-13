import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotProvenance, SnapshotState } from '@agent-device/kernel/snapshot';
import { ref } from './selector-read-utils.ts';
import {
  buttonSnapshot,
  createSettleDevice,
  welcomeSnapshot,
} from './__tests__/settle-device-fixtures.ts';

// The `--settle` DEFAULT quiet window keys on the capture the settle loop PERFORMS (#3470
// follow-up), because that read is the one the window prices: the loop holds its quiet window open
// across captures of its own. The pre-action baseline cannot answer this — on the ref route it is
// the stored ref frame, on the generic route the session's stored tree, and either can be several
// commands stale and served by a producer other than the one settle then reads through. A caller
// that asks for a window with `--settle-quiet` always outranks the default.
//
// Budgets are injected (fake clock) — no real waiting.

function withProvenance<P extends SnapshotProvenance>(state: SnapshotState, provenance: P) {
  return { ...state, ...provenance };
}

const BRIDGE = { backend: 'xctest', producer: 'simulator-ax-bridge' } as const;
const RUNNER = { backend: 'xctest', producer: 'apple-runner' } as const;

/**
 * A press whose baseline and whose loop captures come from declared capture paths, so the two can
 * be made to agree or to disagree.
 */
function pressWithCapturePaths(params: {
  baseline?: SnapshotProvenance;
  loop?: SnapshotProvenance;
  settle?: { quietMs?: number; timeoutMs?: number };
}) {
  const baseline = params.baseline
    ? withProvenance(buttonSnapshot(), params.baseline)
    : buttonSnapshot();
  let captures = 0;
  const device = createSettleDevice({
    stored: baseline,
    captureSnapshot: () => {
      captures += 1;
      // A ref press captures nothing before the action, so every call is the loop's own sample.
      const settled = welcomeSnapshot();
      return {
        snapshot:
          captures === 1 ? baseline : params.loop ? withProvenance(settled, params.loop) : settled,
      };
    },
  });
  return device.interactions.press(ref('@e1'), { session: 'default', settle: params.settle ?? {} });
}

test('a settle the simulator snapshot bridge performs uses the shorter default window', async () => {
  const result = await pressWithCapturePaths({ loop: BRIDGE });

  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.settled, true);
  assert.equal(settle.quietMs, 300);
});

test('an explicit --settle-quiet outranks the per-capture default window', async () => {
  const result = await pressWithCapturePaths({ loop: BRIDGE, settle: { quietMs: 700 } });

  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.quietMs, 700);
});

// Each of these is a read the 300 ms default was NOT measured on, so shortening its window would be
// an unmeasured change of behaviour rather than the measured one. The Apple runner shares the
// `xctest` CHANNEL with the bridge, which is why the rule keys on the producer.
const UNMEASURED_CAPTURES: Array<[string, SnapshotProvenance?]> = [
  ['the Apple runner tree read (same channel, different producer)', RUNNER],
  ['an Appium-sourced tree on the same channel', { backend: 'xctest', producer: 'appium-source' }],
  ['the Android helper', { backend: 'android', producer: 'android-uiautomator' }],
  ['a capture that declares no provenance at all', undefined],
];

for (const [label, provenance] of UNMEASURED_CAPTURES) {
  test(`${label} keeps the 500ms default window`, async () => {
    const result = await pressWithCapturePaths({ loop: provenance });

    const settle = result.settle;
    assert.ok(settle);
    assert.equal(settle.quietMs, 500);
  });
}

test('a bridge read during settle earns the shorter window even from a runner-issued ref frame', async () => {
  // The ref frame the action was authorized against came from the runner, so keying the window on
  // the baseline would hold the unmeasured 500 ms against captures the bridge answered.
  const result = await pressWithCapturePaths({ baseline: RUNNER, loop: BRIDGE });

  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.quietMs, 300);
});

test('a runner read during settle keeps the 500ms window despite a bridge-issued baseline', async () => {
  // The unsafe direction of the same mismatch: holding 300 ms for a read priced at 500 ms would
  // settle on a window the measurement never covered.
  const result = await pressWithCapturePaths({ baseline: BRIDGE, loop: RUNNER });

  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.quietMs, 500);
});

test('the shorter default window never shortens a broad-transition confirmation', async () => {
  // The trap this layer owes layer 1: a 300 ms default sits under the 1.5 s floor, so a rule that
  // armed on `requestedQuietMs >= DEFAULT_STABLE_QUIET_MS` would silently switch the #1831
  // confirmation off for every default settle the bridge answers. Here the pre-action tree is the
  // tiny-baseline shape, so the confirmation owns the wait and the 300 ms default still holds its
  // 1.5 s floor (#3470).
  const sparseBaseline = withProvenance(buttonSnapshot(), BRIDGE);
  let captures = 0;
  const device = createSettleDevice({
    stored: sparseBaseline,
    captureSnapshot: () => {
      captures += 1;
      return {
        snapshot: captures === 1 ? sparseBaseline : withProvenance(welcomeSnapshot(), BRIDGE),
      };
    },
  });

  const result = await device.interactions.press(ref('@e1'), {
    session: 'default',
    settle: { timeoutMs: 5_000 },
  });

  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.settled, true);
  assert.equal(settle.quietMs, 300);
  assert.ok(
    settle.waitedMs >= 1_500,
    `confirmation did not outlast the shorter default: waitedMs=${settle.waitedMs}`,
  );
});
