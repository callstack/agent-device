import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { mkdtempForTest } from '@agent-device/test-kit';
import { PNG } from '@agent-device/capture-kit/png';
import { readPngSize } from '@agent-device/capture-kit/png-size';
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
import { REVYL_IOS_HIERARCHY } from './revyl-ios-hierarchy.fixtures.ts';

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
  const report = (await interactor.scroll?.('down', { pixels: 300 })) as Record<string, unknown>;

  assert.deepEqual(fixture.bodyFor('drag'), {
    start_x: 195,
    start_y: 572,
    end_x: 195,
    end_y: 272,
  });
  assert.equal(report.pixels, 300);
  assert.equal(report.direction, 'down');
  // Revyl's `/drag` body has no duration field, so the report names none: a duration the worker never
  // ran must not appear as though it were honored.
  assert.equal('durationMs' in report, false);
});

test('a scroll that names a duration is refused rather than run at another speed', async () => {
  // The caller asked how fast the finger travels and Revyl's drag cannot be told, so the command is
  // answered with that fact. Running the drag at Revyl's speed in silence would drop what was asked for.
  const { fixture, interactor } = await liveInteractor('ios');

  await assert.rejects(
    () => interactor.scroll?.('down', { pixels: 300, durationMs: 900 }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      error.details?.reason === 'unsupported-provider-mode' &&
      error.details?.flag === '--duration-ms',
  );
  assert.equal(
    fixture.paths().some((request) => request.endsWith('/drag')),
    false,
    'the refused scroll sends no gesture',
  );
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
        contentType: 'application/json',
        body: REVYL_IOS_HIERARCHY,
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
    readHierarchy: () =>
      new Promise<string>((resolve) => {
        deliverTree = () => resolve(REVYL_IOS_HIERARCHY);
      }),
    viewport: () => undefined,
  };
  const capture = captureRevylSnapshot(
    { platform: 'ios', runId: 'run-1' },
    reader,
    controller.signal,
  );
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

test('the iOS snapshot reads the AX node tree Revyl answers with, in the root frame', async () => {
  const { interactor } = await liveInteractor('ios', { hierarchy: REVYL_IOS_HIERARCHY });
  const result = await interactor.snapshot({});
  if ('stage' in result === false || result.stage !== 'acquired')
    throw new Error('Expected an iOS acquisition');
  const { acquisition } = result;
  assert.equal(acquisition.producer, 'revyl-ios-tree');
  assert.deepEqual(acquisition.viewport, {
    kind: 'derived',
    rect: { x: 0, y: 0, width: 440, height: 956 },
  });
  assert.deepEqual(acquisition.lineage, { targetId: 'run-1' });
  const row = acquisition.nodes.find((node) => node.label?.startsWith('Activity Indicators'));
  assert.deepEqual(row?.rect, { x: 0, y: 116, width: 440, height: 44 });
  assert.equal(acquisition.nodes[0]?.type, 'Application');
});

for (const [name, hierarchy] of [
  ['XML', '<AppiumAUT><XCUIElementTypeApplication/></AppiumAUT>'],
  ['a null node', '[null]'],
  ['a null child', '[{"type":"Application","children":[null]}]'],
  ['a child list that is not a list', '[{"type":"Application","children":{}}]'],
] as const) {
  test(`an iOS hierarchy holding ${name} is reported as an invalid response`, async () => {
    const { interactor } = await liveInteractor('ios', { hierarchy });
    await assert.rejects(
      async () => await interactor.snapshot({}),
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'provider-response-invalid',
    );
  });
}

test('an iOS tree without a usable root frame takes the health screen as its viewport', async () => {
  const { interactor } = await liveInteractor('ios', {
    screen: { width: 440, height: 956 },
    hierarchy: JSON.stringify([{ type: 'Application', AXLabel: 'App', children: [] }]),
  });
  const result = await interactor.snapshot({});
  if (!('stage' in result) || result.stage !== 'acquired')
    throw new Error('Expected an iOS acquisition');
  assert.deepEqual(result.acquisition.viewport, {
    kind: 'reported',
    rect: { x: 0, y: 0, width: 440, height: 956 },
  });
});

test('an iOS screenshot whose density is unknown is refused rather than published at the wrong scale', async () => {
  const { interactor } = await liveInteractor('ios', { withoutScreen: true });
  const outPath = path.join(await mkdtempForTest('agent-device-revyl-shot-noscreen-'), 'shot.png');
  await assert.rejects(
    async () => await interactor.screenshot(outPath),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'provider-viewport-unavailable',
  );
  await assert.rejects(fs.access(outPath));
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
  const { fixture, interactor } = await liveInteractor('android');
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

test('an iOS screenshot is rescaled from its native scale to the requested density', async () => {
  // Revyl captures a 2x2-point screen at 3x; the host reports iOS simulator screenshots at 1x unless
  // the caller asks for another density.
  const native = new PNG({ width: 6, height: 6 });
  const { interactor } = await liveInteractor('ios', {
    screen: { width: 2, height: 2 },
    respond: {
      'GET /api/v1/execution/device-proxy/run-1/screenshot': () => ({
        contentType: 'image/png',
        body: [...PNG.sync.write(native)],
      }),
    },
  });
  const directory = await mkdtempForTest('agent-device-revyl-shot-density-');

  await interactor.screenshot(path.join(directory, 'default.png'));
  await interactor.screenshot(path.join(directory, 'native.png'), { pixelDensity: 3 });

  assert.deepEqual(await readPngSize(path.join(directory, 'default.png')), { width: 2, height: 2 });
  assert.deepEqual(await readPngSize(path.join(directory, 'native.png')), { width: 6, height: 6 });
});

test('two captures of one path each keep their own temporary file', async () => {
  // Both writes land in the same directory with the same base name. If they shared a temporary sibling, the
  // first rename would move it away and the second would fail with ENOENT on a file that is no longer there.
  const { fixture, interactor } = await liveInteractor('android');
  const outPath = path.join(await mkdtempForTest('agent-device-revyl-shot-race-'), 'shot.png');

  await Promise.all([interactor.screenshot(outPath), interactor.screenshot(outPath)]);

  assert.equal(
    fixture.paths().filter((request) => request.includes('/screenshot')).length,
    2,
    'both captures reached the worker',
  );
  const written = await fs.readFile(outPath);
  assert.equal(written.subarray(1, 4).toString('ascii'), 'PNG');
  assert.deepEqual(
    (await fs.readdir(path.dirname(outPath))).filter((entry) => entry !== 'shot.png'),
    [],
    'a capture leaves no temporary file behind',
  );
});

test('a screenshot canceled after its bytes arrive is not published', async () => {
  // The worker has answered, so the cancellation cannot reach the request: it lands while the local write
  // runs. The caller that hung up is owed a failure, not a file it stopped asking for, and the bytes it
  // canceled have to be taken back off the disk. The abort is issued the moment the temporary file appears,
  // and the body is large enough that the write is still in flight across the next turn of the loop.
  const controller = new AbortController();
  const { interactor } = await liveInteractor(
    'android',
    {
      respond: {
        'GET /api/v1/execution/device-proxy/run-1/screenshot': {
          status: 200,
          contentType: 'image/png',
          body: 'P'.repeat(8 * 1024 * 1024),
        },
      },
    },
    { signal: controller.signal },
  );
  const directory = await mkdtempForTest('agent-device-revyl-shot-after-');
  const outPath = path.join(directory, 'shot.png');

  const capturing = interactor.screenshot(outPath);
  await waitForWriteToStart(directory);
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
    'the canceled capture never reaches the requested path',
  );
  assert.deepEqual(
    await fs.readdir(directory),
    [],
    'the bytes it wrote are taken back off the disk',
  );
});

/**
 * Waits until one capture's temporary sibling shows up in the directory, which is the moment its write is
 * in flight and the abort has somewhere to land.
 */
async function waitForWriteToStart(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const entries = await fs.readdir(directory);
    if (entries.some((entry) => entry.endsWith('.tmp'))) return;
    await new Promise((resolve) => setTimeout(resolve, 0.2));
  }
  throw new Error(
    'The screenshot never reached its write, so the cancellation had nothing to interrupt.',
  );
}

test('a canceled screenshot leaves the file unwritten', async () => {
  // The worker is still composing the PNG when the caller hangs up. The request has to end there, and
  // the bytes that arrive afterwards must not reach the path the command was asked to write.
  const controller = new AbortController();
  const { interactor } = await liveInteractor(
    'android',
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

test('a close that names an app before any launch is refused instead of ending the session app', async () => {
  // Nothing has launched on this session, so Revyl's app-killing action would end whatever its worker
  // happens to run — an app the caller never named. The refusal says so, and an unnamed close is still
  // allowed, because then the caller is asking for the session's own app.
  const { fixture, interactor } = await liveInteractor('ios');

  await assert.rejects(
    () => interactor.close('com.example.app'),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      error.details?.reason === 'provider-app-not-launched' &&
      error.details?.requestedApp === 'com.example.app',
  );
  assert.equal(
    fixture.paths().filter((request) => request.endsWith('/kill_app')).length,
    0,
    'the refused close sends nothing',
  );

  await interactor.close('');
  assert.deepEqual(fixture.paths().at(-1), 'POST /api/v1/execution/device-proxy/run-1/kill_app');
});

function relaunchInput(app: string) {
  return {
    target: app,
    positionals: [app],
    appBundleId: app,
    surface: 'app' as const,
    hasExistingSession: true,
    relaunch: true,
    prewarmRunnerBeforeOpen: false,
    enableTestIme: false,
    stateDir: '/tmp',
    runtimeHints: {},
    execution: { requestId: 'request-1' },
  };
}

/**
 * This drives the real lifecycle binding rather than the interactor alone: the relaunch ends the
 * running app itself, so the `close <app>` guard never sees an app the session did not launch.
 */
test('a relaunch open into another app ends the running app, then launches', async () => {
  const { fixture, runtime, device } = await liveInteractor('ios');
  const launched = runtime.getInteractor(device);
  if (!launched) throw new Error('Expected a live session interactor.');
  await launched.open('com.example.app');
  const before = fixture.paths().length;

  const lifecycle = bindRevylApplicationLifecycle({
    device,
    signal: new AbortController().signal,
    getInteractor: (target, runner) => runtime.getInteractor(target, runner),
  });

  await lifecycle.openApplication(relaunchInput('com.other.app'));

  const actions = fixture
    .paths()
    .slice(before)
    .map((request) => request.split('/').at(-1)!);
  assert.deepEqual(actions, ['kill_app', 'launch']);
  assert.deepEqual(fixture.bodyFor('launch'), { bundle_id: 'com.other.app' });
});

test('a relaunch on a fresh session needs no earlier launch', async () => {
  const { fixture, runtime, device } = await liveInteractor('ios');
  const lifecycle = bindRevylApplicationLifecycle({
    device,
    signal: new AbortController().signal,
    getInteractor: (target, runner) => runtime.getInteractor(target, runner),
  });

  const before = fixture.paths().length;

  await lifecycle.openApplication(relaunchInput('com.example.app'));

  assert.deepEqual(
    fixture
      .paths()
      .slice(before)
      .map((request) => request.split('/').at(-1)),
    ['kill_app', 'launch'],
  );
});

test('the lifecycle refuses a close naming another app, even when the command resolves to it', async () => {
  const { fixture, runtime, device } = await liveInteractor('ios');
  const launched = runtime.getInteractor(device);
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
        appBundleId: 'com.unrelated.app',
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
