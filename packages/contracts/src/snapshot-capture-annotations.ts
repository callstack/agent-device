import type { IosTargetActivation, SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';
import type { AndroidSnapshotBackendMetadata } from './snapshot-types.ts';

export type SnapshotCaptureAnalysis = {
  rawNodeCount: number;
  maxDepth: number;
};

export type SnapshotCaptureFreshness = {
  action: string;
  retryCount: number;
  staleAfterRetries: boolean;
  reason?: 'empty-interactive' | 'sharp-drop' | 'stuck-route';
};

export type SnapshotCaptureAnnotations = {
  analysis?: SnapshotCaptureAnalysis;
  androidSnapshot?: AndroidSnapshotBackendMetadata;
  freshness?: SnapshotCaptureFreshness;
  quality?: SnapshotQualityVerdict;
  warnings?: string[];
  /** The Apple runner re-activated the session app while serving this capture (#2682). */
  targetActivation?: IosTargetActivation;
};

export type PublicSnapshotCaptureAnnotations = Pick<
  SnapshotCaptureAnnotations,
  'androidSnapshot' | 'warnings' | 'targetActivation'
> & {
  snapshotQuality?: SnapshotQualityVerdict;
};

export function snapshotCaptureAnnotationsFrom(
  source: Partial<Omit<SnapshotCaptureAnnotations, 'quality'>> & { quality?: unknown },
): SnapshotCaptureAnnotations {
  const quality = readSnapshotQualityVerdict(source.quality);
  return {
    ...(source.analysis ? { analysis: source.analysis } : {}),
    ...(source.androidSnapshot ? { androidSnapshot: source.androidSnapshot } : {}),
    ...(source.freshness ? { freshness: source.freshness } : {}),
    ...(quality ? { quality } : {}),
    ...(source.warnings ? { warnings: source.warnings } : {}),
    ...(source.targetActivation ? { targetActivation: source.targetActivation } : {}),
  };
}

export function publicSnapshotCaptureAnnotations(
  annotations: Partial<SnapshotCaptureAnnotations>,
): PublicSnapshotCaptureAnnotations {
  return {
    ...(annotations.androidSnapshot ? { androidSnapshot: annotations.androidSnapshot } : {}),
    ...(annotations.quality ? { snapshotQuality: annotations.quality } : {}),
    ...(annotations.warnings && annotations.warnings.length > 0
      ? { warnings: annotations.warnings }
      : {}),
    ...(annotations.targetActivation ? { targetActivation: annotations.targetActivation } : {}),
  };
}

export function readSerializedSnapshotCaptureAnnotations(
  data: Record<string, unknown>,
): PublicSnapshotCaptureAnnotations {
  const androidSnapshot = readObject(data.androidSnapshot);
  // Declared exception to kernel's shared `readResponseWarnings` (see its doc): this facade
  // pins its eager module closure, and absent-or-non-array keeps the serialized tri-state.
  // `snapshot-capture-annotations.test.ts` cross-checks this filter against the shared parser.
  const warnings = Array.isArray(data.warnings)
    ? data.warnings.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const quality = readSnapshotQualityVerdict(data.snapshotQuality);
  const targetActivation = readTargetActivation(data.targetActivation);
  return publicSnapshotCaptureAnnotations({
    ...(androidSnapshot
      ? { androidSnapshot: androidSnapshot as AndroidSnapshotBackendMetadata }
      : {}),
    ...(quality ? { quality } : {}),
    ...(warnings ? { warnings } : {}),
    ...(targetActivation ? { targetActivation } : {}),
  });
}

/** Re-read of a fact this module projected; the declared keys are the only ones it publishes. */
function readTargetActivation(value: unknown): IosTargetActivation | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return typeof raw.reason === 'string' && typeof raw.priorState === 'string'
    ? (raw as unknown as IosTargetActivation)
    : undefined;
}

function readSnapshotQualityVerdict(value: unknown): SnapshotQualityVerdict | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  return typeof raw.state === 'string' && typeof raw.backend === 'string'
    ? (raw as SnapshotQualityVerdict)
    : undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
