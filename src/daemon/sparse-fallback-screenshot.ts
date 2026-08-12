import type { SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';
import { isSparseSnapshotQualityVerdict } from '../snapshot-quality/verdict.ts';
import { contextFromFlags } from './context.ts';
import { dispatchScreenshotViaRuntime } from './screenshot-runtime.ts';
import type { DaemonRequest, SessionState } from './types.ts';

export type SparseFallbackScreenshot = {
  path: string;
  artifact: {
    field: 'fallbackScreenshotPath';
    artifactType: 'screenshot';
    path: string;
    fileName: string;
  };
};

/**
 * A sparse verdict means no backend could read the tree while the screen itself still
 * renders, so the remedy the verdict already prints — use a screenshot as visual truth —
 * is the caller's guaranteed next command. Taking the shot here spends it once, on the
 * one path where it is never speculative, instead of charging the caller a second round
 * trip to obey advice we authored.
 *
 * Deliberately hung off the user-facing `snapshot` dispatch, and skipped for internal
 * observations: selector resolution, settle, and wait polling capture through
 * `captureSnapshot` directly rather than through this runtime command, so a wait polling
 * an unreadable screen cannot turn into a screenshot per poll.
 */
export async function captureSparseFallbackScreenshot(params: {
  req: DaemonRequest;
  session: SessionState | undefined;
  sessionName: string;
  logPath: string;
  verdict: SnapshotQualityVerdict | undefined;
}): Promise<SparseFallbackScreenshot | undefined> {
  const session = params.session;
  if (!session) return undefined;
  if (!isSparseSnapshotQualityVerdict(params.verdict)) return undefined;
  if (params.req.internal?.observationOnly === true) return undefined;

  const path = await captureFallbackScreenshotPath({ ...params, session });
  if (path === undefined) return undefined;
  return {
    path,
    artifact: {
      field: 'fallbackScreenshotPath',
      artifactType: 'screenshot',
      path,
      fileName: 'snapshot-fallback.png',
    },
  };
}

async function captureFallbackScreenshotPath(params: {
  req: DaemonRequest;
  session: SessionState;
  sessionName: string;
  logPath: string;
}): Promise<string | undefined> {
  const { req, session } = params;
  try {
    const data = await dispatchScreenshotViaRuntime({
      session,
      sessionName: params.sessionName,
      // No caller-supplied destination: the screenshot artifact adapter mints a temp
      // path, so the fallback never writes where an explicit `--out` would have.
      outputPlacement: 'default',
      dispatchContext: contextFromFlags(
        params.logPath,
        // The request's own flags carry the toolchain selection (xctestrun file,
        // derived data, verbosity) this dispatch needs; snapshot-shaped flags are
        // inert for a screenshot.
        req.flags,
        session.appBundleId,
        session.trace?.outPath,
        req.meta?.requestId,
        req.meta,
      ),
    });
    return typeof data.path === 'string' ? data.path : undefined;
  } catch {
    // A convenience on an already-degraded path. The sparse verdict's own warning still
    // carries the manual remedy, so a failed fallback must not fail the snapshot the
    // caller actually asked for.
    return undefined;
  }
}
