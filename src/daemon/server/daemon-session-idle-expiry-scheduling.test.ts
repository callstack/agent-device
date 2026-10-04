import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { withKeyedLock } from '@agent-device/kernel/keyed-lock';
import { createSessionIdleExpiry } from './daemon-session-idle-expiry.ts';
import {
  createIdleExpiryHarness,
  CLAIM,
  NOW,
  WINDOW_MS,
} from '../__tests__/session-idle-expiry-harness.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';

/**
 * #2833: WHEN the reaper starts an expiry and how long it may take. The window that arms it, the
 * ceiling on a delay a Node timer can express, the session's and device's execution locks it must
 * wait behind, the budget on how long anyone waits for it, the deferral a failed or in-flight release
 * owes before another attempt, and the daemon that begins to leave while a sweep is running.
 *
 * What an expiry that runs actually COMMITS is `daemon-session-idle-expiry.test.ts`.
 */
const harness = createIdleExpiryHarness();
const {
  makeFixture,
  idleClaimedSession,
  sessionWithLiveClaim,
  claimFileHeld,
  runUntilIdle,
  waitFor,
  boundAbsence,
  createSweepBarrier,
} = harness;

test('a session still inside its window survives a sweep that actually ran', async () => {
  const { sessionStore } = makeFixture('agent-device-idle-expiry-active-');
  const session = idleClaimedSession(sessionStore);
  session.lastActivityAtMs = NOW;
  // A second session that IS past its window and holding a claim. Without it `nextDueMs` sees nothing
  // due and arms no timer at all, so a sweep never runs and `settleCalls === 0` would pass even for a
  // reaper that ignored the window entirely. This one gives the sweep a reason to run, which is what
  // puts the fresh session in front of the deadline re-check this test is about.
  idleClaimedSession(sessionStore, 'expired');
  const settledNames: string[] = [];
  const sweeps = createSweepBarrier();

  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: WINDOW_MS,
    executionLocks: new Map(),
    settleSession: async ({ address: sessionName }) => {
      settledNames.push(sessionName);
    },
    withinDiagnosticsScope: sweeps.withinDiagnosticsScope,
    now: () => NOW,
  });
  controller.noteSessionsChanged();
  await sweeps.swept();

  assert.deepEqual(
    settledNames,
    ['expired'],
    'the sweep ran and reached both sessions, settling only the one past its window',
  );
  assert.notEqual(sessionStore.get('default'), undefined);
  controller.cancel();
});

test('the policy being off arms nothing at all, even for a long-dead session', async () => {
  const { sessionStore } = makeFixture('agent-device-idle-expiry-off-');
  idleClaimedSession(sessionStore);
  let settleCalls = 0;

  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: 0,
    executionLocks: new Map(),
    settleSession: async () => {
      settleCalls++;
    },
    now: () => NOW,
  });
  await runUntilIdle(controller, 20);

  assert.equal(controller.idleExpiryMs, 0);
  assert.equal(settleCalls, 0);
  assert.notEqual(sessionStore.get('default'), undefined);
});

// Node's own ceiling, not a knob the module exposes: above this a `setTimeout` delay is silently
// replaced by 1 ms. The two tests below assert against that platform fact.
const NODE_MAX_TIMER_DELAY_MS = 2_147_483_647;
// 30 days: past that ceiling, and a perfectly readable way for an operator to say "essentially
// never". `resolveSessionIdleExpiryMs` accepts it because off is spelled `0`, not `huge`.
const LONG_WINDOW_MS = 30 * 24 * 60 * 60_000;

test('a window longer than a timer can express does not sweep a session that is inside it', async () => {
  const { sessionStore } = makeFixture('agent-device-idle-expiry-long-window-quiet-');
  const session = idleClaimedSession(sessionStore);
  session.lastActivityAtMs = NOW;
  let sweeps = 0;

  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: LONG_WINDOW_MS,
    executionLocks: new Map(),
    settleSession: async () => {
      throw new Error('a 30-day window must not expire a session milliseconds after it opened');
    },
    // The scope wraps exactly one sweep, so it counts sweeps without a test-only seam.
    withinDiagnosticsScope: async (run) => {
      sweeps++;
      await run();
    },
    now: () => NOW,
  });
  await runUntilIdle(controller, 50);

  assert.equal(sweeps, 0, 'a long window waits; it does not poll every millisecond');
  assert.notEqual(sessionStore.get('default'), undefined);
  controller.cancel();
});

test('a window longer than a timer can express still expires once the window elapses', async () => {
  vi.useFakeTimers();
  try {
    const { sessionStore } = makeFixture('agent-device-idle-expiry-long-window-due-');
    // A ticking clock, because what this asserts happens after more than a day of waiting.
    let clock = NOW;
    let sweeps = 0;
    const session = idleClaimedSession(sessionStore);
    session.lastActivityAtMs = NOW;

    const controller = createSessionIdleExpiry({
      sessionStore,
      idleExpiryMs: LONG_WINDOW_MS,
      executionLocks: new Map(),
      settleSession: async () => {},
      withinDiagnosticsScope: async (run) => {
        sweeps++;
        await run();
      },
      now: () => clock,
    });
    controller.noteSessionsChanged();

    // The first piece of the wait ends with the deadline still ahead.
    await vi.advanceTimersByTimeAsync(NODE_MAX_TIMER_DELAY_MS + 1_000);
    assert.equal(sweeps, 0, 'a piece that ends early re-arms instead of sweeping');
    assert.notEqual(sessionStore.get('default'), undefined);

    clock = NOW + LONG_WINDOW_MS;
    await vi.advanceTimersByTimeAsync(2 * NODE_MAX_TIMER_DELAY_MS + 5_000);
    assert.equal(sweeps, 1, 'the sweep runs once the deadline is finally reached');
    assert.equal(sessionStore.get('default'), undefined);
    controller.cancel();
  } finally {
    vi.useRealTimers();
  }
});

test('an expiry waits for the session lock a command of its own holds', async () => {
  const { sessionStore } = makeFixture('agent-device-idle-expiry-session-lock-');
  idleClaimedSession(sessionStore);
  const locks = new Map<string, Promise<unknown>>();
  let settleCalls = 0;
  const sweeps = createSweepBarrier();

  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: WINDOW_MS,
    executionLocks: locks,
    settleSession: async () => {
      settleCalls++;
    },
    withinDiagnosticsScope: sweeps.withinDiagnosticsScope,
    now: () => NOW,
  });

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const command = withKeyedLock(locks, 'session:default', async () => {
    await held;
  });

  controller.noteSessionsChanged();
  await boundAbsence(40);
  assert.equal(settleCalls, 0, 'a mid-command session must not be expired');
  assert.notEqual(sessionStore.get('default'), undefined);

  release();
  await command;
  // No budget is configured, so the scope does not resolve until the settle is over. Reaching here is
  // the proof that the sweep really ran — which is what makes the zero above mean "waited" rather than
  // "never started".
  await sweeps.swept(1);
  assert.equal(settleCalls, 1, 'the same expiry settles once the lock is free');
  controller.cancel();
});

test('an expiry waits for the DEVICE lock a command on another session holds', async () => {
  const { sessionStore } = makeFixture('agent-device-idle-expiry-device-lock-');
  idleClaimedSession(sessionStore);
  const locks = new Map<string, Promise<unknown>>();
  let settleCalls = 0;
  const sweeps = createSweepBarrier();

  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: WINDOW_MS,
    executionLocks: locks,
    settleSession: async () => {
      settleCalls++;
    },
    withinDiagnosticsScope: sweeps.withinDiagnosticsScope,
    now: () => NOW,
  });

  // Another session's command on the SAME device: no session-key overlap, so only the device key
  // can prove the expiry is not about to free a device that is under work.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const command = withKeyedLock(locks, 'device:sim-1', async () => {
    await held;
  });

  controller.noteSessionsChanged();
  await boundAbsence(40);
  assert.equal(settleCalls, 0);
  assert.notEqual(sessionStore.get('default'), undefined);

  release();
  await command;
  await sweeps.swept(1);
  assert.equal(settleCalls, 1);
  controller.cancel();
});

test('a command that re-stamped activity while the expiry queued cancels it', async () => {
  const { sessionStore } = makeFixture('agent-device-idle-expiry-restamp-');
  idleClaimedSession(sessionStore);
  const locks = new Map<string, Promise<unknown>>();
  let settleCalls = 0;
  let commandFinished = false;
  let sweptWhileHeld = false;
  let sweepsCompleted = 0;

  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: WINDOW_MS,
    executionLocks: locks,
    settleSession: async () => {
      settleCalls++;
    },
    withinDiagnosticsScope: async (run) => {
      // The sweep starting while the command still holds the lock is what makes the zero below mean
      // "refused inside the lock" rather than "never got around to it".
      sweptWhileHeld = sweptWhileHeld || !commandFinished;
      await run();
      sweepsCompleted++;
    },
    now: () => NOW,
  });

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const command = withKeyedLock(locks, 'session:default', async () => {
    await held;
    // The command finishes and re-stamps the session. The store hands out the live record, so this
    // is a durable write; a sweep that trusted the reference it swept would not see it.
    sessionStore.noteSessionActivity('default', NOW);
  });

  controller.noteSessionsChanged();
  await runUntilIdle(controller, 10);
  release();
  await command;
  commandFinished = true;
  await waitFor(() => sweepsCompleted > 0, 'a sweep to complete');

  assert.equal(sweptWhileHeld, true, 'the sweep began while the command held the lock');
  assert.equal(settleCalls, 0, 'the deadline is re-checked inside the lock, not at scheduling');
  assert.notEqual(sessionStore.get('default'), undefined);
  controller.cancel();
});

test('a session that moved to another device is fenced by that device, not the swept one', async () => {
  const { sessionStore } = makeFixture('agent-device-idle-expiry-device-moved-');
  idleClaimedSession(sessionStore);
  const locks = new Map<string, Promise<unknown>>();
  const settledDeviceIds: string[] = [];
  const sweeps = createSweepBarrier();

  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: WINDOW_MS,
    executionLocks: locks,
    settleSession: async ({ session }) => {
      settledDeviceIds.push(session.device.id);
    },
    withinDiagnosticsScope: sweeps.withinDiagnosticsScope,
    now: () => NOW,
  });

  // The sweep picks its lock pair from the session it found. A command on that session can replace
  // the record with one bound to a DIFFERENT device while the expiry is queued, and settling THAT
  // session under the swept device's lock would free a device nothing here holds.
  let releaseCommand!: () => void;
  const commandHeld = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });
  const command = withKeyedLock(locks, 'session:default', async () => {
    await commandHeld;
    sessionStore.set(
      'default',
      makeIosSession('default', {
        createdAt: NOW - WINDOW_MS - 1,
        device: { ...IOS_SIMULATOR, id: 'sim-2', name: 'iPhone 17' },
        deviceClaim: { ...CLAIM, deviceKey: 'ios:sim-2' },
      }),
    );
  });

  // A command on the NEW session's device is in flight the whole time.
  let releaseDevice!: () => void;
  const deviceHeld = new Promise<void>((resolve) => {
    releaseDevice = resolve;
  });
  const otherCommand = withKeyedLock(locks, 'device:sim-2', async () => {
    await deviceHeld;
  });

  controller.noteSessionsChanged();
  await runUntilIdle(controller, 10);
  releaseCommand();
  await command;
  // Bounded, and then closed properly: the sweep that queued is still inside the device lock, so
  // `swept` below is the fact that it eventually ran rather than a window in which nothing happened.
  assert.deepEqual(settledDeviceIds, [], 'nothing settles while the settled device is held');

  releaseDevice();
  await otherCommand;
  // Not the barrier: the sweep that found the device held completed too, and it settled nothing. This
  // waits for the settle itself, which no budget short-circuits.
  await waitFor(() => settledDeviceIds.length > 0, 'the expiry to settle the moved session');

  // And what it does settle is the session it now holds the device lock for.
  assert.deepEqual(settledDeviceIds, ['sim-2']);
  controller.cancel();
});

test('a settle that outlives the budget is caught by the sweep rather than the process handler', async () => {
  const { sessionStore } = makeFixture('agent-device-idle-expiry-budget-');
  idleClaimedSession(sessionStore);
  const sweeps = createSweepBarrier();
  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: WINDOW_MS,
    executionLocks: new Map(),
    settleSession: async () => {
      throw new Error('teardown exceeded its budget');
    },
    withinDiagnosticsScope: sweeps.withinDiagnosticsScope,
    now: () => NOW,
  });
  controller.noteSessionsChanged();
  await sweeps.swept();
  // Reached here rather than an unhandled rejection, which would shut the daemon down.
  assert.notEqual(sessionStore.get('default'), undefined);
  controller.cancel();
});

test('a sweep runs inside the composition diagnostics scope it is given', async () => {
  const { sessionStore } = makeFixture('agent-device-idle-expiry-scope-');
  idleClaimedSession(sessionStore);
  const scopes: string[] = [];

  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: WINDOW_MS,
    executionLocks: new Map(),
    settleSession: async () => {},
    withinDiagnosticsScope: async (run) => {
      scopes.push('entered');
      await run();
      scopes.push('flushed');
    },
    now: () => NOW,
  });
  controller.noteSessionsChanged();
  // `flushed` is written after the sweep resolves, so waiting for it waits for the whole sweep.
  await waitFor(() => scopes.includes('flushed'), 'the scope to flush after the sweep');

  assert.deepEqual(scopes, ['entered', 'flushed']);
  controller.cancel();
});

test('a settle that outruns its wait still finishes the release it started', async () => {
  const fixture = makeFixture('agent-device-idle-expiry-over-budget-');
  const { sessionStore } = fixture;
  const { deviceClaim } = await sessionWithLiveClaim(fixture);
  let releaseSettle!: () => void;
  const settleHeld = new Promise<void>((resolve) => {
    releaseSettle = resolve;
  });
  let settleCalls = 0;
  // A clock that can move: the deferred retry is measured against this clock, so a frozen one would
  // answer "may a second teardown join the first?" with "the retry isn't due yet" and prove nothing.
  let clock = NOW;

  // A window short enough that the retry becomes reachable while the settle is still stuck.
  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: 40,
    executionLocks: new Map(),
    settleSession: async () => {
      settleCalls++;
      await settleHeld;
    },
    settleBudgetMs: () => 10,
    now: () => clock,
  });
  // Arrival is waited for; the bound afterwards is only what proves the second part — that no
  // further sweep joined the stuck one.
  await runUntilIdle(controller, 30);
  await waitFor(() => settleCalls > 0, 'the first settle to start');

  // The wait is what the budget bounds. Releasing the claim here would free a device that still has
  // whatever the stuck teardown was holding, which is the failure this whole ordering exists to avoid.
  assert.equal(settleCalls, 1);
  assert.equal(claimFileHeld(deviceClaim), true, 'an unfinished settle must not free the device');
  assert.notEqual(sessionStore.get('default'), undefined);

  // The budget released the sweep's wait AND its execution lock, but not the work. Push the clock
  // past the retry cadence so the next sweep is genuinely due: a second teardown would then stop
  // resources the first one is still holding.
  clock = NOW + 200;
  controller.noteSessionsChanged();
  await runUntilIdle(controller, 60);
  assert.equal(settleCalls, 1, 'one stuck settle must not be joined by a second teardown');

  releaseSettle();
  await waitFor(
    () => !claimFileHeld(deviceClaim) && sessionStore.get('default') === undefined,
    'the settle that was never abandoned to complete the release',
  );
  controller.cancel();
});

test('a daemon beginning to leave does not start settling the next session', async () => {
  const { sessionStore } = makeFixture('agent-device-idle-expiry-closing-');
  sessionStore.set(
    'first',
    makeIosSession('first', {
      createdAt: NOW - WINDOW_MS - 1,
      deviceClaim: { ...CLAIM, deviceKey: 'ios:sim-1' },
    }),
  );
  sessionStore.set(
    'second',
    makeIosSession('second', {
      createdAt: NOW - WINDOW_MS - 1,
      device: { ...IOS_SIMULATOR, id: 'sim-2' },
      deviceClaim: { ...CLAIM, deviceKey: 'ios:sim-2' },
    }),
  );
  const settledNames: string[] = [];
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: WINDOW_MS,
    executionLocks: new Map(),
    settleSession: async ({ address: sessionName }) => {
      settledNames.push(sessionName);
      if (sessionName === 'first') await firstHeld;
    },
    now: () => NOW,
  });
  controller.noteSessionsChanged();
  // Waits for the first settle to be entered, so the assertion below cannot be reading a sweep that
  // simply had not reached the second session yet.
  await waitFor(() => settledNames.length > 0, 'the first session to be settled');
  assert.deepEqual(settledNames, ['first']);

  controller.cancel();
  releaseFirst();
  // `cancel()` stops re-arming, so no second expiry can start; this bound is the only way to express
  // "and it stays that way", and the first settle above proves the loop was live to begin with.
  await runUntilIdle(controller, 30);

  assert.deepEqual(
    settledNames,
    ['first'],
    'shutdown is tearing the session set down; a second expiry would only race it',
  );
  assert.notEqual(sessionStore.get('second'), undefined);
});

test('an over-budget expiry keeps the locks the release itself needs', async () => {
  const fixture = makeFixture('agent-device-idle-expiry-lock-held-past-budget-');
  const { sessionStore } = fixture;
  const { deviceClaim } = await sessionWithLiveClaim(fixture);
  const locks = new Map<string, Promise<unknown>>();
  let releaseSettle!: () => void;
  const settleHeld = new Promise<void>((resolve) => {
    releaseSettle = resolve;
  });

  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: WINDOW_MS,
    executionLocks: locks,
    settleSession: async () => {
      await settleHeld;
    },
    settleBudgetMs: () => 10,
    now: () => NOW,
  });
  await runUntilIdle(controller, 30);

  // The budget released the sweep's WAIT. It must not have released the pair: a `close` or a retried
  // `open` that took these locks now would join a teardown mid-flight, and the release's own final
  // steps — delete this record, write the marker — would then land on whatever that request created.
  let acquiredWhileStuck = false;
  const contender = withKeyedLock(locks, 'session:default', async () => {
    acquiredWhileStuck = true;
  });
  // Bounded by necessity: "did not acquire" is the absence being asserted, and there is no fact to
  // poll for. The wait is not load-bearing on its own — the release below is what proves the pair was
  // genuinely held rather than simply uncontended.
  await runUntilIdle(controller, 20);
  assert.equal(
    acquiredWhileStuck,
    false,
    'a request must not reach a session whose release is still running',
  );
  assert.equal(claimFileHeld(deviceClaim), true);

  releaseSettle();
  await contender;
  await waitFor(
    () => !claimFileHeld(deviceClaim) && sessionStore.get('default') === undefined,
    'the release that kept the locks to finish',
  );
  assert.equal(acquiredWhileStuck, true, 'the pair comes back when the release is over');
  controller.cancel();
});

test('an expiry that lands after its budget still reports the session it released', async () => {
  const fixture = makeFixture('agent-device-idle-expiry-late-notify-');
  const { sessionStore } = fixture;
  await sessionWithLiveClaim(fixture);
  let releaseSettle!: () => void;
  const settleHeld = new Promise<void>((resolve) => {
    releaseSettle = resolve;
  });
  const expired: string[] = [];

  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: WINDOW_MS,
    executionLocks: new Map(),
    settleSession: async () => {
      await settleHeld;
    },
    settleBudgetMs: () => 10,
    onSessionExpired: (outcome) => {
      expired.push(outcome.sessionName);
    },
    now: () => NOW,
  });
  await runUntilIdle(controller, 30);
  // The composition arms the process-level reap from this callback. A release that outran the wait and
  // went unreported would leave a fully idle daemon alive forever.
  assert.deepEqual(expired, []);

  releaseSettle();
  // This controller runs with a settle budget, so the diagnostics scope resolves when the WAIT ends,
  // not when the release does. Poll for the report itself.
  await waitFor(() => expired.length > 0, 'the late release being reported');
  assert.deepEqual(expired, ['default'], 'a completed release is reported whenever it lands');
  controller.cancel();
});

test('a stuck expiry does not leave the timer firing with no delay', async () => {
  const { sessionStore } = makeFixture('agent-device-idle-expiry-stuck-loop-');
  idleClaimedSession(sessionStore);
  let releaseSettle!: () => void;
  const settleHeld = new Promise<void>((resolve) => {
    releaseSettle = resolve;
  });
  let sweeps = 0;
  let settles = 0;
  // A clock that runs: the retry window only becomes reachable if time moves, and the loop this test
  // guards against is a timer that fires the instant it is armed.
  let clock = NOW;

  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: 20,
    executionLocks: new Map(),
    // One call per sweep, which is the quantity at issue: a settle skipped while another is in flight
    // never reaches `settleSession`, so counting settles would rate a re-firing timer as healthy.
    withinDiagnosticsScope: async (run) => {
      sweeps++;
      await run();
    },
    settleSession: async () => {
      settles++;
      await settleHeld;
    },
    settleBudgetMs: () => 5,
    now: () => clock,
  });
  controller.noteSessionsChanged();
  await waitFor(() => settles > 0, 'the first expiry to start');
  assert.equal(settles, 1, 'the first expiry starts once');

  // The budget released the sweep's wait ages ago and the retry window has elapsed too, while the
  // release is still stuck holding the locks. A sweep that skips this address and re-arms at the same
  // elapsed deadline re-enters this code on every turn of the event loop.
  const sweepsBeforeSkipping = sweeps;
  clock = NOW + 10_000;
  for (let round = 0; round < 5; round++) {
    controller.noteSessionsChanged();
    await runUntilIdle(controller, 10);
  }
  assert.equal(settles, 1, 'a stuck release must not be joined by a second teardown');
  // The bound is the point, not the exact count. A skip that leaves this deadline in the past re-arms
  // at zero delay and sweeps again the instant it is armed, so these five nudges would produce dozens
  // of sweeps — one per turn of the event loop — instead of at most one per nudge.
  assert.ok(
    sweeps - sweepsBeforeSkipping <= 5,
    `five nudges must not sweep more than five times, swept ${sweeps - sweepsBeforeSkipping}`,
  );

  releaseSettle();
  await waitFor(() => sessionStore.get('default') === undefined, 'the stuck release to finish');
  controller.cancel();
});

test('a settle that outlives its window is retried a full window after it ends, not after it started', async () => {
  vi.useFakeTimers();
  try {
    const { sessionStore } = makeFixture('agent-device-idle-expiry-long-settle-retry-');
    idleClaimedSession(sessionStore);
    // No settle budget, so the failing settle writes the only deferral this session has: that is the
    // one whose clock is in question. Fake timers because a deferral is a duration, and this measures
    // one that is longer than the settle that owes it.
    const WINDOW = 120;
    let releaseSettle!: () => void;
    const settleHeld = new Promise<void>((resolve) => {
      releaseSettle = resolve;
    });
    let settles = 0;
    let settledAt = 0;

    const controller = createSessionIdleExpiry({
      sessionStore,
      idleExpiryMs: WINDOW,
      executionLocks: new Map(),
      settleSession: async () => {
        settles++;
        await settleHeld;
        settledAt = Date.now();
        // The release itself fails: the session is held back for another attempt.
        throw new Error('the recorder would not stop');
      },
    });
    controller.noteSessionsChanged();
    await vi.advanceTimersByTimeAsync(5);
    assert.equal(settles, 1);

    // The release outlives the window it was started inside. A deferral measured from the START of
    // that settle is already elapsed by the time it is written, so the reaper arms at zero delay and
    // runs a second teardown of a session whose first one only just failed.
    await vi.advanceTimersByTimeAsync(WINDOW * 2);
    releaseSettle();
    await vi.advanceTimersByTimeAsync(5);
    assert.ok(settledAt > 0, 'the settle reached its failure');
    assert.equal(settles, 1, 'a settle that just failed owes a full window, not zero delay');

    await vi.advanceTimersByTimeAsync(WINDOW);
    assert.equal(settles, 2, 'the window it was owed does come due');
    controller.cancel();
  } finally {
    vi.useRealTimers();
  }
});
