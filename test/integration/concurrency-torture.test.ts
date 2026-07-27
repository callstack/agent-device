// Seeded concurrency torture lane for session / lease / lock invariants (#1416,
// umbrella #1412 Track A).
//
// N concurrent clients drive randomized-but-SEEDED interleavings of
// open / mutate / close / takeover / kill against fake providers (the real
// `SessionStore` + `LeaseRegistry`, an in-memory device-claim model), with ALL
// concurrency routed through a deterministic scheduler so a seed fully
// determines execution order. Each operation's lock plan is derived from the
// production router primitive `resolveRequestExecutionLockKeys`, so reverting
// the router's same-device serialization trips the overlap invariant. After
// every run the harness asserts:
//   - no leaked leases or claims,
//   - no cross-session state bleed,
//   - every lock released after owner death,
//   - the session store stays consistent,
//   - same-device critical sections never overlap.
//
// Seed replay (documented in docs/agents/testing.md):
//   TORTURE_SEED=1234 pnpm test:concurrency-torture
// replays that exact interleaving deterministically — the whole scheduler trace,
// not just its length, is asserted equal. Otherwise the lane sweeps TORTURE_RUNS
// seeds (default 128, ≥100 to satisfy the acceptance bar) starting at
// TORTURE_SEED_START (default 0). Any failure prints the seed and replay command.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runTorture, type ClientOp, type TortureRunResult } from './concurrency-torture/harness.ts';
import { buildEnvelope, writeEnvelopeIfRequested } from './concurrency-torture/envelope.ts';

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
    // Determinism self-check: the same seed must reproduce the EXACT schedule,
    // the same terminal invariant outcome, and the same contention profile.
    const replay = await runTorture({ seed: explicitSeed, clients, opsPerClient });
    assert.equal(
      replay.traceSignature,
      result.traceSignature,
      `seed ${explicitSeed} produced a different scheduler trace on replay — non-determinism`,
    );
    assert.deepEqual(
      replay.failures,
      result.failures,
      `seed ${explicitSeed} produced a different invariant outcome on replay — non-determinism`,
    );
    assert.equal(
      replay.deviceContention,
      result.deviceContention,
      `seed ${explicitSeed} produced different device contention on replay — non-determinism`,
    );
    assertClean(result);
  });
} else {
  const runs = intFromEnv('TORTURE_RUNS', 128);
  const seedStart = intFromEnv('TORTURE_SEED_START', 0);

  test(`concurrency torture — ${runs} seeded interleavings from ${seedStart}`, async () => {
    const started = Date.now();
    let totalContention = 0;
    let failed = false;
    try {
      for (let i = 0; i < runs; i += 1) {
        const seed = seedStart + i;
        const result = await runTorture({ seed, clients, opsPerClient });
        totalContention += result.deviceContention;
        if (result.failures.length > 0) failed = true;
        assertClean(result);
      }
      // The sweep must actually PRODUCE same-device contention — two clients
      // parked on one device lock — or the lane is not exercising serialization
      // and a broken lock could pass unnoticed.
      assert.ok(
        totalContention > 0,
        'no same-device lock contention occurred across the sweep — the lane is not testing serialization',
      );
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const envelope = buildEnvelope({
        seedStart,
        runs,
        durationMs: Date.now() - started,
        result: failed ? 'fail' : 'pass',
      });
      const written = writeEnvelopeIfRequested(envelope);
      if (written) console.log(`torture envelope → ${written}\n${JSON.stringify(envelope)}`);
    }
  });

  // Forced same-device contention: two clients repeatedly open THE SAME pinned
  // device. This deterministically drives both onto one `device:` lock so the
  // overlap invariant is exercised, not just present. If the router stopped
  // serializing same-device opens, `deviceContention` here would collapse and
  // the overlap invariant would fire.
  test('concurrency torture — forced two-client same-device contention', async () => {
    const program: ClientOp[][] = [
      ['open', 'mutate', 'close', 'open', 'mutate'],
      ['open', 'mutate', 'close', 'open', 'mutate'],
    ];
    let contendedSeeds = 0;
    for (let seed = 0; seed < 40; seed += 1) {
      const result = await runTorture({ seed, program });
      assertClean(result);
      const perDeviceMax = Object.values(result.perDeviceMaxConcurrency);
      assert.ok(
        perDeviceMax.every((max) => max <= 1),
        `seed ${seed}: same-device critical sections overlapped — ${JSON.stringify(
          result.perDeviceMaxConcurrency,
        )}`,
      );
      if (result.deviceContention > 0) contendedSeeds += 1;
    }
    assert.ok(
      contendedSeeds > 0,
      'two clients never actually contended for the pinned device across 40 seeds — ' +
        'the forced-contention scenario is not exercising the device lock',
    );
  });
}
