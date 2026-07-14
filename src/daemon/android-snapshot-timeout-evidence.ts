import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DaemonResponse, SessionState } from './types.ts';
import { dispatchCommand } from '../core/dispatch.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import { normalizeError, type NormalizedError } from '../kernel/errors.ts';
import type { ScreenshotOverlayRef } from '../kernel/snapshot.ts';
import { contextFromFlags } from './context.ts';
import { annotateScreenshotWithRefs } from './screenshot-overlay.ts';

type CapturedAndroidSnapshotTimeoutEvidenceBase = {
  path: string;
  overlayRefsRequested: true;
};

type AndroidSnapshotTimeoutEvidence =
  | {
      captureFailed: true;
      error: string;
    }
  | (CapturedAndroidSnapshotTimeoutEvidenceBase & {
      overlayRefSource: 'unavailable';
      overlayRefsAnnotated: false;
      overlayRefCount: 0;
    })
  | (CapturedAndroidSnapshotTimeoutEvidenceBase & {
      overlayRefSource: 'session-snapshot';
      overlayRefsAnnotated: boolean;
      overlayRefCount: number;
      overlayRefs: ScreenshotOverlayRef[];
    })
  | (CapturedAndroidSnapshotTimeoutEvidenceBase & {
      overlayRefSource: 'session-snapshot';
      overlayRefsAnnotated: false;
      overlayRefCount: 0;
      overlayAnnotationError: string;
    });

export async function maybeBuildAndroidSnapshotTimeoutFailure(params: {
  error: unknown;
  command: 'snapshot' | 'diff';
  logPath: string;
  session: SessionState | undefined;
  device: SessionState['device'];
}): Promise<Extract<DaemonResponse, { ok: false }> | undefined> {
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

async function captureAndroidSnapshotTimeoutEvidence(params: {
  logPath: string;
  session: SessionState | undefined;
  device: SessionState['device'];
}): Promise<AndroidSnapshotTimeoutEvidence> {
  try {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'agent-device-android-snapshot-timeout-'),
    );
    const screenshotPath = path.join(tempDir, 'snapshot-timeout-overlay-refs.png');
    const data = await dispatchCommand(params.device, 'screenshot', [screenshotPath], undefined, {
      ...contextFromFlags(
        params.logPath,
        // Use a fresh unstabilized screenshot context; inheriting snapshot flags could repeat the
        // accessibility stabilization timeout that this fallback is trying to avoid.
        { screenshotNoStabilize: true },
        params.session?.appBundleId,
        params.session?.trace?.outPath,
      ),
      surface: params.session?.surface,
    });
    const resolvedPath = resolveCapturedScreenshotPath(data, screenshotPath);
    await fs.access(resolvedPath);
    const evidence = await annotateAndroidSnapshotTimeoutEvidence(resolvedPath, params.session);

    emitDiagnostic({
      level: 'warn',
      phase: 'android_snapshot_timeout_screenshot_captured',
      data: {
        path: resolvedPath,
        overlayRefCount: 'overlayRefCount' in evidence ? evidence.overlayRefCount : undefined,
        overlayRefsAnnotated:
          'overlayRefsAnnotated' in evidence ? evidence.overlayRefsAnnotated : undefined,
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
    return {
      captureFailed: true,
      error: normalized.message,
    };
  }
}

async function annotateAndroidSnapshotTimeoutEvidence(
  screenshotPath: string,
  session: SessionState | undefined,
): Promise<AndroidSnapshotTimeoutEvidence> {
  if (!session?.snapshot) {
    return {
      path: screenshotPath,
      overlayRefsRequested: true,
      overlayRefsAnnotated: false,
      overlayRefSource: 'unavailable',
      overlayRefCount: 0,
    };
  }

  try {
    const overlayRefs = await annotateScreenshotWithRefs({
      screenshotPath,
      snapshot: session.snapshot,
    });
    return {
      path: screenshotPath,
      overlayRefsRequested: true,
      overlayRefsAnnotated: overlayRefs.length > 0,
      overlayRefCount: overlayRefs.length,
      overlayRefSource: 'session-snapshot',
      overlayRefs,
    };
  } catch (error) {
    const normalized = normalizeError(error);
    emitDiagnostic({
      level: 'warn',
      phase: 'android_snapshot_timeout_screenshot_overlay_failed',
      data: { path: screenshotPath, error: normalized.message },
    });
    return {
      path: screenshotPath,
      overlayRefsRequested: true,
      overlayRefsAnnotated: false,
      overlayRefSource: 'session-snapshot',
      overlayRefCount: 0,
      overlayAnnotationError: normalized.message,
    };
  }
}

function resolveCapturedScreenshotPath(data: unknown, fallbackPath: string): string {
  return hasStringPath(data) ? data.path : fallbackPath;
}

function hasStringPath(value: unknown): value is { path: string } {
  return (
    typeof value === 'object' && value !== null && 'path' in value && typeof value.path === 'string'
  );
}

function isAndroidSnapshotTimeoutError(error: NormalizedError): boolean {
  if (error.code !== 'COMMAND_FAILED') return false;
  return (
    hasKnownAndroidSnapshotTimeoutMessage(error) || hasHelperTimeoutDetails(error.details?.helper)
  );
}

function hasKnownAndroidSnapshotTimeoutMessage(error: NormalizedError): boolean {
  const text = `${error.message}\n${error.hint ?? ''}`;
  return /Android accessibility snapshots can be blocked/i.test(text);
}

function hasHelperTimeoutDetails(helper: unknown): boolean {
  if (!helper || typeof helper !== 'object') return false;
  const helperRecord = helper as Record<string, unknown>;
  const errorType = String(helperRecord.errorType ?? '');
  const message = String(helperRecord.message ?? '');
  return /TimeoutException/i.test(errorType) || /timed out/i.test(message);
}
