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
test('fill withholds keys until the tapped point holds text-entry focus', async () => {
  const world = createTextEntryWorld();
  // Nothing focused at first, then the tapped field takes it two polls later.
  world.activeRects = ['none', 'none', CONTAINS_TAP];

  const result = await runFill(world);

  assert.equal(result?.textEntryReadiness, 'focused-element');
  assert.deepEqual(world.transcript, [
    'keyboard',
    'active',
    'tap',
    'active',
    'active',
    'active',
    'keys',
  ]);
});

// The case keyboard visibility can never decide: a second fill into a form
// whose keyboard is already up. The keyboard says "a field is focused" both
// before and after, so only the focused element's own geometry can tell whether
// OUR tap moved focus.
test('fill accepts a keyboard-up second field once focus lands on the tapped point', async () => {
  const world = createTextEntryWorld();
  world.keyboardShown = [true];
  world.focusedBeforeTap = PREVIOUS_FIELD;
  world.activeRects = [CONTAINS_TAP];

  const result = await runFill(world);

  assert.equal(result?.textEntryReadiness, 'focused-element');
  assert.deepEqual(world.transcript, ['keyboard', 'active', 'tap', 'active', 'keys']);
});

// P1, the two-field misdelivery: email filled, keyboard stays up, the password
// tap misses. Focus never leaves the email field, so a global `/keys` would
// append the password to the EMAIL field while reporting success.
test('fill refuses when a keyboard-up tap misses and focus stays on the previous field', async () => {
  const world = createTextEntryWorld();
  world.keyboardShown = [true];
  world.focusedBeforeTap = PREVIOUS_FIELD;
  world.activeRects = [PREVIOUS_FIELD];

  await assert.rejects(runFill(world), (error: AppError) => {
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.match(error.message, /nothing there took text-entry focus/);
    assert.equal(error.details?.reason, 'text_entry_focus_not_observed');
    return true;
  });

  // The decisive assertion: no keys reached the field the previous fill focused.
  assert.equal(world.transcript.includes('keys'), false);
});

// Found on a live AWS Device Farm iPhone 16: tapping Safari's collapsed address
// bar expands it into a taller field whose rect no longer covers the tapped
// point. A containment-only rule refused a fill that plainly worked, so a tap
// that MOVES focus counts even when the focused element has since been re-laid
// out.
test('fill accepts focus that moved to an element re-laid out away from the tap', async () => {
  const world = createTextEntryWorld();
  world.activeRects = ['none', MOVED_AFTER_FOCUS];

  const result = await runFill(world);

  assert.equal(result?.textEntryReadiness, 'focused-element');
});

// The other half of the rule: re-filling the field that is ALREADY focused
// moves nothing, so only containment can tell it from a tap that missed.
test('fill accepts a re-fill of the already-focused field it tapped', async () => {
  const world = createTextEntryWorld();
  world.focusedBeforeTap = CONTAINS_TAP;
  world.activeRects = [CONTAINS_TAP];

  const result = await runFill(world);

  assert.equal(result?.textEntryReadiness, 'focused-element');
});

test('fill falls back to the keyboard transition when there is no active-element route', async () => {
  const world = createTextEntryWorld();
  world.activeRoute = 'unimplemented';
  world.keyboardShown = [false, false, true];

  const result = await runFill(world);

  assert.equal(result?.textEntryReadiness, 'keyboard-shown');
  assert.deepEqual(world.transcript, [
    'keyboard',
    'active',
    'tap',
    'active',
    'keyboard',
    'keyboard',
    'keys',
  ]);
});

// Without an active-element route, a keyboard that was ALREADY up witnesses
// nothing about the new field — the exact silent misdelivery P1 names.
test('fill refuses a keyboard-up tap when the driver cannot report the focused field', async () => {
  const world = createTextEntryWorld();
  world.activeRoute = 'unimplemented';
  world.keyboardShown = [true];

  await assert.rejects(runFill(world), (error: AppError) => {
    assert.match(error.message, /cannot report which field holds focus/);
    assert.equal(error.details?.reason, 'text_entry_focus_not_observed');
    return true;
  });

  assert.equal(world.transcript.includes('keys'), false);
});

// The last path that typed without evidence. It reported ordinary success, and
// nothing renders `textEntryReadiness`, so it read to a caller exactly like a
// fill that worked — the #1658 false success this change exists to remove.
test('fill refuses when the driver implements neither focus route', async () => {
  const world = createTextEntryWorld();
  world.activeRoute = 'unimplemented';
  world.keyboardRoute = 'unimplemented';

  await assert.rejects(runFill(world), (error: AppError) => {
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.match(error.message, /reports neither the focused element nor keyboard state/);
    // A capability gap, not a missed tap: the caller's next move differs.
    assert.equal(error.details?.reason, 'text_entry_focus_unobservable');
    assert.match(String(error.details?.hint), /press <target> followed by type <text>/);
    return true;
  });

  assert.equal(world.transcript.includes('keys'), false);
});

// The #1658 report is "fill answered Filled N chars while the field kept its
// placeholder". Reporting a readiness value nobody renders would preserve that,
// so a tap that focuses nothing refuses instead — and sends no keys, leaving
// the field untouched rather than half-written.
test('fill refuses without typing when nothing ever takes focus', async () => {
  const world = createTextEntryWorld();
  world.activeRects = ['none'];

  await assert.rejects(runFill(world), (error: AppError) => {
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.match(error.message, /nothing there took text-entry focus/);
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

  // It threw on a pre-tap probe, so the device was never touched at all.
  assert.equal(world.transcript.includes('tap'), false);
});

// Post-tap the device HAS been touched, so one transient grid error must not
// fail a fill the next poll would have satisfied.
test('fill tolerates a transient probe failure and still witnesses focus', async () => {
  const world = createTextEntryWorld();
  world.activeFailuresAfterTap = 2;
  world.activeRects = [CONTAINS_TAP];

  const result = await runFill(world);

  assert.equal(result?.textEntryReadiness, 'focused-element');
});

// ...but a budget that expires without a single answered probe is a broken
// session, and must surface as itself rather than as "the tap missed".
test('fill rethrows the probe failure when no probe ever answers', async () => {
  const world = createTextEntryWorld();
  world.activeRoute = 'failing';

  await assert.rejects(runFill(world), (error: AppError) => {
    assert.match(error.message, /active element exploded/);
    return true;
  });

  assert.equal(world.transcript.includes('keys'), false);
});

// P2: a probe handed the full fixed timeout near the deadline would finish well
// after the budget it was meant to respect, so each one is capped by what is
// actually left.
test('fill caps each probe timeout by the readiness budget remaining', async () => {
  const world = createTextEntryWorld();
  world.activeRects = ['none'];

  await assert.rejects(runFill(world), () => true);

  const timeouts = world.probeTimeouts.filter((t): t is number => t !== undefined);
  assert.equal(
    timeouts.every((t) => t <= 1_500),
    true,
  );
  // The budget is 2s and probes start at t=0, so once under 1.5s remain the cap
  // is the remainder, and the final probe gets exactly one poll interval.
  assert.equal(timeouts.at(-1), 100);
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
type FocusedElement = {
  id: string;
  rect: { x: number; y: number; width: number; height: number };
};

/** `fill` is driven at (12, 24) throughout, so these read as hit and miss. */
const CONTAINS_TAP = { id: 'tapped', rect: { x: 0, y: 0, width: 100, height: 100 } } as const;
const PREVIOUS_FIELD = {
  id: 'previous',
  rect: { x: 200, y: 200, width: 100, height: 100 },
} as const;
/** Focused by our tap, but re-laid out by focusing so it no longer covers the tap point. */
const MOVED_AFTER_FOCUS = {
  id: 'expanded',
  rect: { x: 200, y: 600, width: 180, height: 40 },
} as const;

function createTextEntryWorld() {
  const world = {
    transcript: [] as string[],
    probeTimeouts: [] as Array<number | undefined>,
    keyboardShown: [true] as boolean[],
    /** How the driver answers each route: normally, not at all, or with a real failure. */
    keyboardRoute: 'ok' as 'ok' | 'unimplemented' | 'failing',
    activeRoute: 'ok' as 'ok' | 'unimplemented' | 'failing',
    /** Successive answers from the active-element route; the last one repeats. */
    activeRects: ['none'] as Array<'none' | FocusedElement>,
    /** What held focus when the fill began — a previous fill's field, or nothing. */
    focusedBeforeTap: 'none' as 'none' | FocusedElement,
    /** Transient post-tap failures to emit before the route starts answering. */
    activeFailuresAfterTap: 0,
    tapped: false,
    client: undefined as unknown as WebDriverClient,
  };
  world.client = {
    performActions: async () => {
      world.transcript.push('tap');
      world.tapped = true;
    },
    releaseActions: async () => {},
    sendKeys: async () => {
      world.transcript.push('keys');
    },
    activeElement: async (timeoutMs?: number) => {
      world.transcript.push('active');
      world.probeTimeouts.push(timeoutMs);
      if (world.activeRoute === 'unimplemented') return 'unsupported' as const;
      if (world.activeRoute === 'failing') {
        throw new AppError('COMMAND_FAILED', 'active element exploded', { status: 500 });
      }
      // Before the tap the form is in whatever state the previous fill left it.
      if (!world.tapped) {
        return world.focusedBeforeTap === 'none'
          ? ('none' as const)
          : { id: world.focusedBeforeTap.id, rect: world.focusedBeforeTap.rect };
      }
      if (world.activeFailuresAfterTap > 0) {
        world.activeFailuresAfterTap -= 1;
        throw new AppError('COMMAND_FAILED', 'transient grid blip', { status: 502 });
      }
      const next =
        world.activeRects.length > 1 ? world.activeRects.shift()! : world.activeRects[0]!;
      return next === 'none' ? ('none' as const) : { id: next.id, rect: next.rect };
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
