import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { mkdtempForTest } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
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
): Promise<
  Readonly<{
    fixture: RevylFixtureBackend;
    interactor: Interactor;
    runtime: ReturnType<RevylFixtureBackend['createRuntime']>;
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
  const interactor = runtime.getInteractor(device);
  if (!interactor) throw new Error('Expected a live session interactor.');
  return { fixture, interactor, runtime };
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
  const { interactor } = await liveInteractor('ios');
  const outPath = path.join(await mkdtempForTest('agent-device-revyl-shot-'), 'shot.png');
  await interactor.screenshot(outPath);
  const written = await fs.readFile(outPath);
  assert.equal(written[0], 0x89);
  assert.equal(written.subarray(1, 4).toString('ascii'), 'PNG');
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
