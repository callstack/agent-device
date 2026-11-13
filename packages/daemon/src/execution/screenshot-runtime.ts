import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDaemonScreenshotArtifactAdapter } from './screenshot-artifact-adapter.ts';
import { expandSessionPath } from '@agent-device/host-kit/session-paths';
import { sleep } from '@agent-device/host-kit/retry';
import type { CommandFlags } from '@agent-device/contracts/command';
import {
  retiredScreenshotMaxSizeFlagError,
  SCREENSHOT_BURST_LIMITS,
  SCREENSHOT_CAPTURE_BACKENDS,
  screenshotBurstFramePath,
  screenshotFlagsFromOptions,
  screenshotOptionsFromFlags,
  validateScreenshotBurst,
  type ScreenshotBurstFrame,
} from '@agent-device/contracts/capture';
import type { DeviceRotation } from '@agent-device/contracts/device';
import type { ScreenshotRuntimeExecution } from '@agent-device/contracts/screenshot-runtime';
import { isIosFamily, publicPlatformString } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { successText } from '@agent-device/kernel/success-text';
import type { ScreenshotOverlayRef } from '@agent-device/kernel/snapshot';
import type { AgentDeviceBackend } from '@agent-device/contracts/backend';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import type { CreateDaemonCommandSurface } from '@agent-device/contracts/daemon-command-surface';
import {
  assertSupportedScreenshotPixelDensity,
  readScreenshotResultMetadata,
} from '@agent-device/capture-kit/screenshot-density';
import { runtimeExecutionFromContext } from '../core/snapshot-runtime-capture-input.ts';
import { requestCwd, type DaemonCommandContext } from '../core/context.ts';
import { captureSnapshotData } from '../core/snapshot-capture.ts';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';
import type {
  RecordedGenericRequest,
  ResolvedGenericExecution,
} from '../core/generic-leaf-execution.ts';
import { createReadonlyRuntimeSessionStore } from '../core/runtime-session.ts';
import {
  assertScreenshotCropCapture,
  assertScreenshotCropPolicy,
} from './screenshot-crop-target.ts';
import { buildScreenshotCropWarnings, cropScreenshotToSelector } from './screenshot-crop.ts';
import { annotateScreenshotWithRefs } from '@agent-device/capture-kit/screenshot-overlay';
import {
  resolveBoundScreenshotRuntime,
  type BoundScreenshotRuntime,
  type ScreenshotRuntimeBindings,
} from './screenshot-runtime-binding.ts';
import { setSessionSnapshot } from './session-snapshot.ts';
import type { DaemonRequest } from '../core/daemon-request.ts';
import type { SessionState } from '../core/session-state.ts';

/**
 * The `screenshot` leaf of the generic route. Argument policy is answered before any device work,
 * then one plan is admitted and bound once; the returned closure is what the generic dispatcher
 * runs in place of legacy platform dispatch.
 */
export async function resolveScreenshotGenericExecution(
  params: Readonly<{
    req: DaemonRequest;
    session: SessionState;
    createCommandSurface: CreateDaemonCommandSurface;
    /** The runtime host's working directory: the fallback base for a client-typed output path. */
    hostCwd: string;
  }> &
    ScreenshotRuntimeBindings,
): Promise<ResolvedGenericExecution> {
  const { req, session } = params;
  const retiredMaxSize = retiredScreenshotMaxSizeFlagError('screenshot', req.flags);
  if (retiredMaxSize) throw new AppError('INVALID_ARGS', retiredMaxSize);
  assertSupportedScreenshotPixelDensity(session.device, req.flags?.screenshotPixelDensity);
  assertSupportedScreenshotCaptureBackend(req.flags);
  validateScreenshotBurst({
    count: req.flags?.count,
    intervalMs: req.flags?.intervalMs,
    cropOn: req.flags?.screenshotCropOn,
    overlayRefs: req.flags?.overlayRefs === true ? true : undefined,
  });

  const request = readScreenshotRequest(req, params.hostCwd);
  const cropOn =
    typeof req.flags?.screenshotCropOn === 'string' && req.flags.screenshotCropOn.length > 0
      ? req.flags.screenshotCropOn
      : undefined;
  if (cropOn !== undefined) {
    assertScreenshotCropPolicy({
      device: session.device,
      surface: session.surface,
      cropOn,
      overlayRefs: req.flags?.overlayRefs === true,
      fullscreen: req.flags?.screenshotFullscreen === true,
    });
  }
  const resolved = await resolveBoundScreenshotRuntime({
    device: session.device,
    overlayRefs: req.flags?.overlayRefs === true,
    cropOn,
    inspectFacts: params.inspectFacts,
    platformServices: params.platformServices,
    bindDevice: params.bindDevice,
  });
  if (!resolved.ok) return resolved;

  const runtime = resolved.runtime;
  const cropRun: ScreenshotCropRun = { warnings: [] };
  const { createCommandSurface } = params;
  return {
    ok: true,
    recorded: request.recorded,
    execute: async (execution) =>
      await executeScreenshot({
        createCommandSurface,
        session: execution.session,
        sessionName: execution.sessionName,
        logPath: execution.logPath,
        dispatchContext: execution.dispatchContext,
        flags: execution.request.flags,
        outPath: request.outPath,
        runtime,
        cropOn,
        cropRun,
      }),
  };
}

/**
 * Reserves the artifact, runs the admitted capture, and applies the shared scale/publish policy.
 * Also serves the two observation paths that capture a screenshot as evidence rather than as the
 * command the caller asked for.
 */
export async function captureScreenshotArtifact(
  params: Readonly<{
    createCommandSurface: CreateDaemonCommandSurface;
    session: SessionState;
    sessionName: string;
    outPath?: string;
    dispatchContext: DaemonCommandContext;
    captureScreenshot: BoundScreenshotRuntime['captureScreenshot'];
    crop?: ScreenshotCropBinding;
  }>,
): Promise<CapturedScreenshot> {
  const { session, sessionName, outPath, dispatchContext } = params;
  const runtime = await params.createCommandSurface({
    backend: createBoundScreenshotBackend(params),
    artifacts: createDaemonScreenshotArtifactAdapter(
      params.crop !== undefined,
      dispatchContext.signal,
    ),
    sessions: createReadonlyRuntimeSessionStore(sessionName, session),
    policy: localCommandPolicy(),
  });

  return await runtime.capture.screenshot({
    session: sessionName,
    requestId: dispatchContext.requestId,
    appBundleId: session.appBundleId,
    ...screenshotOptionsFromFlags(dispatchContext),
    surface: session.surface,
    ...(outPath ? { out: { kind: 'path', path: outPath } } : {}),
  });
}

/**
 * What the shared capture command hands back. Restated here rather than imported from
 * `commands/`: the daemon sits below the command surface (R2), and this adapter's artifact
 * publisher emits no descriptors, so the destination, the capture's display rotation, and the
 * message are the whole result.
 */
type CapturedScreenshot = Readonly<{
  path: string;
  displayRotation?: DeviceRotation;
  message?: string;
  warnings?: string[];
}>;

/** One request's crop state: the backend closure appends, the result record reads. */
type ScreenshotCropRun = { warnings: string[] };

/** The crop orchestration the backend closure runs after the platform write, before scale. */
type ScreenshotCropBinding = Readonly<{
  cropOn: string;
  captureSnapshot: NonNullable<BoundScreenshotRuntime['captureSnapshot']>;
  run: ScreenshotCropRun;
  logPath: string;
}>;

/**
 * Runner metadata the capture needs; cancellation comes from the request binding, not from here.
 *
 * `ScreenshotRuntimeExecution` and `SnapshotRuntimeExecution` are the same type — both
 * `Readonly<Omit<RunnerContext, 'appBundleId' | 'signal'>>` — so the projection is shared rather
 * than restated. Keeping the screenshot-facing name preserves this module's callers.
 */
export function screenshotExecutionFromContext(
  context: DaemonCommandContext,
): ScreenshotRuntimeExecution {
  return runtimeExecutionFromContext(context);
}

async function executeScreenshot(
  params: Readonly<{
    createCommandSurface: CreateDaemonCommandSurface;
    session: SessionState;
    sessionName: string;
    logPath: string;
    dispatchContext: DaemonCommandContext;
    flags: CommandFlags | undefined;
    outPath: string | undefined;
    runtime: BoundScreenshotRuntime;
    cropOn?: string;
    cropRun?: ScreenshotCropRun;
  }>,
): Promise<Record<string, unknown>> {
  const { session, runtime, flags } = params;
  const burst = readScreenshotBurstPlan(params.dispatchContext);
  if (burst) {
    return await executeBurstScreenshot({ ...params, burst });
  }
  const crop = buildScreenshotCropBinding({
    cropOn: params.cropOn,
    captureSnapshot: runtime.captureSnapshot,
    cropRun: params.cropRun,
    logPath: params.logPath,
  });
  const captured = await captureScreenshotArtifact({
    createCommandSurface: params.createCommandSurface,
    session,
    sessionName: params.sessionName,
    outPath: params.outPath,
    dispatchContext: params.dispatchContext,
    captureScreenshot: runtime.captureScreenshot,
    ...(crop ? { crop } : {}),
  });
  const warnings = [...(captured.warnings ?? []), ...(crop?.run?.warnings ?? [])];
  return {
    ...captured,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(await screenshotOverlayRefsField({
      session,
      cropOn: params.cropOn,
      captureSnapshot: runtime.captureSnapshot,
      screenshotPath: captured.path,
      logPath: params.logPath,
      dispatchContext: params.dispatchContext,
    })),
    ...(await readScreenshotResultMetadata({
      device: session.device,
      path: captured.path,
      requestedPixelDensity: flags?.screenshotPixelDensity,
      scale: flags?.screenshotScale,
    })),
  };
}

/**
 * The admitted burst: the frame count and the wait between frames. The count rode the request's
 * shared `count`/`intervalMs` flags through `DispatchContextFlags`; only the interval has a
 * screenshot default, because those flags serve press and swipe series too.
 */
type ScreenshotBurstPlan = Readonly<{ count: number; intervalMs: number }>;

function readScreenshotBurstPlan(
  dispatchContext: DaemonCommandContext,
): ScreenshotBurstPlan | undefined {
  const { count, intervalMs } = dispatchContext;
  if (count === undefined) return undefined;
  return { count, intervalMs: intervalMs ?? SCREENSHOT_BURST_LIMITS.defaultIntervalMs };
}

/**
 * The `--count` burst: one admitted plan, captured sequentially frame by frame through the same
 * single-capture path, each frame into its own numbered destination. The result reports every
 * frame with its capture wall clock; the top-level fields describe the first frame, because every
 * frame reads the same screen at the same size. Admission refuses a burst beside `--crop-on` and
 * `--overlay-refs`, so this loop never carries the crop or overlay state.
 */
async function executeBurstScreenshot(
  params: Readonly<{
    createCommandSurface: CreateDaemonCommandSurface;
    session: SessionState;
    sessionName: string;
    logPath: string;
    dispatchContext: DaemonCommandContext;
    flags: CommandFlags | undefined;
    outPath: string | undefined;
    runtime: BoundScreenshotRuntime;
    burst: ScreenshotBurstPlan;
  }>,
): Promise<Record<string, unknown>> {
  const { burst, dispatchContext } = params;
  const signal = dispatchContext.signal;
  const tempRoot =
    params.outPath === undefined
      ? await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-screenshot-burst-'))
      : undefined;
  const frameDestination = (index: number): string =>
    params.outPath !== undefined
      ? screenshotBurstFramePath(params.outPath, index)
      : path.join(tempRoot!, `screenshot-${String(index).padStart(4, '0')}.png`);
  const frames: ScreenshotBurstFrame[] = [];
  const warnings: string[] = [];
  try {
    for (let index = 1; index <= burst.count; index += 1) {
      signal?.throwIfAborted();
      if (index > 1 && burst.intervalMs > 0) {
        await sleep(burst.intervalMs, signal);
        // The sleep resolves on an abort too, so this check is what stops a
        // canceled request from dispatching the next frame.
        signal?.throwIfAborted();
      }
      const captured = await captureScreenshotArtifact({
        createCommandSurface: params.createCommandSurface,
        session: params.session,
        sessionName: params.sessionName,
        outPath: frameDestination(index),
        dispatchContext,
        captureScreenshot: params.runtime.captureScreenshot,
      });
      appendBurstWarnings(warnings, captured.warnings, burst.count);
      frames.push({
        path: captured.path,
        capturedAtMs: Date.now(),
        ...(captured.displayRotation ? { displayRotation: captured.displayRotation } : {}),
      });
    }
  } catch (error) {
    // A failed or canceled burst leaves no implicit root behind; an explicit
    // --out path keeps whatever the caller named.
    if (tempRoot !== undefined)
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const first = frames[0]!;
  return {
    path: first.path,
    frames,
    ...(first.displayRotation ? { displayRotation: first.displayRotation } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...successText(`Saved ${burst.count} screenshots starting at ${first.path}`),
    ...(await readScreenshotResultMetadata({
      device: params.session.device,
      path: first.path,
      requestedPixelDensity: params.flags?.screenshotPixelDensity,
      scale: params.flags?.screenshotScale,
    })),
  };
}

/**
 * The response's warning channel stays bounded: a note the frames share appears once, and the
 * array holds at most one note per frame. A capture owner that degrades on every frame of the
 * animation must not multiply its note by the frame count.
 */
function appendBurstWarnings(warnings: string[], additions: string[] | undefined, bound: number) {
  for (const warning of additions ?? []) {
    if (warnings.length >= bound) return;
    if (!warnings.includes(warning)) warnings.push(warning);
  }
}

/** Present exactly when the admitted plan carries a crop and the snapshot binding to serve it. */
function buildScreenshotCropBinding(
  params: Readonly<{
    cropOn: string | undefined;
    captureSnapshot: BoundScreenshotRuntime['captureSnapshot'];
    cropRun: ScreenshotCropRun | undefined;
    logPath: string;
  }>,
): ScreenshotCropBinding | undefined {
  const { cropOn, captureSnapshot, cropRun } = params;
  if (cropOn === undefined || captureSnapshot === undefined || cropRun === undefined) {
    return undefined;
  }
  return { cropOn, captureSnapshot, run: cropRun, logPath: params.logPath };
}

/**
 * `--overlay-refs` republishes the annotated tree as the session's snapshot, so the refs it drew
 * are the refs a following interaction resolves. The tree comes from the same admitted binding as
 * the capture — the plan required both operations before either ran. The crop plan binds the
 * snapshot for the crop alone, so a crop request never annotates or republishes.
 */
async function screenshotOverlayRefsField(
  params: Readonly<{
    session: SessionState;
    cropOn: string | undefined;
    captureSnapshot: BoundScreenshotRuntime['captureSnapshot'];
    screenshotPath: string;
    logPath: string;
    dispatchContext: DaemonCommandContext;
  }>,
): Promise<Readonly<Record<string, unknown>>> {
  const { session, cropOn, captureSnapshot } = params;
  if (cropOn !== undefined || captureSnapshot === undefined) return {};
  return {
    overlayRefs: await annotateScreenshotWithSessionRefs({
      session,
      logPath: params.logPath,
      screenshotPath: params.screenshotPath,
      dispatchContext: params.dispatchContext,
      captureSnapshot,
    }),
  };
}

/**
 * The overlay-refs tree capture: interactive-only, through the same admitted binding as the
 * screenshot, stored as the session snapshot so the burned-in refs stay the authorized frame.
 */
async function annotateScreenshotWithSessionRefs(
  params: Readonly<{
    session: SessionState;
    logPath: string;
    screenshotPath: string;
    dispatchContext: DaemonCommandContext;
    captureSnapshot: NonNullable<BoundScreenshotRuntime['captureSnapshot']>;
  }>,
): Promise<ScreenshotOverlayRef[]> {
  const { session, dispatchContext } = params;
  const overlaySnapshotFlags = { snapshotInteractiveOnly: true } satisfies CommandFlags;
  const overlaySnapshotData = await captureSnapshotData({
    device: session.device,
    session,
    flags: overlaySnapshotFlags,
    logPath: params.logPath,
    snapshotScope: undefined,
    captureData: async () =>
      await params.captureSnapshot({
        options: {
          appBundleId: session.appBundleId,
          interactiveOnly: true,
          surface: session.surface,
        },
        execution: screenshotExecutionFromContext(dispatchContext),
      }),
  });
  const overlaySnapshot = buildSnapshotState(overlaySnapshotData, overlaySnapshotFlags);
  setSessionSnapshot(session, overlaySnapshot);
  return await annotateScreenshotWithRefs({
    screenshotPath: params.screenshotPath,
    snapshot: overlaySnapshot,
  });
}

/** Each capture owner declares its backends; what stays here is the shape of the request. */
function assertSupportedScreenshotCaptureBackend(flags: DaemonRequest['flags']): void {
  const backend: unknown = flags?.screenshotCaptureBackend;
  if (backend === undefined) return;
  if (!(SCREENSHOT_CAPTURE_BACKENDS as readonly unknown[]).includes(backend)) {
    throw new AppError(
      'INVALID_ARGS',
      `--capture-backend takes ${SCREENSHOT_CAPTURE_BACKENDS.join(', ')}`,
    );
  }
  if (flags?.screenshotPixelDensity !== undefined || flags?.screenshotNormalizeStatusBar) {
    throw new AppError(
      'INVALID_ARGS',
      '--pixel-density and --normalize-status-bar cannot be combined with --capture-backend runner: they belong to the simctl capture',
    );
  }
}

/**
 * `screenshot [path]` and `--out <path>` are the same destination expressed two ways, and both are
 * user-typed paths resolved against the client's cwd. The normalized form is also what the session
 * action records, so a replay resolves the same file instead of re-expanding `~` somewhere else.
 */
function readScreenshotRequest(
  req: DaemonRequest,
  hostCwd: string,
): Readonly<{ outPath: string | undefined; recorded: RecordedGenericRequest }> {
  const positionals = req.positionals ?? [];
  const flags = req.flags ?? {};
  const expand = (value: string | undefined) =>
    value === undefined ? undefined : expandSessionPath(value, requestCwd(req, { cwd: hostCwd }));
  const positionalPath = expand(positionals[0]);
  const outFlag = expand(flags.out);
  return {
    outPath: positionalPath ?? outFlag,
    recorded: {
      positionals: positionalPath ? [positionalPath, ...positionals.slice(1)] : positionals,
      flags: outFlag ? { ...flags, out: outFlag } : flags,
    },
  };
}

function createBoundScreenshotBackend(
  params: Readonly<{
    session: SessionState;
    dispatchContext: DaemonCommandContext;
    captureScreenshot: BoundScreenshotRuntime['captureScreenshot'];
    crop?: ScreenshotCropBinding;
  }>,
): AgentDeviceBackend {
  const { session, dispatchContext, captureScreenshot, crop } = params;
  return {
    platform: publicPlatformString(session.device),
    captureScreenshot: async (_context, outPath, options) => {
      const resolved = screenshotOptionsFromFlags({
        ...dispatchContext,
        ...screenshotFlagsFromOptions(options),
      });
      const facts = await captureScreenshot({
        outPath,
        options: {
          appBundleId: dispatchContext.appBundleId,
          pixelDensity: resolved.pixelDensity,
          screenMask: resolved.screenMask,
          fullscreen: resolved.fullscreen,
          normalizeStatusBar: resolved.normalizeStatusBar,
          stabilize: resolved.stabilize,
          surface: options?.surface,
          // An open session already proved the simulator is booted, so the per-capture recheck is
          // the daemon's own knowledge rather than something the caller has to assert.
          skipIosSimulatorBootCheck:
            dispatchContext.skipIosSimulatorBootCheck ??
            (isIosFamily(session.device) && session.device.kind === 'simulator'),
          captureBackend: resolved.captureBackend,
          preferredCaptureBackend: dispatchContext.preferredScreenshotCaptureBackend,
        },
        execution: screenshotExecutionFromContext(dispatchContext),
      });
      if (crop) {
        assertScreenshotCropCapture(session.device, facts);
        const outcome = await cropScreenshotToSelector({
          device: session.device,
          session,
          surface: session.surface,
          cropOn: crop.cropOn,
          screenshotPath: outPath,
          logPath: crop.logPath,
          dispatchContext,
          captureSnapshot: crop.captureSnapshot,
        });
        crop.run.warnings.push(...buildScreenshotCropWarnings(outcome));
      }
      return facts.displayRotation ? { displayRotation: facts.displayRotation } : undefined;
    },
  };
}
