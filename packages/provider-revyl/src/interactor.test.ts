import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { mkdtempForTest } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import { captureRevylSnapshot, type RevylSnapshotReader } from './snapshot.ts';
import { bindRevylApplicationLifecycle } from './lifecycle.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  revylLease,
  startRevylFixtureBackend,
  type RevylFixtureBackend,
} from './revyl-backend.fixtures.ts';
import type { Interactor } from '@agent-device/contracts/interactor-types';

const IOS_HIERARCHY =
  '<AppiumAUT><XCUIElementTypeApplication name="Calculator" x="0" y="0" width="390" height="844"><XCUIElementTypeButton label="Seven" name="seven" x="16" y="600" width="80" height="60" /></XCUIElementTypeApplication></AppiumAUT>';
const ANDROID_HIERARCHY =
  '<hierarchy rotation="0"><android.widget.FrameLayout class="android.widget.FrameLayout" package="com.example" resource-id="android:id/content" bounds="[0,0][1080,2400]"><android.widget.Button class="android.widget.Button" package="com.example" text="Login" bounds="[40,1200][300,1300]" displayed="true" enabled="true" /></android.widget.FrameLayout></hierarchy>';

const openBackends: RevylFixtureBackend[] = [];

async function backend(options?: Parameters<typeof startRevylFixtureBackend>[0]) {
  const started = await startRevylFixtureBackend(options);
  openBackends.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(openBackends.splice(0).map((fixture) => fixture.close()));
});

async function liveInteractor(
  platform: 'ios' | 'android',
  options?: Parameters<typeof startRevylFixtureBackend>[0],
  runner?: { signal: AbortSignal },
): Promise<
  Readonly<{
    fixture: RevylFixtureBackend;
    interactor: Interactor;
    runtime: ReturnType<RevylFixtureBackend['createRuntime']>;
    device: DeviceInfo;
  }>
> {
  const fixture = await backend(options);
  const runtime = fixture.createRuntime();
  await runtime.leaseLifecycle?.allocate?.(revylLease(platform));
  const device = (
    await runtime.deviceInventoryProvider?.({
      leaseProvider: 'revyl',
      leaseId: 'lease-1',
      platform,
    })
  )?.[0];
  if (!device) throw new Error('Expected the live session to be listed.');
  const interactor = runtime.getInteractor(device, runner);
  if (!interactor) throw new Error('Expected a live session interactor.');
  return { fixture, interactor, runtime, device };
}

test('touch actions send Revyl point bodies with the agent header', async () => {
  const { fixture, interactor } = await liveInteractor('ios');
  await interactor.tap(120, 340);
  await interactor.doubleTap?.(120, 340);
  await interactor.longPress?.(120, 340, 800);
  await interactor.focus(120, 340);

  assert.deepEqual(
    fixture
      .paths()
      .filter((request) => request.includes('/device-proxy/') && !request.endsWith('/health')),
    [
      'POST /api/v1/execution/device-proxy/run-1/tap',
      'POST /api/v1/execution/device-proxy/run-1/double_tap',
      'POST /api/v1/execution/device-proxy/run-1/longpress',
      'POST /api/v1/execution/device-proxy/run-1/tap',
    ],
  );
  assert.deepEqual(fixture.bodyFor('tap'), { x: 120, y: 340 });
  assert.deepEqual(fixture.bodyFor('double_tap'), { x: 120, y: 340 });
  assert.deepEqual(fixture.bodyFor('longpress'), { x: 120, y: 340, duration_ms: 800 });
  assert.equal(
    fixture.requests.find((request) => request.path.endsWith('/tap'))?.agentHeader,
    'agent-device',
  );
});

test('a worker refusal carried inside a 200 body is reported as a failed action', async () => {
  const { fixture, interactor } = await liveInteractor('ios', {
    respond: {
      'POST /api/v1/execution/device-proxy/run-1/tap': {
        body: { success: false, error: 'invalid coordinates' },
      },
    },
  });
  await assert.rejects(
    interactor.tap(4000, 4000),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'COMMAND_FAILED' &&
      error.details?.reason === 'provider-refused',
  );
  // The request really went out: a refusal the worker reports is not retried or replayed.
  assert.equal(fixture.paths().filter((p) => p.endsWith('/tap')).length, 1);
  void fixture;
});

test('fill rides the input action and an empty fill rides clear_text', async () => {
  const { fixture, interactor } = await liveInteractor('android');
  await interactor.fill(80, 1250, 'hello');
  await interactor.fill(80, 1250, '');

  assert.deepEqual(fixture.bodyFor('input'), { x: 80, y: 1250, text: 'hello', clear_first: true });
  assert.deepEqual(fixture.bodyFor('clear_text'), { x: 80, y: 1250 });
  assert.equal(
    fixture.paths().filter((request) => request.endsWith('/input')).length,
    1,
    'an unpaced fill is one input action',
  );
});

test('a paced fill types one character per pause and clears only on the first', async () => {
  const { fixture, interactor } = await liveInteractor('android');
  const startedAt = Date.now();
  await interactor.fill(80, 1250, 'abc', 150);
  const elapsed = Date.now() - startedAt;

  const inputs = fixture.requests.filter((request) => request.path.endsWith('/input'));
  assert.deepEqual(
    inputs.map((request) => request.body),
    [
      { x: 80, y: 1250, text: 'a', clear_first: true },
      { x: 80, y: 1250, text: 'b', clear_first: false },
      { x: 80, y: 1250, text: 'c', clear_first: false },
    ],
    'the field is cleared once, then each character is typed in order',
  );
  // Two pauses for three characters, which is what the paced fill waits out. That the last character does
  // not wait out a pause of its own is what the fill's own return proves, not a clock.
  assert.ok(elapsed >= 290, `three paced characters must not land at once (took ${elapsed} ms)`);
});

test('a paced fill that fails partway says how much of the text landed', async () => {
  // The third character is the one Revyl refuses.
  let typed = 0;
  const { interactor } = await liveInteractor('android', {
    respond: {
      'POST /api/v1/execution/device-proxy/run-1/input': () => {
        typed += 1;
        if (typed >= 3) return { status: 500, body: { detail: 'worker dropped the run' } };
        return { body: { success: true } };
      },
    },
  });

  await assert.rejects(
    interactor.fill(80, 1250, 'abcd', 1),
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.dispatchedSteps === 2 &&
      error.details?.dispatched === 'unknown',
  );
});

test('a paced fill canceled mid-text reports the characters that completed', async () => {
  // The second character is answered only after the caller has hung up, so the first is the last
  // action that completed. Receipt is the wrong moment to count from: a request the backend had already
  // served can still be rejected by the abort, which would make a request count disagree with the steps
  // the fill actually finished.
  const controller = new AbortController();
  let sent = 0;
  const { fixture, interactor } = await liveInteractor(
    'android',
    {
      respond: {
        'POST /api/v1/execution/device-proxy/run-1/input': () => {
          sent += 1;
          return sent >= 2
            ? { delayMs: 3_000, body: { success: true } }
            : { body: { success: true } };
        },
      },
    },
    { signal: controller.signal },
  );
  const inputs = () => fixture.requests.filter((request) => request.path.endsWith('/input')).length;

  const filling = interactor.fill(80, 1250, 'abcdef', 20);
  await waitFor(() => inputs() >= 2);
  controller.abort();

  const completedInputs = () =>
    fixture.answeredPaths().filter((path) => path.endsWith('/input')).length;
  await assert.rejects(
    async () => await filling,
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'request_canceled' &&
      // The evidence names the completed action, not the one still on the wire.
      error.details?.dispatchedSteps === 1 &&
      completedInputs() === 1,
  );
  assert.equal(inputs(), 2, 'no character is typed after the cancellation');
});

test('a paced fill that has typed all its text reports no cancellation', async () => {
  // The pause goes between characters, so after the last one there is none left to wait out: the fill is
  // over the moment its final character is answered. A caller that hangs up then must not be told its text
  // was canceled when every character of it reached the device.
  const controller = new AbortController();
  const { fixture, interactor } = await liveInteractor('android', undefined, {
    signal: controller.signal,
  });
  const filling = interactor.fill(80, 1250, 'ab', 50);
  await waitFor(
    () => fixture.answeredPaths().filter((path) => path.endsWith('/input')).length >= 2,
  );
  // The answer's own beat, so the fill has returned before the caller hangs up.
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();

  await filling;
  assert.equal(
    fixture.requests.filter((request) => request.path.endsWith('/input')).length,
    2,
    'the text is typed once',
  );
});

test('a paced fill canceled during its pause reports the typed cancellation', async () => {
  // The pause is the other boundary, and the one the timer's own `AbortError` arrives from. Where the
  // abort lands — on the answer's heels or inside the pause — decides only how many characters made it,
  // so the count is not asserted here; the error's type is, and the pause is orders of magnitude longer
  // than the tick the abort needs to reach the wait.
  const controller = new AbortController();
  const { fixture, interactor } = await liveInteractor('android', undefined, {
    signal: controller.signal,
  });
  const filling = interactor.fill(80, 1250, 'abcdef', 5_000);
  await waitFor(() => fixture.answeredPaths().some((path) => path.endsWith('/input')));
  controller.abort();

  await assert.rejects(
    async () => await filling,
    (error: unknown) => error instanceof AppError && error.details?.reason === 'request_canceled',
  );
  assert.ok(
    fixture.requests.filter((request) => request.path.endsWith('/input')).length <= 1,
    'no character is typed after the cancellation',
  );
});

test('type is refused with the fill hint instead of going to an unnamed point', async () => {
  const { fixture, interactor } = await liveInteractor('android');
  assert.throws(
    () => interactor.type('hello'),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      error.details?.reason === 'unsupported-provider-mode' &&
      error.details?.command === 'type',
  );
  assert.equal(
    fixture.paths().some((request) => request.endsWith('/input')),
    false,
  );
});

test('scroll dispatches the planned finger path as one drag', async () => {
  const { fixture, interactor } = await liveInteractor('ios');
  const report = (await interactor.scroll?.('down', {
    pixels: 300,
    durationMs: 900,
  })) as Record<string, unknown>;

  assert.deepEqual(fixture.bodyFor('drag'), {
    start_x: 195,
    start_y: 572,
    end_x: 195,
    end_y: 272,
  });
  assert.equal(report.pixels, 300);
  assert.equal(report.direction, 'down');
  // Revyl's `/drag` body has no duration field, so the report names none either: a duration the
  // worker never ran must not appear as though it were honored.
  assert.equal('durationMs' in report, false);
});

test('a session whose health reported no screen refuses to plan a scroll', async () => {
  const { fixture, interactor } = await liveInteractor('ios', { withoutScreen: true });
  await assert.rejects(
    interactor.scroll?.('down'),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'provider-viewport-unavailable',
  );
  assert.equal(
    fixture.paths().some((request) => request.endsWith('/drag')),
    false,
  );
});

test('a capture the caller gave up on does not report a snapshot finished afterwards', async () => {
  // The hierarchy answer is held back, so the abort lands while the read is in flight and the tree
  // still arrives afterwards.
  const { fixture, interactor } = await liveInteractor('ios', {
    respond: {
      'GET /api/v1/execution/device-proxy/run-1/hierarchy': {
        delayMs: 300,
        contentType: 'application/xml',
        body: IOS_HIERARCHY,
      },
    },
  });
  const controller = new AbortController();
  const capture = interactor.snapshot({ signal: controller.signal });
  await waitFor(() => fixture.paths().some((request) => request.endsWith('/hierarchy')));
  controller.abort();

  await assert.rejects(
    async () => await capture,
    (error: unknown) => error instanceof AppError && error.details?.reason === 'request_canceled',
  );
  assert.equal(
    fixture.paths().filter((request) => request.endsWith('/hierarchy')).length,
    1,
    'the aborted read is not retried',
  );
});

test('a capture whose tree arrives after the caller gave up reports no snapshot', async () => {
  // The read itself cannot fail here: the reader answers once the caller has already gone, so only
  // the check that follows the read can keep a canceled capture from reporting a finished snapshot.
  const controller = new AbortController();
  let deliverTree: () => void = () => {};
  const reader: RevylSnapshotReader = {
    readHierarchyXml: () =>
      new Promise<string>((resolve) => {
        deliverTree = () => resolve(IOS_HIERARCHY);
      }),
    viewport: () => undefined,
  };
  const capture = captureRevylSnapshot({ platform: 'ios' }, reader, controller.signal);
  controller.abort();
  // The tree lands after the abort, which is the race the check after the read has to lose on purpose.
  deliverTree();

  await assert.rejects(
    async () => await capture,
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
    'the canceled capture must not report the tree that arrived late',
  );
});

/** Waits for a fixture-side fact, which is how a test races a request without a fixed sleep. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('The fixture never reached the expected state.');
}

test('the iOS snapshot comes back as an acquisition parsed from the hierarchy XML', async () => {
  const { interactor } = await liveInteractor('ios', { hierarchy: IOS_HIERARCHY });
  const result = await interactor.snapshot({});
  if ('stage' in result === false || result.stage !== 'acquired')
    throw new Error('Expected an iOS acquisition');
  assert.equal(result.acquisition.producer, 'appium-source');
  assert.equal(result.acquisition.nodes[0]?.type, 'XCUIElementTypeApplication');
  assert.ok(
    result.acquisition.nodes.some((node) => node.label === 'Seven'),
    'the button label must survive the parse',
  );
});

test('the Android snapshot comes back as nodes parsed from the uiautomator dump', async () => {
  const { interactor } = await liveInteractor('android', { hierarchy: ANDROID_HIERARCHY });
  const result = await interactor.snapshot({});
  if ('acquisition' in result) throw new Error('Android answers as a plain snapshot result');
  assert.equal(result.backend, 'android');
  assert.equal(result.producer, 'appium-source');
  const nodes = 'acquisition' in result ? [] : (result.nodes ?? []);
  const login = nodes.find((node) => node.label === 'Login');
  assert.equal(login?.bundleId, 'com.example');
  assert.deepEqual(login?.rect, { x: 40, y: 1200, width: 260, height: 100 });
  assert.deepEqual(result.viewport, { width: 390, height: 844 });
});

test('a screenshot writes the worker bytes to the requested path', async () => {
  const { fixture, interactor } = await liveInteractor('ios');
  const outPath = path.join(await mkdtempForTest('agent-device-revyl-shot-'), 'shot.png');
  await interactor.screenshot(outPath);

  // The bytes have to have come from this session's worker, so the read is asserted before the file.
  assert.deepEqual(
    fixture.paths().filter((request) => request.includes('/screenshot')),
    ['GET /api/v1/execution/device-proxy/run-1/screenshot'],
  );
  const written = await fs.readFile(outPath);
  assert.equal(written[0], 0x89);
  assert.equal(written.subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(written.length, 68, 'the fixture answers a real 1x1 PNG');
  // The write goes through a temporary file in the same directory and is renamed into place, so nothing of
  // the capture is left behind once the path holds the PNG.
  assert.deepEqual(
    (await fs.readdir(path.dirname(outPath))).filter((entry) => entry !== 'shot.png'),
    [],
  );
});

test('a canceled screenshot leaves the file unwritten', async () => {
  // The worker is still composing the PNG when the caller hangs up. The request has to end there, and
  // the bytes that arrive afterwards must not reach the path the command was asked to write.
  const controller = new AbortController();
  const { interactor } = await liveInteractor(
    'ios',
    {
      respond: {
        'GET /api/v1/execution/device-proxy/run-1/screenshot': {
          status: 200,
          contentType: 'image/png',
          body: 'PNG',
          delayMs: 400,
        },
      },
    },
    { signal: controller.signal },
  );
  const outPath = path.join(await mkdtempForTest('agent-device-revyl-shot-cancel-'), 'shot.png');
  const capturing = interactor.screenshot(outPath);
  controller.abort();

  await assert.rejects(
    async () => await capturing,
    (error: unknown) => error instanceof AppError && error.details?.reason === 'request_canceled',
  );
  assert.equal(
    await fs.stat(outPath).then(
      () => true,
      () => false,
    ),
    false,
  );
});

test('launch names the bundle, an unnamed open lets the worker start its own app, and close kills it', async () => {
  const { fixture, interactor } = await liveInteractor('ios');
  await interactor.open('com.example.app');
  await interactor.open('');
  await interactor.close('com.example.app');

  assert.deepEqual(fixture.bodyFor('launch'), {});
  assert.deepEqual(
    fixture.paths().filter((p) => p.endsWith('/launch')),
    [
      'POST /api/v1/execution/device-proxy/run-1/launch',
      'POST /api/v1/execution/device-proxy/run-1/launch',
    ],
  );
  assert.deepEqual(fixture.requests.find((r) => r.path.endsWith('/launch'))?.body, {
    bundle_id: 'com.example.app',
  });
  assert.deepEqual(fixture.paths().at(-1), 'POST /api/v1/execution/device-proxy/run-1/kill_app');
});

test('a close that names an app the session never launched is refused rather than answered', async () => {
  const { fixture, interactor } = await liveInteractor('ios');
  await interactor.open('com.example.app');

  // Revyl's `/kill_app` carries no bundle id, so the only honest answer is the refusal: killing the
  // session's app would not be what the caller asked for.
  await assert.rejects(
    () => interactor.close('com.other.app'),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'unsupported-provider-mode',
  );
  assert.equal(
    fixture.paths().some((request) => request.endsWith('/kill_app')),
    false,
  );

  // The app the session did launch is still closeable.
  await interactor.close('com.example.app');
  assert.deepEqual(fixture.paths().at(-1), 'POST /api/v1/execution/device-proxy/run-1/kill_app');
});

test('a close before any launch still ends the session app, which is the one Revyl runs', async () => {
  const { fixture, interactor } = await liveInteractor('ios');
  await interactor.close('com.example.app');

  assert.deepEqual(fixture.paths().at(-1), 'POST /api/v1/execution/device-proxy/run-1/kill_app');
});

/**
 * The shared direct lifecycle closes the app it is about to launch before launching it, so this drives
 * the real binding rather than the interactor alone: a guard that only knew the session's own app would
 * refuse the close this open makes and no direct call would show it.
 */
test('a relaunch open into another app closes its way there instead of refusing', async () => {
  const { fixture, runtime, device } = await liveInteractor('ios');
  const launched = runtime.getInteractor(device, { appBundleId: 'com.example.app' });
  if (!launched) throw new Error('Expected a live session interactor.');
  await launched.open('com.example.app');
  const before = fixture.paths().length;

  const lifecycle = bindRevylApplicationLifecycle({
    device,
    signal: new AbortController().signal,
    getInteractor: (target, runner) => runtime.getInteractor(target, runner),
  });

  await lifecycle.openApplication({
    target: 'com.other.app',
    positionals: ['com.other.app'],
    appBundleId: 'com.other.app',
    surface: 'app',
    hasExistingSession: true,
    relaunch: true,
    prewarmRunnerBeforeOpen: false,
    enableTestIme: false,
    stateDir: '/tmp',
    runtimeHints: {},
    execution: { requestId: 'request-1' },
  });

  const actions = fixture
    .paths()
    .slice(before)
    .map((request) => request.split('/').at(-1)!);
  // The session was launched elsewhere, so the first action this request takes is the close of the app
  // it is about to start; the refusal would have stopped the open before it began.
  assert.deepEqual(actions, ['kill_app', 'launch']);
  assert.deepEqual(fixture.bodyFor('launch'), { bundle_id: 'com.other.app' });
});

test('the same lifecycle still refuses a close that names an app no open is heading to', async () => {
  const { fixture, runtime, device } = await liveInteractor('ios');
  const launched = runtime.getInteractor(device, { appBundleId: 'com.example.app' });
  if (!launched) throw new Error('Expected a live session interactor.');
  await launched.open('com.example.app');

  const lifecycle = bindRevylApplicationLifecycle({
    device,
    signal: new AbortController().signal,
    getInteractor: (target, runner) => runtime.getInteractor(target, runner),
  });
  await assert.rejects(
    () =>
      lifecycle.closeApplication({
        positionals: ['com.unrelated.app'],
        surface: 'app',
        execution: { requestId: 'request-2' },
      }),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'unsupported-provider-mode',
  );
  assert.equal(
    fixture.paths().some((request) => request.endsWith('/kill_app')),
    false,
  );
});

test('a deep link opens through the URL action without launching an app', async () => {
  const { fixture, interactor } = await liveInteractor('ios');
  await interactor.open('myapp://checkout/42');

  assert.deepEqual(fixture.bodyFor('open_url'), { url: 'myapp://checkout/42' });
  assert.equal(
    fixture.paths().some((request) => request.endsWith('/launch')),
    false,
  );
});

test('home rides the only system button the worker answers', async () => {
  const { fixture, interactor } = await liveInteractor('ios');
  await interactor.home?.();
  assert.deepEqual(fixture.paths().at(-1), 'POST /api/v1/execution/device-proxy/run-1/go_home');
});

test('launch arguments are refused with the deep-link hint', async () => {
  const { fixture, interactor } = await liveInteractor('ios');
  await assert.rejects(
    interactor.open('com.example.app', { launchArgs: ['--seed', '1'] }),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'unsupported-provider-mode',
  );
  assert.equal(
    fixture.paths().some((request) => request.endsWith('/launch')),
    false,
  );
});
