import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createCommandKillSettlement } from './command-kill-settlement.ts';

function buildSettlement(): {
  state: { kills: number; settled: (number | null)[] };
  settlement: ReturnType<typeof createCommandKillSettlement>;
} {
  const state = { kills: 0, settled: [] as (number | null)[] };
  const settlement = createCommandKillSettlement({
    killProcessTree: () => {
      state.kills += 1;
    },
    settle: (code) => state.settled.push(code),
  });
  return { state, settlement };
}

test('a kill request waits for the child it signalled', () => {
  const { state, settlement } = buildSettlement();
  settlement.requestKill();
  assert.equal(state.kills, 1);
  assert.deepEqual(state.settled, []);
});

test('a kill request settles the child exit that follows it', () => {
  const { state, settlement } = buildSettlement();
  settlement.requestKill();
  settlement.recordExit(137);
  assert.equal(state.kills, 1);
  assert.deepEqual(state.settled, [137]);
});

test('a child that exited on its own settles at the kill request that follows', () => {
  const { state, settlement } = buildSettlement();
  settlement.recordExit(0);
  settlement.requestKill();
  assert.equal(state.kills, 1);
  assert.deepEqual(state.settled, [0]);
});

test('an exit with no kill request behind it settles nothing', () => {
  const { state, settlement } = buildSettlement();
  settlement.recordExit(0);
  assert.equal(state.kills, 0);
  assert.deepEqual(state.settled, []);
});

test('a missing exit code reaches settlement as a failure', () => {
  const { state, settlement } = buildSettlement();
  settlement.recordExit(null);
  settlement.requestKill();
  assert.deepEqual(state.settled, [1]);
});
