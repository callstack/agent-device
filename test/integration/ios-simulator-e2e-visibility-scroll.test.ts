import assert from 'node:assert/strict';
import test from 'node:test';

import type { CliJsonResult } from './cli-json.ts';
import {
  searchForVisibleElement,
  type ScrollSearchDevice,
} from './ios-simulator-e2e/live-assertions.ts';

function result(status: number, details?: Record<string, unknown>): CliJsonResult {
  return {
    json: details === undefined ? undefined : { error: { details } },
    status,
    stderr: '',
    stdout: '',
  };
}

const UNSETTLED = {
  postGestureOutcome: { kind: 'unsettled', gesture: { action: 'scroll', positionals: [] } },
};

/**
 * A vertical list the search drives. Offsets are in viewports; the target is visible while the
 * offset lies inside `visible`. Each scroll moves by the next planned travel, clamped to the list
 * bounds. `movesUntilSettled` keeps the surface moving after every scroll that moved until the
 * search pauses to settle it, so each read before that misses with an unsettled outcome: the CI
 * failure shape.
 */
function list(options: {
  visible?: readonly [number, number];
  downTravel?: readonly number[];
  end?: number;
  movesUntilSettled?: boolean;
}) {
  const downTravel = [...(options.downTravel ?? [])];
  const end = options.end ?? 10;
  let offset = 0;
  let moving = false;
  const log: string[] = [];
  const device: ScrollSearchDevice = {
    probeVisibility: async (probe) => {
      log.push(`probe ${probe}`);
      const [from, to] = options.visible ?? [Infinity, Infinity];
      if (!moving && offset >= from && offset <= to) return result(0);
      return result(1, moving ? UNSETTLED : { reason: 'selector_not_found' });
    },
    settle: async () => {
      log.push('settle');
      moving = false;
    },
    scroll: async (step) => {
      const travel = step.direction === 'down' ? (downTravel.shift() ?? 0.75) : -0.5;
      const next = Math.min(end, Math.max(0, offset + travel));
      const moved = next !== offset;
      offset = next;
      moving = options.movesUntilSettled === true && moved;
      log.push(`scroll ${step.direction} ${step.amount}`);
    },
  };
  return { device, log };
}

test('an existing offscreen element scrolls until the visibility probe passes', async () => {
  const { device, log } = list({ visible: [0.5, 1.2] });

  await searchForVisibleElement('id="target"', device);

  assert.deepEqual(log, ['probe 1', 'scroll down 0.75', 'probe 2']);
});

test('a stalled capture retries without scrolling or consuming an attempt', async () => {
  const probes = [result(1, { captureStalled: true }), result(0)];
  const scrolls: string[] = [];

  await searchForVisibleElement('id="target"', {
    probeVisibility: async () => probes.shift() ?? result(1),
    settle: async () => assert.fail('a stalled capture is not a moving surface'),
    scroll: async (step) => {
      scrolls.push(step.direction);
    },
  });

  assert.deepEqual([probes.length, scrolls], [0, []]);
});

test('a miss after a gesture that moved nothing is a real read, not a moving surface', async () => {
  const noEffect = {
    postGestureOutcome: { kind: 'no-effect', gesture: { action: 'scroll', positionals: [] } },
  };
  const probes = [result(1, noEffect), result(0)];
  const scrolls: string[] = [];

  await searchForVisibleElement('id="target"', {
    probeVisibility: async () => probes.shift() ?? result(1),
    settle: async () => assert.fail('a no-effect read is settled'),
    scroll: async (step) => {
      scrolls.push(step.direction);
    },
  });

  assert.deepEqual([probes.length, scrolls], [0, ['down']]);
});

test('an unsettled miss waits for the surface to settle and re-reads at the same offset', async () => {
  const { device, log } = list({ visible: [0.5, 1.2], movesUntilSettled: true });

  await searchForVisibleElement('id="target"', device);

  assert.deepEqual(log, ['probe 1', 'scroll down 0.75', 'probe 2', 'settle', 'probe 3']);
});

test('a forward scroll that overshoots the element is recovered by scrolling back', async () => {
  // Measured on an iOS 26 simulator under host load: one `scroll down 0.75` moved content 852 pt
  // instead of its usual 439-505 pt, which carried a one-row target past the viewport.
  const { device, log } = list({
    visible: [0.6, 1.25],
    downTravel: [1.4, 0.75, 0.75],
    end: 2.2,
    movesUntilSettled: true,
  });

  await searchForVisibleElement('id="target"', device);

  assert.deepEqual(
    log.filter((entry) => entry.startsWith('scroll')),
    ['scroll down 0.75', 'scroll down 0.75', 'scroll down 0.75', 'scroll up 0.5', 'scroll up 0.5'],
  );
});

test('a real absence still fails after both sweeps, naming every step', async () => {
  const { device, log } = list({ movesUntilSettled: true });

  await assert.rejects(
    searchForVisibleElement('id="target"', device),
    /scroll down 3: [\s\S]*scroll up 6: [\s\S]*probe \d+:/,
  );
  assert.deepEqual(
    log.filter((entry) => entry.startsWith('scroll')),
    [
      'scroll down 0.75',
      'scroll down 0.75',
      'scroll down 0.75',
      'scroll up 0.5',
      'scroll up 0.5',
      'scroll up 0.5',
    ],
  );
});
