import type { CommandFlags } from '@agent-device/contracts/command';
import { SCREENSHOT_CROP_REASONS } from '@agent-device/contracts/capture';
import type { SessionSurface } from '@agent-device/contracts/session';
import { publicPlatformString, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { readPngSize } from '@agent-device/capture-kit/png-size';
import { cropPngFile } from '@agent-device/capture-kit/png-crop';
import {
  intersectScreenshotRect,
  projectSnapshotRectToScreenshot,
  resolveScreenshotRectSpace,
  resolveSnapshotBounds,
} from '@agent-device/capture-kit/snapshot-rect-projection';
import { buildSnapshotState } from '../core/snapshot-state.ts';
import { SELECTOR_PIPELINE_POLICIES } from '../core/selector-pipeline-policy.ts';
import { resolveSelectorPipeline } from '../core/selector-pipeline.ts';
import type { DaemonCommandContext } from './context.ts';
import { captureSnapshotData } from './snapshot-capture.ts';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';
import type { BoundScreenshotRuntime } from './screenshot-runtime-binding.ts';
import type { SessionState } from './types.ts';

export type ScreenshotCropOutcome = Readonly<{ partialIntersection: boolean }>;

const CROP_PARTIAL_INTERSECTION_WARNING = `${SCREENSHOT_CROP_REASONS.partialIntersection}: the selector frame extends past the captured image; the crop was clipped to the image frame`;

/** The single warning-composition owner: append-only, typed reason, stable text. */
export function buildScreenshotCropWarnings(outcome: ScreenshotCropOutcome | undefined): string[] {
  return outcome?.partialIntersection ? [CROP_PARTIAL_INTERSECTION_WARNING] : [];
}

/**
 * Crops `screenshotPath` to the frame of the selector resolved against a fresh full-tree
 * snapshot taken on the same screen, through the same admitted binding as the capture. The crop
 * snapshot is request-scoped — it never becomes the session snapshot.
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
  const flags = { snapshotInteractiveOnly: false } satisfies CommandFlags;
  const snapshotData = await captureSnapshotData({
    device,
    session,
    flags,
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
  const snapshot = buildSnapshotState(snapshotData, flags);

  if (snapshot.snapshotQuality?.state === 'sparse') {
    throw new AppError(
      'COMMAND_FAILED',
      'the snapshot taken for --crop-on was sparse and cannot be read as the screen',
      { reason: SCREENSHOT_CROP_REASONS.captureUnreadable },
    );
  }

  const node = await resolveCropTargetNode(snapshot.nodes, cropOn, snapshot.truncated, device);
  const image = await readPngSize(screenshotPath);
  const projected = projectSnapshotRectToScreenshot(
    resolveScreenshotRectSpace(snapshot.backend),
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
  return { partialIntersection };
}

/** Resolve the selector to exactly one framed node, or fail with a typed crop reason. */
async function resolveCropTargetNode(
  nodes: SnapshotNode[],
  cropOn: string,
  truncated: boolean | undefined,
  device: DeviceInfo,
) {
  const outcome = await resolveSelectorPipeline(
    SELECTOR_PIPELINE_POLICIES.cropTarget,
    nodes,
    cropOn,
    { platform: publicPlatformString(device) },
  );
  if (outcome.kind === 'ambiguous') {
    throw new AppError(
      'COMMAND_FAILED',
      `--crop-on matched ${outcome.matchedNodes.length} nodes and must resolve to one`,
      {
        reason: SCREENSHOT_CROP_REASONS.targetAmbiguous,
        candidates: outcome.matchedNodes.map((node) => node.label ?? node.ref),
        matches: outcome.matchedNodes.length,
      },
    );
  }
  if (outcome.kind === 'none') {
    if (truncated) {
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
  return outcome.node;
}
