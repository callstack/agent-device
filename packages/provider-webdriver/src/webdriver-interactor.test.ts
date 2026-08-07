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

test('fill settles when the driver cannot report keyboard state', async () => {
  const world = createTextEntryWorld();
  world.keyboardSupported = false;

  const result = await runFill(world);

  // Evidence, never a precondition: an unanswerable keyboard must not fail the fill.
  assert.equal(result?.textEntryReadiness, 'settled-unknown');
  assert.deepEqual(world.transcript, ['keyboard', 'tap', 'keys']);
});

test('fill still types when no keyboard ever appears, and says so', async () => {
  const world = createTextEntryWorld();
  world.keyboardShown = [false];

  const result = await runFill(world);

  assert.equal(result?.textEntryReadiness, 'not-observed');
  assert.equal(world.transcript.at(-1), 'keys');
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
    const pending = interactor.fill(12, 24, 'user@example.com');
    await vi.advanceTimersByTimeAsync(5_000);
    return await pending;
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
    keyboardShown: [] as boolean[],
    keyboardSupported: true,
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
    isKeyboardShown: async () => {
      world.transcript.push('keyboard');
      if (!world.keyboardSupported) {
        throw new AppError('COMMAND_FAILED', 'Unknown command: is_keyboard_shown');
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
