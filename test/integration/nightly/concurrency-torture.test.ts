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

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { runTorture, type ClientOp, type TortureRunResult } from './concurrency-torture/harness.ts';
import { DEVICE_POOL } from './concurrency-torture/bindings.ts';
import { measureRealScopeMaxOverlap } from './concurrency-torture/real-scope-serialization.ts';
import { buildEnvelope, writeEnvelopeIfRequested } from './concurrency-torture/envelope.ts';

// The #1430 envelope must report the outcome of the WHOLE lane, not just the
// sweep test. Every test records its result here and the envelope is written
// once, after all tests settle, so a later failing guardrail can never be
// published as a passing envelope.
type SweepRange = { seedStart: number; runs: number };
const laneStartedMs = Date.now();
let laneFailed = false;
let sweepRange: SweepRange | undefined;

async function guard(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    laneFailed = true;
    throw error;
  }
}

after(() => {
  if (!sweepRange) return; // only the sweep lane (nightly) publishes an envelope
  // Duration spans the WHOLE lane (sweep + replay + both serialization guards),
  // measured to this hook, so it can't understate work by excluding later tests.
  const envelope = buildEnvelope({
    ...sweepRange,
    startedAtMs: laneStartedMs,
    result: laneFailed ? 'fail' : 'pass',
  });
  const written = writeEnvelopeIfRequested(envelope);
  if (written) console.log(`torture envelope → ${written}\n${JSON.stringify(envelope)}`);
});

/**
 * Assert a seed replays bit-for-bit: same ordered scheduler trace, same terminal
 * invariant outcome, same contention profile. Run for EVERY seed in the sweep so
 * determinism is proven on the normal CI/nightly path, not only under TORTURE_SEED.
 */
function assertDeterministicReplay(result: TortureRunResult, replay: TortureRunResult): void {
  assert.equal(
    replay.traceSignature,
    result.traceSignature,
    `seed ${result.seed} produced a different scheduler trace on replay — non-determinism`,
  );
  assert.deepEqual(
    replay.failures,
    result.failures,
    `seed ${result.seed} produced a different invariant outcome on replay — non-determinism`,
  );
  assert.equal(
    replay.deviceContention,
    result.deviceContention,
    `seed ${result.seed} produced different device contention on replay — non-determinism`,
  );
}

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

// Seeds are non-negative (0 is a real, replayable seed): the sweeps start at
// seed 0 and print `TORTURE_SEED=0` on failure, so the replay parser MUST accept
// 0 — unlike client/op COUNTS, which must be strictly positive.
function optionalNonNegativeIntFromEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${raw}`);
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

const explicitSeed = optionalNonNegativeIntFromEnv('TORTURE_SEED');
const clients = optionalIntFromEnv('TORTURE_CLIENTS');
const opsPerClient = optionalIntFromEnv('TORTURE_OPS');

// Guard the PRODUCTION lock APPLICATION path, not just the modeled sweep: drive
// concurrent same-device opens through the real `createRequestExecutionScope()
// .runLocked()` (→ `withRequestExecutionLocks` → `withKeyedLock`) and assert
// they never overlap. Regressing production serialization trips this even
// though the seeded sweep models the grant. Runs in every mode.
test('concurrency torture — real-scope same-device serialization', () =>
  guard(async () => {
    const maxOverlap = await measureRealScopeMaxOverlap(4);
    assert.equal(
      maxOverlap,
      1,
      `real createRequestExecutionScope().runLocked() let ${maxOverlap} same-device critical ` +
        'sections overlap — production execution locking is not serializing',
    );
  }));

// Regression: seed 0 is inside the default/forced sweeps and failures print
// `TORTURE_SEED=0`, so that replay command must be runnable. The seed parser
// must accept 0 (a positive-only parser silently broke this), and seed 0 must
// itself replay bit-for-bit.
test('concurrency torture — seed 0 is a replayable seed', () =>
  guard(async () => {
    const probe = '__TORTURE_SEED_ZERO_PROBE__';
    process.env[probe] = '0';
    try {
      assert.equal(
        optionalNonNegativeIntFromEnv(probe),
        0,
        'TORTURE_SEED=0 must parse to seed 0 so the printed replay command works',
      );
    } finally {
      delete process.env[probe];
    }
    const result = await runTorture({ seed: 0 });
    assertDeterministicReplay(result, await runTorture({ seed: 0 }));
    assertClean(result);
  }));

if (explicitSeed !== undefined) {
  test(`concurrency torture — replay seed ${explicitSeed}`, () =>
    guard(async () => {
      const result = await runTorture({ seed: explicitSeed, clients, opsPerClient });
      const replay = await runTorture({ seed: explicitSeed, clients, opsPerClient });
      assertDeterministicReplay(result, replay);
      assertClean(result);
    }));
} else {
  const runs = intFromEnv('TORTURE_RUNS', 128);
  const seedStart = intFromEnv('TORTURE_SEED_START', 0);

  test(`concurrency torture — ${runs} seeded interleavings from ${seedStart}`, () =>
    guard(async () => {
      sweepRange = { seedStart, runs };
      let totalContention = 0;
      for (let i = 0; i < runs; i += 1) {
        const seed = seedStart + i;
        const result = await runTorture({ seed, clients, opsPerClient });
        totalContention += result.deviceContention;
        // Prove exact replay on the NORMAL sweep path (not just TORTURE_SEED):
        // re-run the seed and assert the whole trace + outcome + contention match.
        assertDeterministicReplay(result, await runTorture({ seed, clients, opsPerClient }));
        assertClean(result);
      }
      // The sweep must actually PRODUCE same-device contention — two clients
      // parked on one device lock — or the lane is not exercising serialization
      // and a broken lock could pass unnoticed.
      assert.ok(
        totalContention > 0,
        'no same-device lock contention occurred across the sweep — the lane is not testing serialization',
      );
    }));

  // Forced same-device contention: two clients repeatedly open THE SAME pinned
  // device (via `pinnedDevice`, so `doOpen` cannot randomly pick a different one).
  // This deterministically drives both onto one `device:` lock so the overlap
  // invariant is exercised, not just present. If the router stopped serializing
  // same-device opens, `deviceContention` here would collapse and the overlap
  // invariant would fire.
  test('concurrency torture — forced two-client same-device contention', () =>
    guard(async () => {
      const pinnedDevice = DEVICE_POOL[0];
      const program: ClientOp[][] = [
        ['open', 'mutate', 'close', 'open', 'mutate'],
        ['open', 'mutate', 'close', 'open', 'mutate'],
      ];
      let contendedSeeds = 0;
      for (let seed = 0; seed < 40; seed += 1) {
        const result = await runTorture({ seed, program, pinnedDevice });
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
    }));
}
