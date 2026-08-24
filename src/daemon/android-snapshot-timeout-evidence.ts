import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DaemonResponse, SessionState } from './types.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import {
  snapshotTimeoutCaptureFailed,
  snapshotTimeoutEvidenceOverlayCounts,
  snapshotTimeoutEvidenceOverlayFailed,
  snapshotTimeoutEvidenceWithOverlayRefs,
  snapshotTimeoutEvidenceWithoutOverlaySource,
  type SnapshotTimeoutEvidence,
} from '@agent-device/contracts/snapshot-timeout-evidence';
import { isAndroidSnapshotTimeoutError } from '../snapshot/snapshot-timeout-policy.ts';
import { contextFromFlags } from './context.ts';
import { annotateScreenshotWithRefs } from './screenshot-overlay.ts';
import { screenshotExecutionFromContext } from './screenshot-runtime.ts';
import {
  resolveBoundScreenshotRuntime,
  type ScreenshotRuntimeBindings,
} from './screenshot-runtime-binding.ts';

/**
 * Daemon assembly for the snapshot-timeout evidence path (#1983).
 *
 * The two things that are not daemon assembly moved out: whether a failure is the
 * accessibility-timeout shape is a policy
 * (`src/snapshot/snapshot-timeout-policy.ts`), and the published evidence shape is
 * vocabulary (`@agent-device/contracts/snapshot-timeout-evidence`, which has its own subpath so
 * it stays out of the shared capture facade's eager closure). What remains here is the ordering that
 * genuinely needs the daemon: resolving a bound screenshot runtime, writing the artifact,
 * annotating it from the stored observation, and emitting the diagnostics.
 */
export async function maybeBuildAndroidSnapshotTimeoutFailure(
  params: {
    error: unknown;
    command: 'snapshot' | 'diff';
    logPath: string;
    session: SessionState | undefined;
    device: SessionState['device'];
  } & ScreenshotRuntimeBindings,
): Promise<Extract<DaemonResponse, { ok: false }> | undefined> {
  if (params.command !== 'snapshot') return undefined;
  if (params.device.platform !== 'android') return undefined;

  const normalized = normalizeError(params.error);
  if (!isAndroidSnapshotTimeoutError(normalized)) return undefined;

  return {
    ok: false,
    error: {
      ...normalized,
      details: {
        ...(normalized.details ?? {}),
        androidSnapshotTimeoutScreenshot: await captureAndroidSnapshotTimeoutEvidence(params),
      },
    },
  };
}

async function captureAndroidSnapshotTimeoutEvidence(
  params: {
    logPath: string;
    session: SessionState | undefined;
    device: SessionState['device'];
  } & ScreenshotRuntimeBindings,
): Promise<SnapshotTimeoutEvidence> {
  try {
    const capture = await resolveBoundScreenshotRuntime({
      device: params.device,
      overlayRefs: false,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    });
    if (!capture.ok) {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'The target does not support screenshot capture, so no timeout evidence was taken.',
      );
    }
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'agent-device-android-snapshot-timeout-'),
    );
    const screenshotPath = path.join(tempDir, 'snapshot-timeout-overlay-refs.png');
    await capture.runtime.captureScreenshot({
      outPath: screenshotPath,
      options: {
        appBundleId: params.session?.appBundleId,
        // Capture unstabilized: inheriting the snapshot's stabilization could repeat the
        // accessibility timeout that this evidence path exists to escape.
        stabilize: false,
        surface: params.session?.surface,
      },
      execution: screenshotExecutionFromContext(
        contextFromFlags(
          params.logPath,
          { screenshotNoStabilize: true },
          params.session?.appBundleId,
          params.session?.trace?.outPath,
        ),
      ),
    });
    await fs.access(screenshotPath);
    const evidence = await annotateAndroidSnapshotTimeoutEvidence(screenshotPath, params.session);

    emitDiagnostic({
      level: 'warn',
      phase: 'android_snapshot_timeout_screenshot_captured',
      data: {
        path: screenshotPath,
        ...snapshotTimeoutEvidenceOverlayCounts(evidence),
      },
    });
    return evidence;
  } catch (error) {
    const normalized = normalizeError(error);
    emitDiagnostic({
      level: 'warn',
      phase: 'android_snapshot_timeout_screenshot_failed',
      data: { error: normalized.message },
    });
    return snapshotTimeoutCaptureFailed(normalized.message);
  }
}

async function annotateAndroidSnapshotTimeoutEvidence(
  screenshotPath: string,
  session: SessionState | undefined,
): Promise<SnapshotTimeoutEvidence> {
  if (!session?.snapshot) {
    return snapshotTimeoutEvidenceWithoutOverlaySource(screenshotPath);
  }

  try {
    const overlayRefs = await annotateScreenshotWithRefs({
      screenshotPath,
      snapshot: session.snapshot,
    });
    return snapshotTimeoutEvidenceWithOverlayRefs(screenshotPath, overlayRefs);
  } catch (error) {
    const normalized = normalizeError(error);
    emitDiagnostic({
      level: 'warn',
      phase: 'android_snapshot_timeout_screenshot_overlay_failed',
      data: { path: screenshotPath, error: normalized.message },
    });
    return snapshotTimeoutEvidenceOverlayFailed(screenshotPath, normalized.message);
  }
}
