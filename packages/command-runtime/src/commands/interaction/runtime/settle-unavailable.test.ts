import assert from 'node:assert/strict';
import { test } from 'vitest';
import { selector } from './selector-read-utils.ts';
import { surfaceScopedNodes } from '@agent-device/capture-kit/snapshot-baseline';
import { settleObservationCommand } from './settle.ts';
import { settleUnavailable } from './settle-unavailable.ts';
import {
  buttonSnapshot,
  createFakeClock,
  createSettleDevice,
  welcomeSnapshot,
} from './__tests__/settle-device-fixtures.ts';

test('a broken settle capture never fails the action', async () => {
  const before = buttonSnapshot();
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      if (captures === 1) return { snapshot: before };
      throw new Error('AX bridge crashed');
    },
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    settle: {},
  });

  // The press itself succeeded; the observation reports its own failure.
  assert.equal(result.kind, 'selector');
  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.settled, false);
  assert.equal(settle.diff, undefined);
  assert.match(settle.hint ?? '', /Settle observation unavailable \(AX bridge crashed\)/);
});

test('a completed settle capture remains counted when the next backend read fails', async () => {
  const before = buttonSnapshot();
  const clock = createFakeClock();
  let backendReads = 0;
  const device = createSettleDevice({
    stored: before,
    clock,
    captureSnapshot: () => {
      backendReads += 1;
      if (backendReads === 1) return { snapshot: before }; // Selector resolution.
      if (backendReads === 2) {
        clock.advance(40);
        return { snapshot: welcomeSnapshot() };
      }
      clock.advance(25);
      throw new Error('AX bridge crashed');
    },
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    settle: { quietMs: 500, timeoutMs: 2_000 },
  });

  assert.equal(result.kind, 'selector');
  assert.equal(backendReads, 3);
  assert.equal(result.settle?.settled, false);
  assert.equal(result.settle?.captures, 1);
  assert.equal(clock.now(), 365);
  assert.equal(result.settle?.waitedMs, clock.now());
  assert.equal(result.settle?.quietMs, 500);
  assert.equal(result.settle?.diff, undefined);
  assert.equal(result.settle?.refs, undefined);
  assert.match(result.settle?.hint ?? '', /Settle observation unavailable \(AX bridge crashed\)/);
});

test('a failed session publication retains the completed loop outcome', async () => {
  const before = buttonSnapshot();
  const clock = createFakeClock();
  let backendReads = 0;
  const device = createSettleDevice({
    stored: before,
    clock,
    captureSnapshot: () => {
      backendReads += 1;
      return { snapshot: welcomeSnapshot() };
    },
  });
  device.sessions.set = () => {
    throw new Error('session write failed');
  };

  const observation = await settleObservationCommand(device, {
    session: 'default',
    baseline: surfaceScopedNodes(before),
    quietMs: 100,
    timeoutMs: 2_000,
  });

  assert.equal(observation.settled, false);
  assert.ok(backendReads >= 2);
  assert.equal(observation.captures, backendReads);
  assert.equal(observation.waitedMs, clock.now());
  assert.equal(observation.quietMs, 100);
  assert.equal(observation.diff, undefined);
  assert.equal(observation.refs, undefined);
  assert.match(observation.hint ?? '', /Settle observation unavailable \(session write failed\)/);
});

test('a failure before the loop returns keeps the initial counters', async () => {
  const before = buttonSnapshot();
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => ({ snapshot: welcomeSnapshot() }),
  });
  device.sessions.get = () => {
    throw new Error('session read failed');
  };

  const observation = await settleObservationCommand(device, {
    session: 'default',
    baseline: surfaceScopedNodes(before),
    timeoutMs: 2_000,
  });

  assert.equal(observation.settled, false);
  assert.equal(observation.captures, 0);
  assert.equal(observation.waitedMs, 0);
  assert.equal(observation.quietMs, 500);
  assert.equal(observation.diff, undefined);
  assert.match(observation.hint ?? '', /Settle observation unavailable \(session read failed\)/);
});

test('unavailable observation projects only completed loop counters', () => {
  const completedOutcome = {
    captures: 3,
    waitedMs: 240,
    quietMs: 300,
    settled: true,
    stalled: false,
  };
  const result = settleUnavailable(
    { settled: false, captures: 0, waitedMs: 0, quietMs: 500, timeoutMs: 2_000 },
    completedOutcome,
    new Error('presentation failed'),
  );
  assert.deepEqual(result.observation, {
    settled: false,
    captures: 3,
    waitedMs: 240,
    quietMs: 300,
    timeoutMs: 2_000,
    hint: 'Settle observation unavailable (presentation failed). The action itself succeeded; take a snapshot to observe the result.',
  });
});
