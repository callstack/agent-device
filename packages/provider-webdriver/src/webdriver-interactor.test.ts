import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { buildGesturePlan } from '@agent-device/contracts/interaction';
import { AppError } from '@agent-device/kernel/errors';
import { createCloudWebDriverCapabilities } from './capabilities.ts';
import type { WebDriverClient, W3CActionSequence } from './webdriver-client.ts';
import { createWebDriverInteractor } from './webdriver-interactor.ts';

// #1658: `fill` used to send its keys in the request right after the tap. A
// WebView input takes first responder asynchronously, so on a web login form
// the keys landed with nothing focused and `fill` still reported success.
test('fill withholds keys until the tapped field raises the keyboard', async () => {
  const world = createTextEntryWorld();
  // Hidden at the tap, then up two polls later: the transition our tap caused.
  world.keyboardShown = [false, false, false, true];

  const result = await runFill(world);

  assert.equal(result?.textEntryReadiness, 'keyboard-shown');
  assert.deepEqual(world.transcript, [
    'keyboard',
    'tap',
    'keyboard',
    'keyboard',
    'keyboard',
    'keys',
  ]);
});

test('fill settles when the keyboard was already up before the tap', async () => {
  const world = createTextEntryWorld();
  // Back-to-back fills (email then password): a keyboard that never went down
  // cannot witness focus moving to the NEW field, so no poll can prove anything
  // — polling it would only re-observe evidence about the previous field.
  world.keyboardShown = [true];

  const result = await runFill(world);

  assert.equal(result?.textEntryReadiness, 'settled-keyboard-up');
  assert.deepEqual(world.transcript, ['keyboard', 'tap', 'keys']);
});

test('fill settles when the driver implements no keyboard route', async () => {
  const world = createTextEntryWorld();
  world.keyboardRoute = 'unimplemented';

  const result = await runFill(world);

  // A route the driver does not have is not a failure — it just leaves nothing to wait for.
  assert.equal(result?.textEntryReadiness, 'settled-unknown');
  assert.deepEqual(world.transcript, ['keyboard', 'tap', 'keys']);
});

// The #1658 report is "fill answered Filled N chars while the field kept its
// placeholder". Reporting a readiness value nobody renders would preserve that,
// so a tap that raises no keyboard refuses instead — and sends no keys, leaving
// the field untouched rather than half-written.
test('fill refuses without typing when no keyboard ever appears', async () => {
  const world = createTextEntryWorld();
  world.keyboardShown = [false];

  await assert.rejects(runFill(world), (error: AppError) => {
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.match(error.message, /no keyboard appeared, so the text was not sent/);
    assert.equal(error.details?.reason, 'text_entry_focus_not_observed');
    return true;
  });

  assert.equal(world.transcript.includes('keys'), false);
});

// A probe that FAILED is not a driver without the feature. Swallowing a dead
// session or a grid outage as "unsupported" would degrade it into a blind type.
test('fill propagates a failing keyboard probe instead of typing blind', async () => {
  const world = createTextEntryWorld();
  world.keyboardRoute = 'failing';

  await assert.rejects(runFill(world), (error: AppError) => {
    assert.match(error.message, /invalid session id/);
    return true;
  });

  // It threw on the pre-tap probe, so the device was never touched at all.
  assert.deepEqual(world.transcript, ['keyboard']);
});

test('fill bounds each keyboard probe well under its readiness budget', async () => {
  const world = createTextEntryWorld();
  world.keyboardShown = [false, true];

  await runFill(world);

  // Left at the client default, one hung probe could hold a 2s wait for 30s.
  assert.deepEqual(world.probeTimeouts, [1_500, 1_500]);
});

/**
 * Drives `fill` on a fake clock: the readiness wait is real production time on
 * a device and must never be real time here (docs/agents/testing.md). Advancing
 * past the whole readiness budget is safe for every case — once readiness
 * resolves there are no pending timers left to fire.
 */
async function runFill(world: ReturnType<typeof createTextEntryWorld>) {
  vi.useFakeTimers();
  try {
    const interactor = createWebDriverInteractor({
      client: world.client,
      backend: 'xctest',
      capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'ios' }),
    });
    // Settled-shaped from the start: a rejection that lands while the clock is
    // being advanced would otherwise be unhandled until the await below.
    const pending = interactor.fill(12, 24, 'user@example.com').then(
      (value) => ({ rejected: false, value }) as const,
      (error: unknown) => ({ rejected: true, error }) as const,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const settled = await pending;
    if (settled.rejected) throw settled.error;
    return settled.value;
  } finally {
    vi.useRealTimers();
  }
}

/**
 * Records the request order `fill` produces. The ordering IS the fix: a `keys`
 * entry that follows `tap` with no keyboard evidence between them is the bug.
 */
function createTextEntryWorld() {
  const world = {
    transcript: [] as string[],
    probeTimeouts: [] as Array<number | undefined>,
    keyboardShown: [] as boolean[],
    /** How the driver answers the keyboard route: normally, not at all, or with a real failure. */
    keyboardRoute: 'ok' as 'ok' | 'unimplemented' | 'failing',
    client: undefined as unknown as WebDriverClient,
  };
  world.client = {
    performActions: async () => {
      world.transcript.push('tap');
    },
    releaseActions: async () => {},
    sendKeys: async () => {
      world.transcript.push('keys');
    },
    isKeyboardShown: async (timeoutMs?: number) => {
      world.transcript.push('keyboard');
      world.probeTimeouts.push(timeoutMs);
      // The real client classifies the wire error; this stands in for its verdict.
      if (world.keyboardRoute === 'unimplemented') return 'unsupported' as const;
      if (world.keyboardRoute === 'failing') {
        // A dead session: 404, same status as an unimplemented route, which is
        // why the client classifies on the W3C error code instead.
        throw new AppError('COMMAND_FAILED', 'invalid session id', { status: 404 });
      }
      // The last programmed reading is what the keyboard stays at.
      return world.keyboardShown.length > 1
        ? world.keyboardShown.shift()!
        : world.keyboardShown[0]!;
    },
  } as unknown as WebDriverClient;
  return world;
}

test('endpoint plans become one timed W3C pointer move', async () => {
  const performed: W3CActionSequence[][] = [];
  let released = false;
  const client = {
    performActions: async (actions: W3CActionSequence[]) => {
      performed.push(actions);
    },
    releaseActions: async () => {
      released = true;
    },
  } as unknown as WebDriverClient;
  const interactor = createWebDriverInteractor({
    client,
    backend: 'android',
    capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'android' }),
  });
  const plan = buildGesturePlan(
    {
      intent: 'pan',
      origin: { x: 100, y: 200 },
      delta: { x: 100, y: 200 },
      durationMs: 500,
    },
    { x: 0, y: 0, width: 400, height: 800 },
  );

  assert.ok(interactor.performGesture);
  assert.deepEqual(await interactor.performGesture(plan), { backend: 'webdriver-w3c-actions' });
  assert.equal(released, true);
  assert.deepEqual(performed, [
    [
      {
        type: 'pointer',
        id: 'gesture-pointer-0',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: 100, y: 200 },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration: 500, x: 200, y: 400 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ],
  ]);
});
