import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ANDROID_EMULATOR, IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { makeSession } from '../../__tests__/test-utils/session-factories.ts';
import type { GenericPlatformExecutionParams } from '../request-generic-dispatch.ts';
import { resolveScreenshotGenericExecution } from '../screenshot-runtime.ts';
import { screenshotRuntimeFixture } from './screenshot-runtime-fixture.ts';
import type { DaemonRequest, SessionState } from '../types.ts';

const unavailableCapture = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf' as const,
  hint: 'screenshot is not supported on Vega OS: the Vega runtime exposes remote navigation only.',
});

function screenshotRequest(overrides: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    command: 'screenshot',
    token: 'test-token',
    session: 'default',
    positionals: [],
    ...overrides,
  };
}

function executionParams(
  session: SessionState,
  req: DaemonRequest,
): GenericPlatformExecutionParams {
  return {
    session,
    sessionName: session.name,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    command: 'screenshot',
    request: req,
    positionals: req.positionals ?? [],
    out: req.flags?.out,
    dispatchContext: {},
  };
}

test('admits one capture plan, binds once, and hands the runtime the resolved destination', async () => {
  const fixture = screenshotRuntimeFixture();
  const session = makeSession('default', { device: ANDROID_EMULATOR });
  const outPath = path.join(os.tmpdir(), `agent-device-bound-capture-${Date.now()}.png`);
  const req = screenshotRequest({ positionals: [outPath] });

  const resolved = await resolveScreenshotGenericExecution({
    req,
    session,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });

  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(fixture.binds).toHaveLength(1);
  await resolved.execute(executionParams(session, req));
  expect(fixture.captureScreenshot).toHaveBeenCalledTimes(1);
  expect(fixture.captureScreenshot.mock.calls[0]?.[0]).toMatchObject({ outPath });
  expect(fs.existsSync(outPath)).toBe(true);
});

test('an iOS simulator session capture skips the redundant boot probe', async () => {
  const fixture = screenshotRuntimeFixture();
  const session = makeSession('ios', { device: IOS_SIMULATOR });
  const outPath = path.join(os.tmpdir(), `agent-device-ios-boot-probe-${Date.now()}.png`);
  const req = screenshotRequest({ positionals: [outPath] });

  const resolved = await resolveScreenshotGenericExecution({
    req,
    session,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });
  if (!resolved.ok) throw new Error('screenshot admission must succeed');
  await resolved.execute(executionParams(session, req));

  expect(fixture.captureScreenshot.mock.calls[0]?.[0].options).toMatchObject({
    skipIosSimulatorBootCheck: true,
  });
});

test('refuses an unavailable exact-owner capture fact before binding', async () => {
  const fixture = screenshotRuntimeFixture({ capture: unavailableCapture });
  const session = makeSession('default', { device: ANDROID_EMULATOR });

  const resolved = await resolveScreenshotGenericExecution({
    req: screenshotRequest({ positionals: ['/tmp/unsupported.png'] }),
    session,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });

  expect(resolved).toEqual({
    ok: false,
    response: {
      ok: false,
      error: {
        code: 'UNSUPPORTED_OPERATION',
        message: 'screenshot is not supported on this device',
        hint: unavailableCapture.hint,
        details: { reason: 'unsupported-platform-leaf' },
      },
    },
  });
  expect(fixture.binds).toHaveLength(0);
  expect(fixture.captureScreenshot).not.toHaveBeenCalled();
});

test('--overlay-refs is refused up front when the target cannot capture a tree', async () => {
  const fixture = screenshotRuntimeFixture({
    snapshot: { available: false, reason: 'unsupported-platform-leaf' },
  });
  const session = makeSession('default', { device: ANDROID_EMULATOR });

  const resolved = await resolveScreenshotGenericExecution({
    req: screenshotRequest({ positionals: ['/tmp/overlay.png'], flags: { overlayRefs: true } }),
    session,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });

  expect(resolved.ok).toBe(false);
  if (resolved.ok) return;
  expect(resolved.response).toMatchObject({
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      hint: 'Re-run screenshot without --overlay-refs.',
    },
  });
  // Nothing was captured: a plan that cannot annotate never writes a PNG the caller must discard.
  expect(fixture.binds).toHaveLength(0);
  expect(fixture.captureScreenshot).not.toHaveBeenCalled();
});

test('the default destination is a reserved temp file, removed when the capture fails', async () => {
  let requestedPath: string | undefined;
  const fixture = screenshotRuntimeFixture({
    onCapture: (input) => {
      requestedPath = input.outPath;
      throw new Error('capture failed');
    },
  });
  const session = makeSession('default', { device: ANDROID_EMULATOR });
  const req = screenshotRequest();

  const resolved = await resolveScreenshotGenericExecution({
    req,
    session,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });
  if (!resolved.ok) throw new Error('screenshot admission must succeed');

  await expect(resolved.execute(executionParams(session, req))).rejects.toThrow(/capture failed/);
  expect(path.basename(requestedPath ?? '')).toBe('screenshot.png');
  expect(fs.existsSync(path.dirname(requestedPath ?? ''))).toBe(false);
});

test('rejects the retired max-size field before inspecting owner facts', async () => {
  const fixture = screenshotRuntimeFixture();
  const session = makeSession('default', { device: IOS_SIMULATOR });

  await expect(
    resolveScreenshotGenericExecution({
      req: screenshotRequest({
        positionals: ['/tmp/legacy.png'],
        flags: { screenshotMaxSize: 720 } as unknown as DaemonRequest['flags'],
      }),
      session,
      inspectFacts: fixture.inspectFacts,
      bindDevice: fixture.bindDevice,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(fixture.binds).toHaveLength(0);
});

test('rejects --pixel-density outside iOS-family simulators before inspecting owner facts', async () => {
  const fixture = screenshotRuntimeFixture();
  const session = makeSession('default', { device: ANDROID_EMULATOR });

  await expect(
    resolveScreenshotGenericExecution({
      req: screenshotRequest({
        positionals: ['/tmp/android.png'],
        flags: { screenshotPixelDensity: 2 },
      }),
      session,
      inspectFacts: fixture.inspectFacts,
      bindDevice: fixture.bindDevice,
    }),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  expect(fixture.binds).toHaveLength(0);
});
