import type { CommandFlags } from '@agent-device/contracts/command';
import {
  SCREENSHOT_CROP_REASONS,
  type ScreenshotCropReason,
} from '@agent-device/contracts/capture';
import type { SessionSurface } from '@agent-device/contracts/session';
import {
  publicPlatformString,
  resolveDeviceAppleOs,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { readPngSize } from '@agent-device/capture-kit/png-size';
import { cropPngFile } from '@agent-device/capture-kit/png-crop';
import {
  intersectScreenshotRect,
  projectSnapshotRectToScreenshot,
  resolveScreenshotRectSpace,
  resolveSnapshotBounds,
} from '@agent-device/capture-kit/snapshot-rect-projection';
import { validateSelectorExpression } from '@agent-device/selectors';
import { buildSnapshotState } from '../core/snapshot-state.ts';
import { SELECTOR_PIPELINE_POLICIES } from '../core/selector-pipeline-policy.ts';
import { resolveSelectorPipeline } from '../core/selector-pipeline.ts';
import type { DaemonCommandContext } from './context.ts';
import { captureSnapshotData } from './snapshot-capture.ts';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';
import type { BoundScreenshotRuntime } from './screenshot-runtime-binding.ts';
import type { SessionState } from './types.ts';

/**
 * The daemon leaf that owns `screenshot --crop-on`: the target acceptance matrix, the
 * pre-device-work argument policy, and the crop orchestration that runs after the platform
 * write and before scale. The crop snapshot is request-scoped — it never becomes the session
 * snapshot, so the authorized ref frame a following interaction resolves is untouched.
 */

type CropTarget =
  | 'ios-simulator'
  | 'android-emulator'
  | 'android-device'
  | 'macos-app-window'
  | 'ios-physical'
  | 'macos-helper'
  | 'web'
  | 'linux'
  | 'tvos'
  | 'harmonyos'
  | 'vega';

type CropTargetCell =
  | Readonly<{ target: CropTarget; status: 'accepted' }>
  | Readonly<{
      target: CropTarget;
      status: 'rejected';
      rejectionReason: ScreenshotCropReason;
    }>;

/**
 * The machine-readable support policy. A cell is accepted only once the live pixel-identity
 * cross-check against an independent capture has been collected; until then the target is
 * rejected with the pending-evidence reason, and the evidence itself lives in the completeness
 * gate, the geometry fixtures, and the PR history — never in this table.
 */
export const SCREENSHOT_CROP_TARGET_CELLS: readonly CropTargetCell[] = [
  { target: 'ios-simulator', status: 'accepted' },
  { target: 'android-emulator', status: 'accepted' },
  {
    target: 'android-device',
    status: 'rejected',
    rejectionReason: SCREENSHOT_CROP_REASONS.pendingPixelIdentityEvidence,
  },
  {
    target: 'macos-app-window',
    status: 'rejected',
    rejectionReason: SCREENSHOT_CROP_REASONS.pendingPixelIdentityEvidence,
  },
  {
    target: 'ios-physical',
    status: 'rejected',
    rejectionReason: SCREENSHOT_CROP_REASONS.pendingPixelIdentityEvidence,
  },
  {
    target: 'macos-helper',
    status: 'rejected',
    rejectionReason: SCREENSHOT_CROP_REASONS.pendingPixelIdentityEvidence,
  },
  {
    target: 'web',
    status: 'rejected',
    rejectionReason: SCREENSHOT_CROP_REASONS.pendingPixelIdentityEvidence,
  },
  {
    target: 'linux',
    status: 'rejected',
    rejectionReason: SCREENSHOT_CROP_REASONS.pendingPixelIdentityEvidence,
  },
  {
    target: 'tvos',
    status: 'rejected',
    rejectionReason: SCREENSHOT_CROP_REASONS.pendingPixelIdentityEvidence,
  },
  {
    target: 'harmonyos',
    status: 'rejected',
    rejectionReason: SCREENSHOT_CROP_REASONS.pendingPixelIdentityEvidence,
  },
  {
    target: 'vega',
    status: 'rejected',
    rejectionReason: SCREENSHOT_CROP_REASONS.pendingPixelIdentityEvidence,
  },
];

/** The one target cell a device's capture frame falls into. */
export function classifyScreenshotCropTarget(
  device: DeviceInfo,
  surface: SessionSurface | undefined,
): CropTarget {
  switch (device.platform) {
    case 'apple':
      return classifyAppleCropTarget(device, surface);
    case 'android':
      return device.kind === 'device' ? 'android-device' : 'android-emulator';
    case 'harmonyos':
      return 'harmonyos';
    case 'vega':
      return 'vega';
    case 'linux':
      return 'linux';
    case 'web':
      return 'web';
  }
}

function classifyAppleCropTarget(
  device: DeviceInfo,
  surface: SessionSurface | undefined,
): CropTarget {
  const appleOs = resolveDeviceAppleOs(device);
  switch (appleOs) {
    case 'ios':
    case 'ipados':
      return device.kind === 'device' ? 'ios-physical' : 'ios-simulator';
    case 'tvos':
      return 'tvos';
    case 'macos':
      return classifyMacOsCropTarget(surface);
    case 'watchos':
    case 'visionos':
      // Stored records carry the reserved OSes although discovery never populates them; a
      // session device on one has no acceptance cell to fall into, so it is a typed refusal,
      // not a guess.
      throw cropRefusal(appleOs);
  }
}

function classifyMacOsCropTarget(surface: SessionSurface | undefined): CropTarget {
  return surface === 'app' || surface === 'frontmost-app' ? 'macos-app-window' : 'macos-helper';
}

function cropRefusal(target: string): AppError {
  return new AppError(
    'UNSUPPORTED_OPERATION',
    `screenshot --crop-on is not accepted on ${target} targets`,
    {
      reason: SCREENSHOT_CROP_REASONS.targetNotAccepted,
    },
  );
}

/**
 * The crop argument policy, answered before any device work: combination refusals, the
 * selector expression, and the acceptance matrix.
 */
export function assertScreenshotCropPolicy(params: {
  device: DeviceInfo;
  surface: SessionSurface | undefined;
  cropOn: string;
  overlayRefs: boolean;
  fullscreen: boolean;
}): void {
  if (params.overlayRefs || params.fullscreen) {
    throw new AppError(
      'INVALID_ARGS',
      '--crop-on cannot be combined with --overlay-refs or --fullscreen: both move the captured frame away from the snapshot viewport the crop is measured against',
      { reason: SCREENSHOT_CROP_REASONS.frameMismatch },
    );
  }
  try {
    validateSelectorExpression(params.cropOn);
  } catch {
    throw new AppError(
      'INVALID_ARGS',
      'screenshot --crop-on requires a valid selector expression',
      {
        reason: SCREENSHOT_CROP_REASONS.selectorInvalid,
      },
    );
  }
  const cell = SCREENSHOT_CROP_TARGET_CELLS.find(
    (candidate) => candidate.target === classifyScreenshotCropTarget(params.device, params.surface),
  );
  if (!cell || cell.status === 'rejected') {
    const target = classifyScreenshotCropTarget(params.device, params.surface);
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `screenshot --crop-on is not accepted on ${target} targets`,
      {
        reason: SCREENSHOT_CROP_REASONS.targetNotAccepted,
        rejectionReason: cell?.status === 'rejected' ? cell.rejectionReason : undefined,
      },
    );
  }
}

export type ScreenshotCropOutcome = Readonly<{
  cropped: true;
  partialIntersection: boolean;
}>;

const CROP_PARTIAL_INTERSECTION_WARNING = `${SCREENSHOT_CROP_REASONS.partialIntersection}: the selector frame extends past the captured image; the crop was clipped to the image frame`;

/** The single warning-composition owner: append-only, typed reason, stable text. */
export function buildScreenshotCropWarnings(outcome: ScreenshotCropOutcome | undefined): string[] {
  return outcome?.partialIntersection ? [CROP_PARTIAL_INTERSECTION_WARNING] : [];
}

/**
 * Crops `screenshotPath` to the frame of the selector resolved against a fresh full-tree
 * snapshot taken on the same screen, through the same admitted binding as the capture.
 */
export async function cropScreenshotToSelector(params: {
  device: DeviceInfo;
  session: SessionState;
  surface: SessionSurface | undefined;
  cropOn: string;
  screenshotPath: string;
  logPath: string;
  dispatchContext: DaemonCommandContext;
  captureSnapshot: NonNullable<BoundScreenshotRuntime['captureSnapshot']>;
}): Promise<ScreenshotCropOutcome> {
  const { device, session, surface, cropOn, screenshotPath, logPath, dispatchContext } = params;
  const cropSnapshotFlags = { snapshotInteractiveOnly: false } satisfies CommandFlags;
  const snapshotData = await captureSnapshotData({
    device,
    session,
    flags: cropSnapshotFlags,
    logPath,
    snapshotScope: undefined,
    captureData: async () =>
      await params.captureSnapshot({
        options: {
          appBundleId: dispatchContext.appBundleId,
          interactiveOnly: false,
          includeRects: true,
          surface,
        },
        execution: runtimeExecutionFromContext(dispatchContext),
      }),
  });
  const snapshot = buildSnapshotState(snapshotData, cropSnapshotFlags);

  if (snapshot.snapshotQuality?.state === 'sparse') {
    throw new AppError(
      'COMMAND_FAILED',
      'the snapshot taken for --crop-on was sparse and cannot be read as the screen',
      { reason: SCREENSHOT_CROP_REASONS.captureUnreadable },
    );
  }

  const outcome = await resolveSelectorPipeline(
    SELECTOR_PIPELINE_POLICIES.cropTarget,
    snapshot.nodes,
    cropOn,
    { platform: publicPlatformString(device) },
  );
  if (outcome.kind === 'ambiguous') {
    const candidates = outcome.matchedNodes.map((node) => node.label ?? node.ref);
    throw new AppError(
      'COMMAND_FAILED',
      `--crop-on matched ${outcome.matchedNodes.length} nodes and must resolve to one`,
      {
        reason: SCREENSHOT_CROP_REASONS.targetAmbiguous,
        candidates,
        matches: outcome.matchedNodes.length,
      },
    );
  }
  if (outcome.kind === 'none') {
    if (snapshot.truncated) {
      throw new AppError(
        'COMMAND_FAILED',
        'the snapshot taken for --crop-on was truncated, so a missing match is not proven',
        { reason: SCREENSHOT_CROP_REASONS.captureIncomplete },
      );
    }
    throw new AppError('COMMAND_FAILED', `--crop-on matched no node: ${cropOn}`, {
      reason: SCREENSHOT_CROP_REASONS.targetNotFound,
      hint: `find ${cropOn} list`,
    });
  }
  const node = outcome.node;
  const image = await readPngSize(screenshotPath);
  const space = resolveScreenshotRectSpace(snapshot.backend);
  const projected = projectSnapshotRectToScreenshot(
    space,
    resolveSnapshotBounds(snapshot.nodes),
    node.rect!,
    image.width,
    image.height,
  );
  const box = intersectScreenshotRect(projected, image.width, image.height);
  if (box === null) {
    throw new AppError(
      'COMMAND_FAILED',
      `the frame resolved by --crop-on occupies no pixel of the capture`,
      { reason: SCREENSHOT_CROP_REASONS.emptyIntersection },
    );
  }
  const partialIntersection =
    box.x !== projected.x ||
    box.y !== projected.y ||
    box.width < projected.width ||
    box.height < projected.height;
  await cropPngFile(screenshotPath, box);
  return { cropped: true, partialIntersection };
}
