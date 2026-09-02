import type { CommandFlags } from '@agent-device/contracts/command';
import {
  retiredScreenshotMaxSizeFlagError,
  screenshotFlagsFromOptions,
  screenshotOptionsFromFlags,
} from '@agent-device/contracts/capture';
import type { ScreenshotRuntimeExecution } from '@agent-device/contracts/screenshot-runtime';
import { isIosFamily, publicPlatformString } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { ScreenshotOverlayRef } from '@agent-device/kernel/snapshot';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentDeviceBackend } from '../backend.ts';
import type { ArtifactAdapter } from '../io.ts';
import { createAgentDevice, localCommandPolicy } from '../runtime.ts';
import {
  assertSupportedScreenshotPixelDensity,
  readScreenshotResultMetadata,
} from '@agent-device/capture-kit/screenshot-density';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';
import type { DaemonCommandContext } from './context.ts';
import { captureSnapshotData } from './snapshot-capture.ts';
import { buildSnapshotState } from '../core/snapshot-state.ts';
import type {
  RecordedGenericRequest,
  ResolvedGenericExecution,
} from './request-generic-dispatch.ts';
import { createDaemonRuntimeSessionStore } from './runtime-session.ts';
import { annotateScreenshotWithRefs } from './screenshot-overlay.ts';
import {
  resolveBoundScreenshotRuntime,
  type BoundScreenshotRuntime,
  type ScreenshotRuntimeBindings,
} from './screenshot-runtime-binding.ts';
import { setSessionSnapshot } from './session-snapshot.ts';
import { SessionStore } from './session-store.ts';
import type { DaemonRequest, SessionState } from './types.ts';

/**
 * The `screenshot` leaf of the generic route. Argument policy is answered before any device work,
 * then one plan is admitted and bound once; the returned closure is what the generic dispatcher
 * runs in place of legacy platform dispatch.
 */
export async function resolveScreenshotGenericExecution(
  params: Readonly<{
    req: DaemonRequest;
    session: SessionState;
  }> &
    ScreenshotRuntimeBindings,
): Promise<ResolvedGenericExecution> {
  const { req, session } = params;
  const retiredMaxSize = retiredScreenshotMaxSizeFlagError('screenshot', req.flags);
  if (retiredMaxSize) throw new AppError('INVALID_ARGS', retiredMaxSize);
  assertSupportedScreenshotPixelDensity(session.device, req.flags?.screenshotPixelDensity);

  const request = readScreenshotRequest(req);
  const resolved = await resolveBoundScreenshotRuntime({
    device: session.device,
    overlayRefs: req.flags?.overlayRefs === true,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
  });
  if (!resolved.ok) return resolved;

  const runtime = resolved.runtime;
  return {
    ok: true,
    recorded: request.recorded,
    execute: async (execution) =>
      await executeScreenshot({
        session: execution.session,
        sessionName: execution.sessionName,
        logPath: execution.logPath,
        dispatchContext: execution.dispatchContext,
        flags: execution.request.flags,
        outPath: request.outPath,
        runtime,
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
    session: SessionState;
    sessionName: string;
    outPath?: string;
    dispatchContext: DaemonCommandContext;
    captureScreenshot: BoundScreenshotRuntime['captureScreenshot'];
  }>,
): Promise<CapturedScreenshot> {
  const { session, sessionName, outPath, dispatchContext } = params;
  const runtime = createAgentDevice({
    backend: createBoundScreenshotBackend(params),
    artifacts: createDaemonScreenshotArtifactAdapter(),
    sessions: createDaemonRuntimeSessionStore({
      sessionName,
      getSession: () => session,
      recordOptions: { includeSnapshot: false },
      setRecord: () => {},
    }),
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
 * publisher emits no descriptors, so the destination and its message are the whole result.
 */
type CapturedScreenshot = Readonly<{ path: string; message?: string }>;

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
    session: SessionState;
    sessionName: string;
    logPath: string;
    dispatchContext: DaemonCommandContext;
    flags: CommandFlags | undefined;
    outPath: string | undefined;
    runtime: BoundScreenshotRuntime;
  }>,
): Promise<Record<string, unknown>> {
  const { session, runtime, flags } = params;
  const captured = await captureScreenshotArtifact({
    session,
    sessionName: params.sessionName,
    outPath: params.outPath,
    dispatchContext: params.dispatchContext,
    captureScreenshot: runtime.captureScreenshot,
  });
  const captureSnapshot = runtime.captureSnapshot;
  return {
    ...captured,
    ...(captureSnapshot
      ? {
          overlayRefs: await annotateScreenshotWithSessionRefs({
            session,
            logPath: params.logPath,
            screenshotPath: captured.path,
            dispatchContext: params.dispatchContext,
            captureSnapshot,
          }),
        }
      : {}),
    ...(await readScreenshotResultMetadata({
      device: session.device,
      path: captured.path,
      requestedPixelDensity: flags?.screenshotPixelDensity,
      scale: flags?.screenshotScale,
    })),
  };
}

/**
 * `--overlay-refs` republishes the annotated tree as the session's snapshot, so the refs it drew
 * are the refs a following interaction resolves. The tree comes from the same admitted binding as
 * the capture — the plan required both operations before either ran.
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

/**
 * `screenshot [path]` and `--out <path>` are the same destination expressed two ways, and both are
 * user-typed paths resolved against the client's cwd. The normalized form is also what the session
 * action records, so a replay resolves the same file instead of re-expanding `~` somewhere else.
 */
function readScreenshotRequest(
  req: DaemonRequest,
): Readonly<{ outPath: string | undefined; recorded: RecordedGenericRequest }> {
  const positionals = req.positionals ?? [];
  const flags = req.flags ?? {};
  const expand = (value: string | undefined) =>
    value === undefined ? undefined : SessionStore.expandHome(value, req.meta?.cwd);
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
  }>,
): AgentDeviceBackend {
  const { session, dispatchContext, captureScreenshot } = params;
  return {
    platform: publicPlatformString(session.device),
    captureScreenshot: async (_context, outPath, options) => {
      const resolved = screenshotOptionsFromFlags({
        ...dispatchContext,
        ...screenshotFlagsFromOptions(options),
      });
      await captureScreenshot({
        outPath,
        options: {
          appBundleId: dispatchContext.appBundleId,
          pixelDensity: resolved.pixelDensity,
          fullscreen: resolved.fullscreen,
          normalizeStatusBar: resolved.normalizeStatusBar,
          stabilize: resolved.stabilize,
          surface: options?.surface,
          // An open session already proved the simulator is booted, so the per-capture recheck is
          // the daemon's own knowledge rather than something the caller has to assert.
          skipIosSimulatorBootCheck:
            dispatchContext.skipIosSimulatorBootCheck ??
            (isIosFamily(session.device) && session.device.kind === 'simulator'),
          captureBackend: dispatchContext.screenshotCaptureBackend,
        },
        execution: screenshotExecutionFromContext(dispatchContext),
      });
    },
  };
}

function createDaemonScreenshotArtifactAdapter(): ArtifactAdapter {
  return {
    resolveInput: async () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'screenshot does not resolve input artifacts');
    },
    reserveOutput: async (ref) => {
      let tempRoot: string | undefined;
      let outputPath: string;
      if (ref?.kind === 'path') {
        outputPath = ref.path;
      } else {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-screenshot-'));
        outputPath = path.join(tempRoot, 'screenshot.png');
      }
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      return {
        path: outputPath,
        visibility: 'client-visible',
        publish: async () => undefined,
        ...(tempRoot
          ? {
              cleanup: async () => {
                await fs.rm(tempRoot, { recursive: true, force: true });
              },
            }
          : {}),
      };
    },
    createTempFile: async (options) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `${options.prefix}-`));
      return {
        path: path.join(root, `file${options.ext}`),
        visibility: 'internal',
        cleanup: async () => {
          await fs.rm(root, { recursive: true, force: true });
        },
      };
    },
  };
}
