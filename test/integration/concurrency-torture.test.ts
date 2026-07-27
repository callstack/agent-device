// Seeded concurrency torture lane for session / lease / lock invariants (#1416,
// umbrella #1412 Track A).
//
// N concurrent clients drive randomized-but-SEEDED interleavings of
// open / mutate / close / takeover / kill against fake providers (the real
// `SessionStore` + `LeaseRegistry`, an in-memory device-claim model), with ALL
// concurrency routed through a deterministic scheduler so a seed fully
// determines execution order. After every run the harness asserts:
//   - no leaked leases or claims,
//   - no cross-session state bleed,
//   - every lock released after owner death,
//   - the session store stays consistent,
//   - same-device critical sections never overlap (this pins the router's
//     same-device open serialization under many interleavings).
//
// Seed replay (documented in docs/agents/testing.md):
//   TORTURE_SEED=1234 pnpm test:concurrency-torture
// replays that exact interleaving deterministically. Otherwise the lane sweeps
// TORTURE_RUNS seeds (default 128, ≥100 to satisfy the acceptance bar) starting
// at TORTURE_SEED_START (default 0). Any failure prints the seed and the exact
// replay command.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runTorture, type TortureRunResult } from './concurrency-torture/harness.ts';

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  }
  return parsed;
}

function optionalIntFromEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return parsed;
}

function replayHint(seed: number): string {
  return `Replay this exact interleaving with: TORTURE_SEED=${seed} pnpm test:concurrency-torture`;
}

function assertClean(result: TortureRunResult): void {
  if (result.failures.length === 0) return;
  const lines = result.failures.map((f) => `  - [${f.invariant}] ${f.detail}`);
  assert.fail(
    `Concurrency invariants violated on seed ${result.seed} ` +
      `(${result.clients} clients, ${result.ops} ops, ${result.scheduleLength} scheduled steps):\n` +
      `${lines.join('\n')}\n${replayHint(result.seed)}`,
  );
}

const explicitSeed = optionalIntFromEnv('TORTURE_SEED');
const clients = optionalIntFromEnv('TORTURE_CLIENTS');
const opsPerClient = optionalIntFromEnv('TORTURE_OPS');

if (explicitSeed !== undefined) {
  test(`concurrency torture — replay seed ${explicitSeed}`, async () => {
    const result = await runTorture({ seed: explicitSeed, clients, opsPerClient });
    // Determinism self-check: the same seed must reproduce the same schedule.
    const replay = await runTorture({ seed: explicitSeed, clients, opsPerClient });
    assert.equal(
      replay.scheduleLength,
      result.scheduleLength,
      `seed ${explicitSeed} produced a different schedule length on replay ` +
        `(${result.scheduleLength} vs ${replay.scheduleLength}) — non-determinism`,
    );
    assertClean(result);
  });
} else {
  const runs = intFromEnv('TORTURE_RUNS', 128);
  const seedStart = intFromEnv('TORTURE_SEED_START', 0);

  test(`concurrency torture — ${runs} seeded interleavings from ${seedStart}`, async () => {
    let exercisedSerialization = false;
    for (let i = 0; i < runs; i += 1) {
      const seed = seedStart + i;
      const result = await runTorture({ seed, clients, opsPerClient });
      assertClean(result);
      if (Object.values(result.perDeviceMaxConcurrency).some((max) => max >= 1)) {
        exercisedSerialization = true;
      }
    }
    // Sanity: the lane must actually enter device critical sections, otherwise a
    // regression could hollow it out into a no-op that always "passes".
    assert.ok(
      exercisedSerialization,
      'no device critical section was exercised across the sweep — the lane is not testing serialization',
    );
  });
}
