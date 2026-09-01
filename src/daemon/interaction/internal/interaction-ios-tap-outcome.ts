import type { CommandFlags } from '@agent-device/contracts/command';
import type { InteractionTarget } from '@agent-device/contracts/interaction';
import type { SnapshotQualityVerdict, SnapshotState } from '@agent-device/kernel/snapshot';
import { asAppError } from '@agent-device/kernel/errors';
import {
  isSparseSnapshotQualityVerdict,
  preferredSnapshotBackendForVerdict,
} from '@agent-device/capture-kit/snapshot-quality-verdict';
import { summarizeAxEvidence } from '../../../snapshot/snapshot-evidence.ts';
import { getRequestSignal } from '@agent-device/host-kit/request';
import { isLocalIosRunnerSession } from '../../direct-ios-selector.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { SessionStore } from '../../session-store.ts';
import type { SessionState } from '../../types.ts';
import type { BoundContextFromFlags, CaptureSnapshotForSession } from './types.ts';

const XCTEST_RECORDED_FAILURE = 'XCTEST_RECORDED_FAILURE';
// A model commonly needs 5-10s to choose a target after receiving a snapshot.
// Keep the window bounded, but long enough for that ordinary decision turn;
// the same-backend/same-presentation checks below still fail closed.
const IOS_TAP_CORROBORATION_BASELINE_MAX_AGE_MS = 15_000;

const IOS_TAP_CORROBORATION_WARNING =
  'XCTest reported the tap as failed, but a same-scope post-action accessibility capture changed; treating the tap as landed. Observe the current screen before issuing another tap.';

type SnapshotPresentation = {
  interactiveOnly: boolean;
  depth?: number;
  scope?: string;
  raw: boolean;
};

export type IosTapCorroborationParams = {
  error: unknown;
  command: string;
  requestId: string | undefined;
  flags: CommandFlags | undefined;
  session: SessionState;
  sessionStore: SessionStore;
  contextFromFlags: BoundContextFromFlags;
  captureSnapshotForSession: CaptureSnapshotForSession;
};

export type IosTapCorroboration = {
  warning: string;
};

/**
 * A recorded XCTest failure is ambiguous for a tap: the runner can report the
 * XCTest bookkeeping failure after the coordinate activation already reached
 * the app. This helper spends exactly one matching capture to distinguish a
 * changed surface from an unchanged/unknown outcome. Unknown stays failure.
 */
export async function corroborateIosTapFailure(
  params: IosTapCorroborationParams,
): Promise<IosTapCorroboration | undefined> {
  if (!canCorroborateIosTapFailure(params)) return undefined;
  const baseline = readCorroborationBaseline(params.session.snapshot);
  if (!baseline) return undefined;

  const after = await captureCorroborationSnapshot(
    params,
    baseline.snapshot.snapshotQuality,
    baseline.presentation,
  );
  if (!after || !hasMatchingPresentation(baseline.snapshot, after, params.command)) {
    return undefined;
  }
  return compareCorroborationEvidence(baseline.snapshot, after, params.command);
}

function canCorroborateIosTapFailure(params: IosTapCorroborationParams): boolean {
  return (
    isTapCommand(params.command) &&
    asAppError(params.error).code === XCTEST_RECORDED_FAILURE &&
    isLocalIosRunnerSession(params.session, { skipPendingPostGestureStabilization: false })
  );
}

function isTapCommand(command: string): boolean {
  return command === 'click' || command === 'press';
}

function readCorroborationBaseline(
  snapshot: SnapshotState | undefined,
): { snapshot: SnapshotState; presentation: SnapshotPresentation } | undefined {
  if (!hasUsableBaseline(snapshot)) return undefined;
  const ageMs = Date.now() - snapshot.createdAt;
  if (ageMs < 0 || ageMs > IOS_TAP_CORROBORATION_BASELINE_MAX_AGE_MS) {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_tap_failure_corroboration_stale_baseline',
      data: { ageMs },
    });
    return undefined;
  }
  const presentation = readSnapshotPresentation(snapshot.presentationKey);
  if (!presentation) return undefined;
  // Raw baselines are excluded from corroboration entirely: the probe would
  // replay `raw: true`, and the raw diagnostic plan keeps tree-first error
  // propagation by contract — it is never rerouted by the penalty or by a
  // preferred backend, so a raw private-AX baseline could not be matched
  // same-backend and would recreate the mismatch false failure. Raw captures
  // are diagnostics, not evidence baselines.
  if (presentation.raw) {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_tap_failure_corroboration_raw_baseline',
      data: { presentationKey: snapshot.presentationKey },
    });
    return undefined;
  }
  return { snapshot, presentation };
}

async function captureCorroborationSnapshot(
  params: IosTapCorroborationParams,
  baselineVerdict: SnapshotQualityVerdict | undefined,
  presentation: SnapshotPresentation | undefined,
): Promise<SnapshotState | undefined> {
  try {
    const preferredBackend = preferredSnapshotBackendForVerdict(baselineVerdict);
    return await params.captureSnapshotForSession(
      params.session,
      matchingCaptureFlags(params.flags, presentation),
      params.sessionStore,
      params.contextFromFlags,
      {
        interactiveOnly: presentation?.interactiveOnly ?? true,
        // Evidence comparison is only valid same-backend, and the recorded-failure
        // screens are exactly where the capture plan flips between XCTest and
        // private-AX (the penalty boundary) — pin the probe to the baseline's
        // backend instead of failing closed on the mismatch.
        ...(preferredBackend ? { preferredBackend } : {}),
        signal: getRequestSignal(params.requestId),
      },
    );
  } catch (captureError) {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_tap_failure_corroboration_capture_failed',
      data: {
        command: params.command,
        error: captureError instanceof Error ? captureError.message : String(captureError),
      },
    });
    return undefined;
  }
}

function hasMatchingPresentation(
  baseline: SnapshotState,
  after: SnapshotState,
  command: string,
): boolean {
  const baselineBackend = baseline.snapshotQuality?.backend;
  const afterBackend = after.snapshotQuality?.backend;
  if (!baselineBackend || baselineBackend !== afterBackend) {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_tap_failure_corroboration_backend_mismatch',
      data: {
        command,
        baselineBackend,
        afterBackend,
      },
    });
    return false;
  }
  if (baseline.presentationKey === after.presentationKey) return true;
  emitDiagnostic({
    level: 'debug',
    phase: 'ios_tap_failure_corroboration_scope_mismatch',
    data: {
      command,
      baselinePresentationKey: baseline.presentationKey,
      afterPresentationKey: after.presentationKey,
    },
  });
  return false;
}

function compareCorroborationEvidence(
  baseline: SnapshotState,
  after: SnapshotState,
  command: string,
): IosTapCorroboration | undefined {
  if (!hasUsableBaseline(after)) return undefined;
  const beforeEvidence = summarizeAxEvidence(baseline.nodes);
  const afterEvidence = summarizeAxEvidence(after.nodes);
  if (beforeEvidence.digest === afterEvidence.digest) return undefined;

  emitDiagnostic({
    level: 'warn',
    phase: 'ios_tap_failure_corroborated',
    data: {
      command,
      beforeNodeCount: beforeEvidence.nodeCount,
      afterNodeCount: afterEvidence.nodeCount,
    },
  });
  return { warning: IOS_TAP_CORROBORATION_WARNING };
}

function hasUsableBaseline(snapshot: SnapshotState | undefined): snapshot is SnapshotState {
  return Boolean(
    snapshot &&
    snapshot.nodes.length > 0 &&
    !isSparseSnapshotQualityVerdict(snapshot.snapshotQuality),
  );
}

function readSnapshotPresentation(value: string | undefined): SnapshotPresentation | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return parseSnapshotPresentation(parsed);
}

function parseSnapshotPresentation(value: unknown): SnapshotPresentation | undefined {
  const raw = asRecord(value);
  if (!raw || typeof raw.interactiveOnly !== 'boolean' || typeof raw.raw !== 'boolean') {
    return undefined;
  }
  if (!isOptionalNumber(raw.depth) || !isOptionalString(raw.scope)) return undefined;
  return {
    interactiveOnly: raw.interactiveOnly,
    ...(typeof raw.depth === 'number' ? { depth: raw.depth } : {}),
    ...(typeof raw.scope === 'string' ? { scope: raw.scope } : {}),
    raw: raw.raw,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isOptionalNumber(value: unknown): value is number | null | undefined {
  return value === null || value === undefined || typeof value === 'number';
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === 'string';
}

function matchingCaptureFlags(
  flags: CommandFlags | undefined,
  presentation: SnapshotPresentation | undefined,
): CommandFlags | undefined {
  if (!flags && !presentation) return undefined;
  return {
    ...(flags ?? {}),
    out: undefined,
    ...(presentation
      ? {
          snapshotDepth: presentation.depth,
          snapshotScope: presentation.scope,
          snapshotRaw: presentation.raw,
        }
      : {}),
  };
}

export function interactionTargetExtra(target: InteractionTarget): Record<string, unknown> {
  if (target.kind === 'selector') return { selector: target.selector };
  if (target.kind === 'ref') {
    return { ref: target.ref.startsWith('@') ? target.ref.slice(1) : target.ref };
  }
  return {};
}
