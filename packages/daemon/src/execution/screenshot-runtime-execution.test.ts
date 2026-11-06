import { daemonPlatformServicesFixture } from '../__tests__/support/platform-services-fixture.ts';
import fs from 'node:fs';

import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { SCREENSHOT_CROP_REASONS } from '@agent-device/contracts/capture';
import type { CreateDaemonCommandSurface } from '@agent-device/contracts/daemon-command-surface';
import type { Interactor, ScreenshotOptions } from '@agent-device/contracts/interactor-types';
import {
  bindLocalScreenshotInteractor,
  defaultCaptureOnly,
} from '@agent-device/contracts/screenshot-runtime';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import {
  ANDROID_EMULATOR,
  IOS_DEVICE,
  IOS_SIMULATOR,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { makeSession } from '../__tests__/support/session-factories.ts';
import { contextFromFlags } from '../core/context.ts';
import type { GenericPlatformExecutionParams } from '../core/generic-leaf-execution.ts';
import { resolveScreenshotGenericExecution } from './screenshot-runtime.ts';
import {
  screenshotRuntimeFixture,
  writeSolidPng,
} from '../__tests__/support/screenshot-runtime-fixture.ts';
import type { DaemonRequest } from '../index.ts';
import type { SessionState } from '../core/session-state.ts';
import { screenshotCommandSurface as testCreateCommandSurface } from '../__tests__/support/screenshot-command-surface-fake.ts';

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

test('admits one capture plan, binds once, and hands the runtime the resolved destination', async () => {
  const fixture = screenshotRuntimeFixture();
  const session = makeSession('default', { device: ANDROID_EMULATOR });
  const outPath = path.join(
    mkdtempForTestSync('agent-device-bound-capture'),
    `agent-device-bound-capture-${Date.now()}.png`,
  );
  const req = screenshotRequest({ positionals: [outPath] });

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
  expect(fixture.binds).toHaveLength(1);
  await resolved.execute(executionParams(session, req));
  expect(fixture.captureScreenshot).toHaveBeenCalledTimes(1);
  expect(fixture.captureScreenshot.mock.calls[0]?.[0]).toMatchObject({ outPath });
  expect(fs.existsSync(outPath)).toBe(true);
});

test('an iOS simulator session capture skips the redundant boot probe', async () => {
  const fixture = screenshotRuntimeFixture();
  const session = makeSession('ios', { device: IOS_SIMULATOR });
  const outPath = path.join(
    mkdtempForTestSync('agent-device-ios-boot-probe'),
    `agent-device-ios-boot-probe-${Date.now()}.png`,
  );
  const req = screenshotRequest({ positionals: [outPath] });

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
  await resolved.execute(executionParams(session, req));

  expect(fixture.captureScreenshot.mock.calls[0]?.[0].options).toMatchObject({
    skipIosSimulatorBootCheck: true,
  });
});

test('refuses an unavailable exact-owner capture fact before binding', async () => {
  const fixture = screenshotRuntimeFixture({ capture: unavailableCapture });
  const session = makeSession('default', { device: ANDROID_EMULATOR });

  const resolved = await resolveScreenshotGenericExecution({
    hostCwd: process.cwd(),
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
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
    hostCwd: process.cwd(),
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
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
    hostCwd: process.cwd(),
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req,
    session,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });
  if (!resolved.ok) throw new Error('screenshot admission must succeed');

  await expect(resolved.execute(executionParams(session, req))).rejects.toThrow(/capture failed/);
  expect(path.basename(requestedPath ?? '')).toBe('screenshot.png');
  expect(path.basename(path.dirname(requestedPath ?? ''))).toContain('agent-device-screenshot-');
  expect(fs.existsSync(path.dirname(requestedPath ?? ''))).toBe(false);
});

test('rejects the retired max-size field before inspecting owner facts', async () => {
  const fixture = screenshotRuntimeFixture();
  const session = makeSession('default', { device: IOS_SIMULATOR });

  await expect(
    resolveScreenshotGenericExecution({
      hostCwd: process.cwd(),
      createCommandSurface: testCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
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
      hostCwd: process.cwd(),
      createCommandSurface: testCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
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

test('refuses --capture-backend runner with --pixel-density or --normalize-status-bar, and any other backend, before inspecting owner facts', async () => {
  const refused = async (
    device: SessionState['device'],
    // The wire flags are untyped, so a request can name a backend the type does not list.
    flags: Record<string, unknown>,
    code: string,
  ): Promise<void> => {
    const fixture = screenshotRuntimeFixture();
    await expect(
      resolveScreenshotGenericExecution({
        hostCwd: process.cwd(),
        createCommandSurface: testCreateCommandSurface,
        platformServices: daemonPlatformServicesFixture(),
        req: screenshotRequest({
          positionals: ['/tmp/runner.png'],
          flags: flags as DaemonRequest['flags'],
        }),
        session: makeSession('default', { device }),
        inspectFacts: fixture.inspectFacts,
        bindDevice: fixture.bindDevice,
      }),
    ).rejects.toMatchObject({ code });
    expect(fixture.binds).toHaveLength(0);
  };

  await refused(
    IOS_SIMULATOR,
    { screenshotCaptureBackend: 'runner', screenshotPixelDensity: 3 },
    'INVALID_ARGS',
  );
  await refused(
    IOS_SIMULATOR,
    { screenshotCaptureBackend: 'runner', screenshotNormalizeStatusBar: true },
    'INVALID_ARGS',
  );
  await refused(IOS_SIMULATOR, { screenshotCaptureBackend: 'simctl' }, 'INVALID_ARGS');
});

async function captureThroughRealBinding(
  params: Readonly<{
    device: SessionState['device'];
    flags: DaemonRequest['flags'];
    captureCapabilities: Parameters<typeof bindLocalScreenshotInteractor>[0]['captureCapabilities'];
  }>,
) {
  const fixture = screenshotRuntimeFixture();
  const screenshot = vi.fn(async (outPath: string, _options?: ScreenshotOptions) => {
    writeSolidPng(outPath);
    return {};
  });
  fixture.captureScreenshot.mockImplementation(
    bindLocalScreenshotInteractor({
      device: params.device,
      signal: new AbortController().signal,
      resolveInteractor: async () => ({ screenshot }) as unknown as Interactor,
      captureCapabilities: params.captureCapabilities,
    }).captureScreenshot,
  );
  const session = makeSession('capture', { device: params.device });
  const req = screenshotRequest({
    positionals: [path.join(mkdtempForTestSync('agent-device-bound-capture'), 'capture.png')],
    flags: params.flags,
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
  return {
    screenshot,
    execute: async () =>
      await executeResult(resolved, session, req, contextFromFlags('/tmp/daemon.log', req.flags)),
  };
}

test('a Maestro comparison capture reaches the interactor as a runner capture where the owner declares it', async () => {
  const { screenshot, execute } = await captureThroughRealBinding({
    device: IOS_SIMULATOR,
    flags: { maestro: { screenshotCaptureBackend: 'runner' } },
    captureCapabilities: () => ({ captureBackends: ['runner'] }),
  });

  await execute();

  expect(screenshot.mock.calls[0]?.[1]).toMatchObject({ captureBackend: 'runner' });
  expect(screenshot.mock.calls[0]?.[1]).not.toHaveProperty('preferredCaptureBackend');
});

test('a Maestro comparison capture keeps the default capture of an owner that declares no runner', async () => {
  const { screenshot, execute } = await captureThroughRealBinding({
    device: IOS_SIMULATOR,
    flags: { maestro: { screenshotCaptureBackend: 'runner' } },
    captureCapabilities: defaultCaptureOnly('this owner has one capture path'),
  });

  await execute();

  expect(screenshot.mock.calls[0]?.[1]).not.toHaveProperty('captureBackend');
});

test('an Android session refuses --capture-backend runner at its capture owner', async () => {
  const { screenshot, execute } = await captureThroughRealBinding({
    device: ANDROID_EMULATOR,
    flags: { screenshotCaptureBackend: 'runner' },
    captureCapabilities: defaultCaptureOnly('an Android device captures through adb'),
  });

  await expect(execute()).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'screenshot-capture-backend-unsupported' },
  });
  expect(screenshot).not.toHaveBeenCalled();
});

test('a --capture-backend runner request reaches the bound capture', async () => {
  const fixture = screenshotRuntimeFixture();
  const session = makeSession('ios', { device: IOS_SIMULATOR });
  const req = screenshotRequest({
    positionals: [path.join(mkdtempForTestSync('agent-device-runner-capture'), 'runner.png')],
    flags: { screenshotCaptureBackend: 'runner' },
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

  await executeResult(resolved, session, req, contextFromFlags('/tmp/daemon.log', req.flags));
  expect(fixture.captureScreenshot.mock.calls[0]?.[0]?.options?.captureBackend).toBe('runner');
});

const CROP_TREE_ROOT = {
  index: 0,
  depth: 0,
  type: 'android.widget.FrameLayout',
  rect: { x: 0, y: 0, width: 100, height: 50 },
} satisfies RawSnapshotNode;

const CROP_TREE = [
  CROP_TREE_ROOT,
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'android.widget.Button',
    label: 'Save',
    rect: { x: 10, y: 10, width: 40, height: 20 },
  },
];

test('the crop runs against the platform screenshot dimensions', async () => {
  const fixture = screenshotRuntimeFixture({
    snapshotResult: () => ({
      nodes: CROP_TREE,
      backend: 'android',
      producer: 'android-uiautomator',
    }),
  });
  const session = makeSession('default', { device: ANDROID_EMULATOR });
  const outPath = path.join(
    mkdtempForTestSync('agent-device-crop-order'),
    `agent-device-crop-order-${Date.now()}.png`,
  );
  const req = screenshotRequest({
    positionals: [outPath],
    flags: { screenshotCropOn: 'label="Save"' },
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
  const result = await executeResult(resolved, session, req);

  expect(fixture.captureScreenshot).toHaveBeenCalledTimes(1);
  expect(fixture.captureSnapshot).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ width: 40, height: 20 });
  expect(fixture.captureSnapshot.mock.calls[0]?.[0].options).toMatchObject({
    interactiveOnly: false,
    includeRects: true,
  });
});

for (const failure of ['sparse', 'canceled'] as const) {
  for (const destinationExists of [true, false]) {
    test(`${failure} crop preserves ${destinationExists ? 'existing' : 'absent'} destination and removes staging`, async () => {
      const controller = new AbortController();
      const fixture = screenshotRuntimeFixture({
        snapshotResult: () => {
          if (failure === 'canceled') controller.abort();
          return {
            nodes: CROP_TREE,
            backend: 'android',
            producer: 'android-uiautomator',
            ...(failure === 'sparse'
              ? { quality: { state: 'sparse' as const, backend: 'tree' } }
              : {}),
          };
        },
      });
      const session = makeSession('default', { device: ANDROID_EMULATOR });
      const outPath = path.join(mkdtempForTestSync('crop-publication'), 'capture.png');
      const sentinel = Buffer.from('existing destination');
      if (destinationExists) fs.writeFileSync(outPath, sentinel);
      const req = screenshotRequest({
        positionals: [outPath],
        flags: { screenshotCropOn: 'label="Save"' },
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
      await expect(
        executeResult(resolved, session, req, { signal: controller.signal }),
      ).rejects.toMatchObject(
        failure === 'sparse'
          ? { details: { reason: SCREENSHOT_CROP_REASONS.captureUnreadable } }
          : { name: 'AbortError' },
      );
      expect(fixture.captureScreenshot).toHaveBeenCalledTimes(1);
      expect(fixture.captureSnapshot).toHaveBeenCalledTimes(1);
      const stagedPath = fixture.captureScreenshot.mock.calls[0]?.[0].outPath;
      expect(stagedPath).toBeDefined();
      expect(stagedPath).not.toBe(outPath);
      if (stagedPath) expect(fs.existsSync(path.dirname(stagedPath))).toBe(false);
      if (destinationExists) expect(fs.readFileSync(outPath)).toEqual(sentinel);
      else expect(fs.existsSync(outPath)).toBe(false);
    });
  }
}

for (const outcome of ['capture failure', 'crop refusal', 'cancellation', 'published'] as const) {
  test(`staging cleanup failure preserves ${outcome}`, async () => {
    const controller = new AbortController();
    const captureFailure = new Error('capture transport failed');
    let stagedDirectory: string | undefined;
    const fixture = screenshotRuntimeFixture({
      onCapture: (input) => {
        stagedDirectory = path.dirname(input.outPath);
        writeSolidPng(input.outPath);
        if (outcome === 'capture failure') throw captureFailure;
      },
      snapshotResult: () => {
        if (outcome === 'cancellation') controller.abort();
        return {
          nodes: outcome === 'crop refusal' ? [] : CROP_TREE,
          backend: 'android',
          producer: 'android-uiautomator',
        };
      },
    });
    const session = makeSession('default', { device: ANDROID_EMULATOR });
    const outPath = path.join(mkdtempForTestSync('crop-cleanup-outcome'), 'capture.png');
    const sentinel = Buffer.from('old destination');
    fs.writeFileSync(outPath, sentinel);
    const req = screenshotRequest({
      positionals: [outPath],
      flags: { screenshotCropOn: 'label="Save"' },
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
    const remove = fs.promises.rm;
    const cleanup = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === stagedDirectory) throw new Error('staging removal refused');
      await remove(target, options);
    });
    try {
      const operation = executeResult(resolved, session, req, { signal: controller.signal });
      if (outcome === 'published') {
        await expect(operation).resolves.toMatchObject({ path: outPath, width: 40, height: 20 });
        expect(fs.readFileSync(outPath)).not.toEqual(sentinel);
      } else {
        if (outcome === 'capture failure') await expect(operation).rejects.toBe(captureFailure);
        if (outcome === 'crop refusal')
          await expect(operation).rejects.toMatchObject({
            details: { reason: SCREENSHOT_CROP_REASONS.targetNotFound },
          });
        if (outcome === 'cancellation')
          await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
        expect(fs.readFileSync(outPath)).toEqual(sentinel);
      }
      expect(stagedDirectory).toBeDefined();
      if (stagedDirectory) expect(fs.existsSync(stagedDirectory)).toBe(true);
    } finally {
      cleanup.mockRestore();
      if (stagedDirectory) fs.rmSync(stagedDirectory, { recursive: true, force: true });
    }
  });
}

test('a partial crop surfaces its warning once in the result record and annotates nothing', async () => {
  const fixture = screenshotRuntimeFixture({
    snapshotResult: () => ({
      nodes: [
        CROP_TREE_ROOT,
        {
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'android.widget.Button',
          label: 'Save',
          rect: { x: 80, y: 10, width: 50, height: 20 },
        },
      ],
      backend: 'android',
      producer: 'android-uiautomator',
    }),
  });
  const session = makeSession('default', { device: ANDROID_EMULATOR });
  const outPath = path.join(
    mkdtempForTestSync('agent-device-crop-warning'),
    `agent-device-crop-warning-${Date.now()}.png`,
  );
  const req = screenshotRequest({
    positionals: [outPath],
    flags: { screenshotCropOn: 'label="Save"' },
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
  const result = await executeResult(resolved, session, req);

  expect(result.warnings).toEqual([
    expect.stringMatching(new RegExp(`^${SCREENSHOT_CROP_REASONS.partialIntersection}:`)),
  ]);
  // The crop plan binds the snapshot for the crop alone: no overlay refs, no republished tree.
  expect(result).not.toHaveProperty('overlayRefs');
  expect(session.snapshot).toBeUndefined();
});

test('the crop plan is refused up front when the target cannot capture a tree', async () => {
  const fixture = screenshotRuntimeFixture({
    snapshot: { available: false, reason: 'unsupported-platform-leaf' },
  });
  const session = makeSession('default', { device: ANDROID_EMULATOR });

  const resolved = await resolveScreenshotGenericExecution({
    hostCwd: process.cwd(),
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: screenshotRequest({
      positionals: ['/tmp/crop.png'],
      flags: { screenshotCropOn: 'label="Save"' },
    }),
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
      details: { reason: 'unsupported-platform-leaf' },
      hint: 'Re-run screenshot without --crop-on.',
    },
  });
  expect(fixture.binds).toHaveLength(0);
  expect(fixture.captureScreenshot).not.toHaveBeenCalled();
});

test('the result record carries the display rotation the capture reported', async () => {
  const fixture = screenshotRuntimeFixture({
    onCapture: (input) => {
      writeSolidPng(input.outPath);
      return { displayRotation: 'landscape-left' };
    },
  });
  const session = makeSession('default', { device: ANDROID_EMULATOR });
  const outPath = path.join(mkdtempForTestSync('agent-device-display-rotation'), 'shot.png');
  const req = screenshotRequest({ positionals: [outPath] });

  const resolved = await resolveScreenshotGenericExecution({
    hostCwd: process.cwd(),
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req,
    session,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });

  expect(await executeResult(resolved, session, req)).toMatchObject({
    path: outPath,
    displayRotation: 'landscape-left',
  });
});

test('the result record omits the display rotation when the capture reported none', async () => {
  const fixture = screenshotRuntimeFixture();
  const session = makeSession('default', { device: ANDROID_EMULATOR });
  const outPath = path.join(mkdtempForTestSync('agent-device-display-rotation'), 'shot.png');
  const req = screenshotRequest({ positionals: [outPath] });

  const resolved = await resolveScreenshotGenericExecution({
    hostCwd: process.cwd(),
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req,
    session,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });

  expect(await executeResult(resolved, session, req)).not.toHaveProperty('displayRotation');
});

for (const backend of ['coredevice', 'xctest', undefined] as const) {
  for (const crop of [false, true]) {
    test(`physical iPhone capture backend=${backend}, crop=${crop} enforces capture evidence`, async () => {
      const fixture = screenshotRuntimeFixture({
        onCapture: ({ outPath }) => {
          writeSolidPng(outPath);
          return backend ? { iosPhysicalCaptureBackend: backend } : {};
        },
        snapshotResult: () => ({ nodes: CROP_TREE, backend: 'xctest', producer: 'apple-runner' }),
      });
      const session = makeSession('iphone', { device: IOS_DEVICE });
      const outPath = path.join(mkdtempForTestSync('physical-crop'), 'screen.png');
      const req = screenshotRequest({
        positionals: [outPath],
        flags: crop ? { screenshotCropOn: 'label="Save"' } : {},
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
      if (crop && backend !== 'coredevice') {
        await expect(executeResult(resolved, session, req)).rejects.toMatchObject({
          code: 'UNSUPPORTED_OPERATION',
          message:
            'screenshot --crop-on is not accepted on ios-physical-non-coredevice-capture targets',
          details: {
            reason: SCREENSHOT_CROP_REASONS.targetNotAccepted,
            rejectionReason: SCREENSHOT_CROP_REASONS.pendingPixelIdentityEvidence,
          },
        });
        expect(fixture.captureSnapshot).not.toHaveBeenCalled();
      } else {
        const result = await executeResult(resolved, session, req);
        expect(result).toMatchObject(crop ? { width: 40, height: 20 } : { width: 100, height: 50 });
        expect(fixture.captureSnapshot).toHaveBeenCalledTimes(crop ? 1 : 0);
      }
      expect(fixture.captureScreenshot).toHaveBeenCalledTimes(1);
    });
  }
}

test('a request screen mask reaches the bound simulator capture without changing later requests', async () => {
  const fixture = screenshotRuntimeFixture();
  const session = makeSession('ios-mask', { device: IOS_SIMULATOR });
  const outPath = path.join(mkdtempForTestSync('screen-mask-request'), 'screen.png');
  for (const screenMask of ['black', undefined] as const) {
    const req = screenshotRequest({
      positionals: [outPath],
      flags: screenMask ? { screenshotScreenMask: screenMask } : {},
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
    await executeResult(resolved, session, req, req.flags);
    expect(fixture.captureScreenshot.mock.lastCall?.[0].options?.screenMask).toBe(screenMask);
  }
});

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
  expect(fs.existsSync(frames[0]!.path)).toBe(true);
  expect(fs.existsSync(frames[1]!.path)).toBe(true);
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
  const execution = resolved.execute(
    executionParams(session, req, {
      count: req.flags?.count,
      intervalMs: req.flags?.intervalMs,
      signal: controller.signal,
    }),
  );
  controller.abort();
  await expect(execution).rejects.toThrow();
  expect(fixture.captureScreenshot.mock.calls.length).toBeLessThan(3);
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
            warnings: [`frame ${frame} note one`, `frame ${frame} note two`],
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
  expect(result.warnings).toEqual(['frame 1 note one', 'frame 1 note two']);
});
