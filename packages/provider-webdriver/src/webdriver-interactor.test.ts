import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { createSnapshotVisibility } from '@agent-device/contracts/snapshot';
import { resolveKeyboardTapOcclusion } from '@agent-device/contracts/tap-keyboard-occlusion';
import { buildGesturePlan } from '@agent-device/contracts/gesture-plan';
import { AppError } from '@agent-device/kernel/errors';
import { createCloudWebDriverCapabilities } from './capabilities.ts';
import type { WebDriverClient, W3CActionSequence } from './webdriver-client.ts';
import { createWebDriverInteractor } from './webdriver-interactor.ts';
import { isWebDriverRequestTimeout } from './webdriver-transport.ts';

// #1658: `fill` used to send its keys in the request right after the tap. A
// WebView input takes first responder asynchronously, so on a web login form
// the keys landed with nothing focused and `fill` still reported success.
test('fill withholds keys until the tapped point holds text-entry focus', async () => {
  const world = createTextEntryWorld();
  // Nothing focused at first, then the tapped field takes it two polls later.
  world.activeRects = ['none', 'none', CONTAINS_TAP];

  const result = await runFill(world);
  assert.equal(result?.textEntryReadiness, 'focused-element');
  assert.deepEqual(vi.mocked(world.client.clearElement).mock.calls, [['tapped']]);
  assert.deepEqual(vi.mocked(world.client.sendElementKeys).mock.calls, [
    ['tapped', 'user@example.com'],
  ]);
  assert.deepEqual(world.transcript, [
    'active',
    'tap',
    'active',
    'active',
    'active',
    'clear',
    'keys',
  ]);
});

// The case keyboard visibility can never decide: a second fill into a form
// whose keyboard is already up. The keyboard says "a field is focused" both
// before and after, so only the focused element's own geometry can tell whether
// OUR tap moved focus.
test('fill accepts a second field once focus lands on the tapped point', async () => {
  const world = createTextEntryWorld();
  world.focusedBeforeTap = PREVIOUS_FIELD;
  world.activeRects = [CONTAINS_TAP];

  const result = await runFill(world);

  assert.equal(result?.textEntryReadiness, 'focused-element');
  assert.deepEqual(world.transcript, ['active', 'tap', 'active', 'clear', 'keys']);
});

// P1, the two-field misdelivery: email filled, keyboard stays up, the password
// tap misses. Focus never leaves the email field, so a global `/keys` would
// append the password to the EMAIL field while reporting success.
test('fill refuses when a tap misses and focus stays on the previous field', async () => {
  const world = createTextEntryWorld();
  world.focusedBeforeTap = PREVIOUS_FIELD;
  world.activeRects = [PREVIOUS_FIELD];

  await assert.rejects(runFill(world), (error: AppError) => {
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.match(error.message, /nothing there took text-entry focus/);
    assert.equal(error.details?.reason, 'text_entry_focus_not_observed');
    return true;
  });

  assert.ok(!world.transcript.some((step) => step === 'clear' || step === 'keys'));
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

for (const keyboardRoute of ['ok', 'unimplemented', 'failing'] as const) {
  test(`fill refuses before tapping when focused-element lookup is unsupported (${keyboardRoute} keyboard)`, async () => {
    const world = createTextEntryWorld();
    world.activeRoute = 'unimplemented';
    world.keyboardRoute = keyboardRoute;

    await assert.rejects(runFill(world), (error: AppError) => {
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.equal(error.details?.reason, 'text_entry_clear_target_unavailable');
      return true;
    });

    assert.deepEqual(world.transcript, ['active']);
    assert.deepEqual(world.probeTimeouts, [1_500]);
  });
}

test('fill refuses when focused-element lookup becomes unsupported after the tap', async () => {
  const world = createTextEntryWorld();
  world.activeRoute = 'unimplemented';
  world.client.activeElementReference = async () => {
    world.transcript.push('active');
    return { id: 'previous' };
  };

  await assert.rejects(runFill(world), (error: AppError) => {
    assert.equal(error.code, 'UNSUPPORTED_OPERATION');
    assert.equal(error.details?.reason, 'text_entry_clear_target_unavailable');
    return true;
  });

  assert.deepEqual(world.transcript, ['active', 'tap', 'active']);
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

  assert.ok(!world.transcript.some((step) => step === 'clear' || step === 'keys'));
});

// A probe that FAILED is not a driver without the feature. Swallowing a dead
// session or a grid outage as "unsupported" would degrade it into a blind type.
test('fill propagates a failing pre-tap focus probe instead of typing blind', async () => {
  const world = createTextEntryWorld();
  world.activeRoute = 'failing';

  await assert.rejects(runFill(world), (error: AppError) => {
    assert.match(error.message, /active element exploded/);
    return true;
  });

  // It threw on a pre-tap probe, so the device was never touched at all.
  assert.deepEqual(world.transcript, ['active']);
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
test('fill rethrows the probe failure when no post-tap probe ever answers', async () => {
  const world = createTextEntryWorld();
  world.activeFailuresAfterTap = Number.POSITIVE_INFINITY;

  await assert.rejects(runFill(world), (error: AppError) => {
    assert.match(error.message, /transient grid blip/);
    return true;
  });

  assert.ok(!world.transcript.some((step) => step === 'clear' || step === 'keys'));
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
  assert.ok(!world.transcript.some((step) => step === 'clear' || step === 'keys'));
});

/**
 * Drives `fill` on a fake clock: the readiness wait is real production time on
 * a device and must never be real time here (docs/agents/testing.md). Advancing
 * past the whole readiness budget is safe for every case — once readiness
 * resolves there are no pending timers left to fire.
 */
test('fill clears an empty replacement without sending keys', async () => {
  const world = createTextEntryWorld();
  world.activeRects = [CONTAINS_TAP];
  const interactor = createWebDriverInteractor({
    client: world.client,
    backend: 'xctest',
    capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'ios' }),
  });

  await interactor.fill(12, 24, '');
  assert.deepEqual(world.transcript, ['active', 'tap', 'active', 'clear']);
});

test('iOS WebDriver interactor routes snapshots through the acquisition adapter', async () => {
  const source = vi.fn(
    async () =>
      '<AppiumAUT><XCUIElementTypeApplication x="0" y="0" width="390" height="844" /></AppiumAUT>',
  );
  const interactor = createWebDriverInteractor({
    client: { source } as unknown as WebDriverClient,
    backend: 'xctest',
    capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'ios' }),
    targetId: 'ios-1',
  });

  const result = await interactor.snapshot({ raw: true, depth: 1 });

  if (!('stage' in result)) throw new Error('iOS snapshot must carry acquired facts');
  assert.equal(result.stage, 'acquired');
  assert.equal(result.acquisition.producer, 'appium-source');
  assert.equal(source.mock.calls.length, 1);
  assert.equal(result.acquisition.nodes[0]?.type, 'XCUIElementTypeApplication');
});

test('Android WebDriver interactor returns source facts with system-bar membership', async () => {
  const source = vi.fn(
    async () =>
      '<hierarchy rotation="0"><android.widget.FrameLayout index="0" class="android.widget.FrameLayout" package="com.android.systemui" resource-id="com.android.systemui:id/status_bar" bounds="[0,0][100,40]"><android.widget.Button index="0" class="android.widget.Button" package="com.android.systemui" bounds="[0,0][100,40]" displayed="true" enabled="true" /></android.widget.FrameLayout></hierarchy>',
  );
  const interactor = createWebDriverInteractor({
    client: { source } as unknown as WebDriverClient,
    backend: 'android',
    capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'android' }),
  });

  const result = await interactor.snapshot();

  if ('stage' in result) throw new Error('Android snapshot must be presented by the interactor');
  assert.equal(result.backend, 'android');
  assert.equal(result.nodes?.[0]?.type, 'hierarchy');
  assert.equal(result.nodes?.[1]?.type, 'android.widget.FrameLayout');
  assert.equal(result.nodes?.[2]?.type, 'android.widget.Button');
  assert.equal(result.nodes?.[2]?.hittable, true);
  for (const node of result.nodes!.slice(1)) {
    assert.equal(node.bundleId, 'com.android.systemui');
    assert.equal(node.systemBar, 'status');
  }
  assert.equal(source.mock.calls.length, 1);
});

// #2509: the interactor took a request-bound signal and named it away. A capture
// that ran past its budget could therefore never be cancelled: the client gave up
// while the provider kept walking the tree, and being per-session-serial it made
// every later command queue behind an orphan nobody was waiting for.
test('Android snapshot binds the provider source read to its request signal', async () => {
  const controller = new AbortController();
  const forwarded: Array<{ signal?: AbortSignal } | undefined> = [];
  const interactor = createWebDriverInteractor({
    client: {
      source: async (overrides?: { signal?: AbortSignal }) => {
        forwarded.push(overrides);
        return ANDROID_ONBOARDING_SOURCE;
      },
    } as unknown as WebDriverClient,
    backend: 'android',
    capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'android' }),
  });

  await interactor.snapshot({ signal: controller.signal });

  assert.deepEqual(forwarded, [{ signal: controller.signal }]);
});

// The iOS acquisition adapter reads the same route, so it needs the same binding.
test('iOS snapshot binds the provider source read to its request signal', async () => {
  const controller = new AbortController();
  const forwarded: Array<{ signal?: AbortSignal } | undefined> = [];
  const interactor = createWebDriverInteractor({
    client: {
      source: async (overrides?: { signal?: AbortSignal }) => {
        forwarded.push(overrides);
        return '<AppiumAUT><XCUIElementTypeApplication x="0" y="0" width="390" height="844" /></AppiumAUT>';
      },
    } as unknown as WebDriverClient,
    backend: 'xctest',
    capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'ios' }),
    targetId: 'ios-1',
  });

  await interactor.snapshot({ signal: controller.signal });

  assert.deepEqual(forwarded, [{ signal: controller.signal }]);
});

// #2509 asked for an error that names the problem: a screen that never goes idle
// (looping video, live marquee) keeps the provider's tree walk from settling, and
// on rented hardware every second of it is billed. The reason code stays the
// transport's; what the capture adds is what it means.
test('a source capture that runs out of budget keeps the timeout reason and names the cause', async () => {
  const interactor = createWebDriverInteractor({
    client: { source: async () => throwWebDriverSourceTimeout() } as unknown as WebDriverClient,
    backend: 'android',
    capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'android' }),
  });

  await assert.rejects(interactor.snapshot(), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.reason, 'webdriver_request_timeout');
    assert.equal(isWebDriverRequestTimeout(error), true);
    assert.match(String(error.details?.hint), /never goes idle/);
    // Reviewing #2509 found the advice that failed there was a longer `--timeout`,
    // which cannot reach this read. The hint says so and offers what does work.
    assert.match(String(error.details?.hint), /does not grow with --timeout/);
    assert.match(String(error.details?.hint), /screenshot/);
    return true;
  });
});

function throwWebDriverSourceTimeout(): never {
  throw new AppError('COMMAND_FAILED', 'WebDriver GET /source timed out after 30000ms.', {
    reason: 'webdriver_request_timeout',
    method: 'GET',
    path: '/source',
    timeoutMs: 30_000,
  });
}

const ANDROID_ONBOARDING_SOURCE =
  '<hierarchy rotation="0"><android.widget.Button content-desc="Continue" bounds="[0,0][100,40]" displayed="true" enabled="true" /></hierarchy>';

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
 * Records the request order `fill` produces. Clearing or typing before the
 * tapped field holds confirmed focus is the bug.
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
    clearElement: vi.fn(async () => {
      world.transcript.push('clear');
    }),
    sendElementKeys: vi.fn(async () => {
      world.transcript.push('keys');
    }),
    activeElementReference: (timeoutMs?: number) =>
      world.client
        .activeElement(timeoutMs)
        .then((ref) => (typeof ref === 'string' ? ref : { id: ref.id })),
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
      return true;
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

/** A client that records the keyboard routes the interactor drives, answering the probe from `shown`. */
function createKeyboardWorld(shown: Array<boolean | 'unsupported' | 'failing'>) {
  const transcript: string[] = [];
  const upAtStart = shown[0] !== false;
  const client = {
    executeScript: async (script: string, args: unknown[]) => {
      transcript.push(`${script} ${JSON.stringify(args)}`);
    },
    sendKeys: async (text: string) => {
      transcript.push(`keys ${JSON.stringify(text)}`);
    },
    hideKeyboard: async () => {
      transcript.push('hide');
      // The driver refuses the route when no soft keyboard shows.
      if (!upAtStart) {
        throw new AppError('COMMAND_FAILED', 'Soft keyboard not present', { status: 500 });
      }
    },
    isKeyboardShown: async () => {
      transcript.push('probe');
      const next = shown.length > 1 ? shown.shift()! : shown[0]!;
      if (next === 'failing') {
        throw new AppError('COMMAND_FAILED', 'is_keyboard_shown timed out', { status: 504 });
      }
      return next;
    },
  } as unknown as WebDriverClient;
  return { transcript, client };
}

function keyboardInteractor(
  world: ReturnType<typeof createKeyboardWorld>,
  platform: 'android' | 'ios',
) {
  return createWebDriverInteractor({
    client: world.client,
    backend: platform === 'android' ? 'android' : 'xctest',
    capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform }),
  });
}

// Found on an AWS Device Farm Pixel 8: `press('Enter')` after a fill failed with "keyboard
// enter is not supported on this device" because the runtime declared no keyboard leg at all.
test('keyboard enter presses the Enter keycode through the driver on Android', async () => {
  const world = createKeyboardWorld([true]);

  const result = await keyboardInteractor(world, 'android').keyboardEnter!();

  assert.deepEqual(result, { kind: 'android-acknowledged' });
  assert.deepEqual(world.transcript, ['mobile: pressKey [{"keycode":66}]']);
});

test('keyboard enter types a newline on iOS and echoes the keyboard visibility around it', async () => {
  const world = createKeyboardWorld([true, false]);

  const result = await keyboardInteractor(world, 'ios').keyboardEnter!();

  assert.deepEqual(result, { kind: 'visibility-echo', wasVisible: true, visible: false });
  assert.deepEqual(world.transcript, ['probe', String.raw`keys "\n"`, 'probe']);
});

test('keyboard enter on iOS reports no visibility when the driver has no keyboard probe', async () => {
  const world = createKeyboardWorld(['unsupported']);

  const result = await keyboardInteractor(world, 'ios').keyboardEnter!();

  assert.deepEqual(result, { kind: 'visibility-echo' });
});

test('keyboard dismiss hides the keyboard and reports the IME probe on Android', async () => {
  const world = createKeyboardWorld([true, false]);

  const result = await keyboardInteractor(world, 'android').keyboardDismiss!();

  assert.deepEqual(result, {
    kind: 'ime-probe',
    wasVisible: true,
    visible: false,
    dismissed: true,
  });
  assert.deepEqual(world.transcript, ['probe', 'hide', 'probe']);
});

test('keyboard dismiss names the Appium route as the mechanism on iOS', async () => {
  const world = createKeyboardWorld([true, true]);

  const result = await keyboardInteractor(world, 'ios').keyboardDismiss!();

  assert.deepEqual(result, {
    kind: 'mechanism',
    mechanism: 'appium-hide-keyboard',
    wasVisible: true,
    visible: true,
    dismissed: false,
  });
});

test('keyboard status reads the Appium probe, and refuses a driver without one', async () => {
  const shown = createKeyboardWorld([false]);
  assert.deepEqual(await keyboardInteractor(shown, 'android').keyboardStatus!(), {
    kind: 'ime-probe',
    visible: false,
  });

  const probeless = createKeyboardWorld(['unsupported']);
  await assert.rejects(
    keyboardInteractor(probeless, 'android').keyboardStatus!(),
    (error: AppError) => {
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.equal(error.details?.operation, 'keyboard');
      return true;
    },
  );
});

test('a provider that declares no keyboard capability refuses every keyboard action before the driver', async () => {
  const world = createKeyboardWorld([true]);
  const interactor = createWebDriverInteractor({
    client: world.client,
    backend: 'android',
    capabilities: createCloudWebDriverCapabilities({
      provider: 'test',
      platform: 'android',
      overrides: { keyboard: 'unsupported' },
    }),
  });

  for (const action of [
    () => interactor.keyboardEnter!(),
    () => interactor.keyboardDismiss!(),
    () => interactor.keyboardStatus!(),
  ]) {
    await assert.rejects(action(), (error: AppError) => {
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.equal(error.details?.operation, 'keyboard');
      return true;
    });
  }
  assert.deepEqual(world.transcript, []);
});

// Appium refuses hide-keyboard when nothing is up; native dismiss answers "already hidden" with
// success, so a script's idempotent dismiss must not break on a cloud device. The fake driver
// throws on that call, so this test fails if the call is made.
test('keyboard dismiss leaves a keyboard that is already down alone', async () => {
  const world = createKeyboardWorld([false]);

  const result = await keyboardInteractor(world, 'android').keyboardDismiss!();

  assert.deepEqual(result, {
    kind: 'ime-probe',
    wasVisible: false,
    visible: false,
    dismissed: false,
  });
  assert.deepEqual(world.transcript, ['probe']);
});

// The probe after a landed mutation is an echo: a gateway that times it out must not make the
// caller retry a key press that already happened.
test('a failing echo probe after enter or dismiss leaves the visibility unknown instead of failing', async () => {
  const entered = createKeyboardWorld([true, 'failing']);
  assert.deepEqual(await keyboardInteractor(entered, 'ios').keyboardEnter!(), {
    kind: 'visibility-echo',
    wasVisible: true,
  });
  assert.deepEqual(entered.transcript, ['probe', String.raw`keys "\n"`, 'probe']);

  const dismissed = createKeyboardWorld([true, 'failing']);
  assert.deepEqual(await keyboardInteractor(dismissed, 'android').keyboardDismiss!(), {
    kind: 'ime-probe',
    wasVisible: true,
  });
  assert.deepEqual(dismissed.transcript, ['probe', 'hide', 'probe']);
});

for (const [name, source] of [
  ['empty tree', '<hierarchy />'],
  [
    'sparse tree',
    '<hierarchy><android.widget.Button text="OK" bounds="[20,50][80,90]" /></hierarchy>',
  ],
  [
    'content beyond display',
    '<hierarchy><android.widget.ScrollView bounds="[0,0][1000,9000]" /></hierarchy>',
  ],
] as const) {
  test(`Android snapshot measures its viewport independently of ${name}`, async () => {
    const transcript: string[] = [];
    const windowRect = vi.fn(async () => {
      transcript.push('rect');
      return { x: 0, y: 0, width: 1080, height: 2400 };
    });
    const interactor = createWebDriverInteractor({
      client: {
        source: async () => {
          transcript.push('source');
          return source;
        },
        windowRect,
      } as unknown as WebDriverClient,
      backend: 'android',
      capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'android' }),
    });
    const result = await interactor.snapshot();
    if ('stage' in result) throw new Error('expected Android snapshot');
    assert.deepEqual(result.viewport, { width: 1080, height: 2400 });
    assert.deepEqual(transcript, ['rect', 'source', 'rect']);
    assert.deepEqual(windowRect.mock.calls, [
      [{ timeoutMs: 500, retryAttempts: 0 }],
      [{ timeoutMs: 500, retryAttempts: 0 }],
    ]);
  });
}

test('Android viewport follows fresh display measurements through rotation and keyboard resizing', async () => {
  const rects = [
    { x: 0, y: 0, width: 1080, height: 2400 },
    { x: 0, y: 0, width: 2400, height: 1080 },
    { x: 0, y: 0, width: 2400, height: 1080 },
  ].flatMap((rect) => [rect, rect]);
  const sources = [
    '<hierarchy><android.widget.FrameLayout bounds="[0,100][1080,2300]" /></hierarchy>',
    '<hierarchy><android.widget.FrameLayout bounds="[0,100][2400,1000]" /></hierarchy>',
    '<hierarchy><android.widget.FrameLayout bounds="[0,100][2400,600]" /></hierarchy>',
  ];
  const windowRect = vi.fn(async () => rects.shift()!);
  const interactor = createWebDriverInteractor({
    client: { source: async () => sources.shift()!, windowRect } as unknown as WebDriverClient,
    backend: 'android',
    capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'android' }),
  });
  const results = [
    await interactor.snapshot(),
    await interactor.snapshot(),
    await interactor.snapshot(),
  ];
  assert.deepEqual(
    results.map((result) => ('stage' in result ? undefined : result.viewport)),
    [
      { width: 1080, height: 2400 },
      { width: 2400, height: 1080 },
      { width: 2400, height: 1080 },
    ],
  );
  assert.equal(windowRect.mock.calls.length, 6);
});

for (const rect of [
  { x: 0, y: 0, width: 0, height: 2400 },
  { x: 0, y: 0, width: 1080, height: -1 },
  { x: 0, y: 0, width: Number.NaN, height: 2400 },
  { x: 0, y: 0, width: Infinity, height: 2400 },
]) {
  test(`Android snapshot omits invalid measured viewport ${JSON.stringify(rect)}`, async () => {
    const interactor = createWebDriverInteractor({
      client: {
        source: async () => '<android.widget.Button text="OK" bounds="[0,0][100,40]" />',
        windowRect: async () => rect,
      } as unknown as WebDriverClient,
      backend: 'android',
      capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'android' }),
    });
    const result = await interactor.snapshot();
    if ('stage' in result) throw new Error('expected Android snapshot');
    assert.equal(result.viewport, undefined);
    assert.equal(result.nodes?.[0]?.label, 'OK');
  });
}

test('Android optional viewport probe forwards its request signal and preserves source on failure', async () => {
  const controller = new AbortController();
  const windowRect = vi.fn(async () => {
    throw new AppError('COMMAND_FAILED', 'probe timed out', {
      reason: 'webdriver_request_timeout',
    });
  });
  const interactor = createWebDriverInteractor({
    client: {
      source: async () => '<android.widget.Button text="OK" />',
      windowRect,
    } as unknown as WebDriverClient,
    backend: 'android',
    capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'android' }),
  });
  const result = await interactor.snapshot({ signal: controller.signal });
  if ('stage' in result) throw new Error('expected Android snapshot');
  assert.equal(result.viewport, undefined);
  assert.equal(result.nodes?.[0]?.label, 'OK');
  assert.deepEqual(windowRect.mock.calls, [
    [{ timeoutMs: 500, retryAttempts: 0, signal: controller.signal }],
  ]);
});

for (const phase of ['before', 'after'] as const) {
  test(`Android snapshot rejects cancellation during the ${phase}-source viewport probe`, async () => {
    const controller = new AbortController();
    const cancelled = new Error('request cancelled');
    let calls = 0;
    const source = vi.fn(async () => '<android.widget.Button text="OK" />');
    const interactor = createWebDriverInteractor({
      client: {
        source,
        windowRect: async () => {
          calls += 1;
          if (phase === 'before' || calls === 2) {
            controller.abort(cancelled);
            throw cancelled;
          }
          return { x: 0, y: 0, width: 1080, height: 2400 };
        },
      } as unknown as WebDriverClient,
      backend: 'android',
      capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'android' }),
    });
    await assert.rejects(
      interactor.snapshot({ signal: controller.signal }),
      (error) => error === cancelled,
    );
    assert.equal(source.mock.calls.length, phase === 'before' ? 0 : 1);
  });
}

for (const after of [
  { x: 0, y: 0, width: 1081, height: 2400 },
  { x: 0, y: 0, width: 1080, height: 2401 },
  { x: 0, y: 0, width: 2400, height: 1080 },
]) {
  test(`Android snapshot omits viewport when display changes during source capture to ${after.width}x${after.height}`, async () => {
    const rects = [{ x: 0, y: 0, width: 1080, height: 2400 }, after];
    const interactor = createWebDriverInteractor({
      client: {
        source: async () => '<android.widget.Button text="OK" />',
        windowRect: async () => rects.shift()!,
      } as unknown as WebDriverClient,
      backend: 'android',
      capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'android' }),
    });
    const result = await interactor.snapshot();
    if ('stage' in result) throw new Error('expected Android snapshot');
    assert.equal(result.viewport, undefined);
    assert.equal(result.nodes?.[0]?.label, 'OK');
  });
}

for (const failure of ['invalid', 'unavailable'] as const) {
  test(`Android snapshot keeps source when its after-source viewport is ${failure}`, async () => {
    let calls = 0;
    const interactor = createWebDriverInteractor({
      client: {
        source: async () => '<android.widget.Button text="OK" />',
        windowRect: async () => {
          calls += 1;
          if (calls === 1) return { x: 0, y: 0, width: 1080, height: 2400 };
          if (failure === 'unavailable') throw new AppError('COMMAND_FAILED', 'probe failed');
          return { x: 0, y: 0, width: 0, height: 2400 };
        },
      } as unknown as WebDriverClient,
      backend: 'android',
      capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'android' }),
    });
    const result = await interactor.snapshot();
    if ('stage' in result) throw new Error('expected Android snapshot');
    assert.equal(result.viewport, undefined);
    assert.equal(result.nodes?.[0]?.label, 'OK');
    assert.equal(calls, 2);
  });
}

test('snapshot carries a bounded visibility probe on both Appium platforms', async () => {
  for (const backend of ['android', 'xctest'] as const) {
    for (const visible of [true, false, 'unsupported', 'failed'] as const) {
      const controller = new AbortController();
      const probe = vi.fn(async () => {
        if (visible === 'failed') throw new AppError('COMMAND_FAILED', 'grid failure');
        return visible;
      });
      const interactor = createWebDriverInteractor({
        client: {
          source: async () =>
            backend === 'android'
              ? ANDROID_ONBOARDING_SOURCE
              : '<AppiumAUT><XCUIElementTypeApplication x="0" y="0" width="390" height="844" /></AppiumAUT>',
          isKeyboardShown: probe,
        } as unknown as WebDriverClient,
        backend,
        capabilities: createCloudWebDriverCapabilities({
          provider: 'test',
          platform: backend === 'android' ? 'android' : 'ios',
        }),
      });
      const result = await interactor.snapshot({ signal: controller.signal });
      const keyboard = 'stage' in result ? result.acquisition.keyboard : result.keyboard;
      assert.deepEqual(
        keyboard,
        typeof visible === 'boolean'
          ? { kind: 'visibility-only', visible }
          : { kind: 'unmeasurable', reason: `keyboard-visibility-probe-${visible}` },
      );
      assert.deepEqual(probe.mock.calls, [[500, controller.signal]]);
    }
  }
});

test('snapshot cancellation during an optional keyboard probe is not swallowed', async () => {
  const controller = new AbortController();
  const interactor = createWebDriverInteractor({
    client: {
      source: async () => ANDROID_ONBOARDING_SOURCE,
      isKeyboardShown: async () => {
        controller.abort();
        throw controller.signal.reason;
      },
    } as unknown as WebDriverClient,
    backend: 'android',
    capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'android' }),
  });
  await assert.rejects(
    interactor.snapshot({ signal: controller.signal }),
    (error: unknown) => error === controller.signal.reason,
  );
});

test.each([true, false, 'failed'] as const)(
  'Android probe %s preserves tap-time docked IME derivation with a tree-resolved viewport',
  async (visibility) => {
    const interactor = createWebDriverInteractor({
      client: {
        source: async () =>
          '<hierarchy><node class="android.widget.FrameLayout" resource-id="com.android.systemui:id/status_bar" bounds="[0,0][1080,100]"/><node class="android.widget.FrameLayout" bounds="[0,100][1080,2400]"><node class="android.widget.Button" text="Form" bounds="[100,1800][300,1840]"/></node><node class="android.widget.FrameLayout" package="com.google.android.inputmethod.latin" bounds="[0,1500][1080,2400]"><node class="android.widget.FrameLayout" package="com.google.android.inputmethod.latin" resource-id="android:id/content" bounds="[0,1500][1080,2274]"/><node class="android.view.View" package="com.google.android.inputmethod.latin" resource-id="android:id/navigationBarBackground" bounds="[0,2274][1080,2400]"/></node></hierarchy>',
        isKeyboardShown: async () => {
          if (visibility === 'failed') throw new Error('probe failed');
          return visibility;
        },
      } as unknown as WebDriverClient,
      backend: 'android',
      capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'android' }),
    });
    const snapshot = await interactor.snapshot();
    assert.ok(!('stage' in snapshot));
    assert.ok(snapshot.nodes);
    const form = snapshot.nodes.find((node) => node.label === 'Form')!;
    assert.equal(
      resolveKeyboardTapOcclusion({
        nodes: snapshot.nodes,
        node: form,
        viewport: createSnapshotVisibility(snapshot.nodes).resolveViewport(form.rect!),
        point: { x: 200, y: 1820 },
        keyboard: snapshot.keyboard,
      }).kind,
      'occluded',
    );
    assert.equal(
      snapshot.nodes.find((node) => node.bundleId === 'com.google.android.inputmethod.latin')
        ?.keyboardOwned,
      true,
    );
  },
);
