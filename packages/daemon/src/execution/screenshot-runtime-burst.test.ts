import { daemonPlatformServicesFixture } from '../__tests__/support/platform-services-fixture.ts';
import fs from 'node:fs';

import path from 'node:path';
import { expect, test } from 'vitest';
import type { CreateDaemonCommandSurface } from '@agent-device/contracts/daemon-command-surface';
import { ANDROID_EMULATOR, mkdtempForTestSync } from '@agent-device/test-kit';
import { makeSession } from '../__tests__/support/session-factories.ts';
import type { GenericPlatformExecutionParams } from '../core/generic-leaf-execution.ts';
import { resolveScreenshotGenericExecution } from './screenshot-runtime.ts';
import { screenshotRuntimeFixture } from '../__tests__/support/screenshot-runtime-fixture.ts';
import type { DaemonRequest } from '../index.ts';
import type { SessionState } from '../core/session-state.ts';
import { screenshotCommandSurface as testCreateCommandSurface } from '../__tests__/support/screenshot-command-surface-fake.ts';

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
  dispatchContext: GenericPlatformExecutionParams['dispatchContext'] = {},
): GenericPlatformExecutionParams {
  return {
    session,
    sessionName: session.name,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    command: 'screenshot',
    request: req,
    positionals: req.positionals ?? [],
    out: req.flags?.out,
    dispatchContext,
  };
}

async function executeResult(
  resolved: Awaited<ReturnType<typeof resolveScreenshotGenericExecution>>,
  session: SessionState,
  req: DaemonRequest,
  dispatchContext?: GenericPlatformExecutionParams['dispatchContext'],
): Promise<Record<string, unknown>> {
  if (!resolved.ok) throw new Error('the screenshot plan must be admitted');
  const result = await resolved.execute(executionParams(session, req, dispatchContext));
  if (result === undefined) throw new Error('the screenshot leaf returns a result record');
  return result;
}

test('a --count burst captures the numbered sequence in one request and reports every frame', async () => {
  const fixture = screenshotRuntimeFixture();
  const session = makeSession('default', { device: ANDROID_EMULATOR });
  const outDir = mkdtempForTestSync('agent-device-burst');
  const outPath = path.join(outDir, 'page.png');
  const req = screenshotRequest({ positionals: [outPath], flags: { count: 3, intervalMs: 100 } });

  const resolved = await resolveScreenshotGenericExecution({
    hostCwd: process.cwd(),
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req,
    session,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;

  const result = await executeResult(resolved, session, req, req.flags);

  expect(fixture.binds).toHaveLength(1);
  expect(fixture.captureScreenshot).toHaveBeenCalledTimes(3);
  const destinations = fixture.captureScreenshot.mock.calls.map((call) => call[0]?.outPath);
  expect(destinations).toEqual([
    path.join(outDir, 'page-0001.png'),
    path.join(outDir, 'page-0002.png'),
    path.join(outDir, 'page-0003.png'),
  ]);
  for (const destination of destinations) {
    expect(fs.existsSync(destination)).toBe(true);
  }
  const frames = result.frames as Array<{ path: string; capturedAtMs: number }>;
  expect(frames.map((frame) => frame.path)).toEqual(destinations);
  expect(frames[0]!.capturedAtMs).toBeLessThanOrEqual(frames[1]!.capturedAtMs);
  expect(frames[1]!.capturedAtMs).toBeLessThanOrEqual(frames[2]!.capturedAtMs);
  expect(result).toMatchObject({
    path: path.join(outDir, 'page-0001.png'),
    width: 100,
    height: 50,
    message: `Saved 3 screenshots starting at ${path.join(outDir, 'page-0001.png')}`,
  });
});

test('a burst without an explicit path keeps every frame in one temp root', async () => {
  const fixture = screenshotRuntimeFixture();
  const session = makeSession('default', { device: ANDROID_EMULATOR });
  const req = screenshotRequest({ flags: { count: 2 } });

  const resolved = await resolveScreenshotGenericExecution({
    hostCwd: process.cwd(),
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req,
    session,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });
  if (!resolved.ok) throw new Error('screenshot admission must succeed');

  const result = await executeResult(resolved, session, req, req.flags);
  const frames = result.frames as Array<{ path: string }>;
  expect(frames).toHaveLength(2);
  expect(path.dirname(frames[0]!.path)).toBe(path.dirname(frames[1]!.path));
  expect(new Set(frames.map((frame) => frame.path)).size).toBe(2);
  expect(fs.existsSync(frames[0]!.path)).toBe(true);
  expect(fs.existsSync(frames[1]!.path)).toBe(true);
});

test('a burst that fails past frame 1 leaves no implicit temp root behind', async () => {
  const fixture = screenshotRuntimeFixture();
  const session = makeSession('default', { device: ANDROID_EMULATOR });
  const req = screenshotRequest({ flags: { count: 3 } });

  const resolved = await resolveScreenshotGenericExecution({
    hostCwd: process.cwd(),
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req,
    session,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });
  if (!resolved.ok) throw new Error('screenshot admission must succeed');
  fixture.captureScreenshot.mockImplementationOnce(async () => ({}));
  fixture.captureScreenshot.mockRejectedValueOnce(new Error('second frame capture failed'));

  await expect(executeResult(resolved, session, req, req.flags)).rejects.toThrow(
    'second frame capture failed',
  );
  expect(fixture.captureScreenshot).toHaveBeenCalledTimes(2);

  // The implicit root that held frame 1 is gone. Another concurrent run could
  // own its own root, so this checks the one this burst created — the dirname
  // the failure reported, not a global sweep.
  let frameOneDir: string | undefined;
  try {
    frameOneDir = path.dirname(fixture.captureScreenshot.mock.calls[0]![0]!.outPath);
  } catch {
    frameOneDir = undefined;
  }
  expect(frameOneDir).toBeDefined();
  expect(fs.existsSync(frameOneDir!)).toBe(false);
});

test('burst admission refuses crop, overlay, and misbounded flags before any device work', async () => {
  const fixture = screenshotRuntimeFixture();
  const session = makeSession('default', { device: ANDROID_EMULATOR });
  const refusals: Array<{ label: string; flags: Record<string, unknown> }> = [
    { label: 'interval without count', flags: { intervalMs: 200 } },
    { label: 'count below two', flags: { count: 1 } },
    { label: 'overlong schedule', flags: { count: 150, intervalMs: 500 } },
    { label: 'crop beside burst', flags: { count: 3, screenshotCropOn: 'role=button label=Save' } },
    { label: 'overlay beside burst', flags: { count: 3, overlayRefs: true } },
  ];
  for (const refusal of refusals) {
    const req = screenshotRequest({ flags: refusal.flags });
    await expect(
      resolveScreenshotGenericExecution({
        hostCwd: process.cwd(),
        createCommandSurface: testCreateCommandSurface,
        platformServices: daemonPlatformServicesFixture(),
        req,
        session,
        inspectFacts: fixture.inspectFacts,
        bindDevice: fixture.bindDevice,
      }),
      refusal.label,
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  }
  expect(fixture.binds).toHaveLength(0);
  expect(fixture.captureScreenshot).not.toHaveBeenCalled();
});

test('a cancelled request stops the burst before the next frame', async () => {
  const fixture = screenshotRuntimeFixture();
  const session = makeSession('default', { device: ANDROID_EMULATOR });
  const outDir = mkdtempForTestSync('agent-device-burst-cancel');
  const req = screenshotRequest({
    positionals: [path.join(outDir, 'page.png')],
    flags: { count: 3, intervalMs: 100 },
  });

  const resolved = await resolveScreenshotGenericExecution({
    hostCwd: process.cwd(),
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req,
    session,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });
  if (!resolved.ok) throw new Error('screenshot admission must succeed');

  const controller = new AbortController();
  fixture.captureScreenshot.mockImplementation(async () => {
    controller.abort();
    return {};
  });
  const execution = resolved.execute(
    executionParams(session, req, {
      count: req.flags?.count,
      intervalMs: req.flags?.intervalMs,
      signal: controller.signal,
    }),
  );
  await expect(execution).rejects.toThrow();
  // The abort lands in the first capture's callback, so exactly one frame may
  // complete before the plan rejects; a later-frame cancellation would show 2.
  expect(fixture.captureScreenshot.mock.calls.length).toBe(1);
});

/** A command surface whose every capture reports the given warnings, so a burst frames them. */
function burstWarningSurface(warnings: string[]): CreateDaemonCommandSurface {
  return async (config) => {
    const forwarded = await testCreateCommandSurface(config);
    return {
      ...forwarded,
      capture: {
        ...forwarded.capture,
        screenshot: async (options) => ({
          ...(await forwarded.capture.screenshot(options)),
          warnings,
        }),
      },
    };
  };
}

test('a burst reports a warning the frames share once', async () => {
  const fixture = screenshotRuntimeFixture();
  const session = makeSession('default', { device: ANDROID_EMULATOR });
  const outDir = mkdtempForTestSync('agent-device-burst-warnings');
  const req = screenshotRequest({
    positionals: [path.join(outDir, 'page.png')],
    flags: { count: 3, intervalMs: 100 },
  });

  const resolved = await resolveScreenshotGenericExecution({
    hostCwd: process.cwd(),
    createCommandSurface: burstWarningSurface(['the status bar was busy; the capture waited']),
    platformServices: daemonPlatformServicesFixture(),
    req,
    session,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });

  const result = await executeResult(resolved, session, req, req.flags);
  expect(fixture.captureScreenshot).toHaveBeenCalledTimes(3);
  expect(result.warnings).toEqual(['the status bar was busy; the capture waited']);
});

test('a burst keeps the warnings array within one note per frame', async () => {
  const fixture = screenshotRuntimeFixture();
  const session = makeSession('default', { device: ANDROID_EMULATOR });
  const outDir = mkdtempForTestSync('agent-device-burst-warning-bound');
  const req = screenshotRequest({
    positionals: [path.join(outDir, 'page.png')],
    flags: { count: 2, intervalMs: 100 },
  });
  let frame = 0;
  const warningSurface: CreateDaemonCommandSurface = async (config) => {
    const forwarded = await testCreateCommandSurface(config);
    return {
      ...forwarded,
      capture: {
        ...forwarded.capture,
        screenshot: async (options) => {
          frame += 1;
          return {
            ...(await forwarded.capture.screenshot(options)),
            warnings: ['the frames share one note', `frame ${frame} contributes its own`],
          };
        },
      },
    };
  };

  const resolved = await resolveScreenshotGenericExecution({
    hostCwd: process.cwd(),
    createCommandSurface: warningSurface,
    platformServices: daemonPlatformServicesFixture(),
    req,
    session,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });

  const result = await executeResult(resolved, session, req, req.flags);
  // The shared note collapses to one entry and frame 1 contributes its own;
  // the bound (count 2) then stops frame 2's note — proving the aggregation
  // consumed frame 2's list against the shared budget, not just frame 1's.
  expect(result.warnings).toEqual(['the frames share one note', 'frame 1 contributes its own']);
});
