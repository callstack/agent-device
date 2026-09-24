import type {
  IosTargetActivation,
  SnapshotQualityState,
  SnapshotQualityVerdict,
} from '@agent-device/kernel/snapshot';
import type { AndroidSnapshotBackendMetadata } from './snapshot-types.ts';

/**
 * Every declared state, keyed against the kernel union so this map cannot fall behind it: a state
 * added there without a key here is a compile error, where a cast or a set literal merely typed as
 * the union stays green and a runner's verdict is dropped as verdict-absent. This reader holds the
 * map rather than importing the kernel's, because `facades/capture.ts` pins its eager module
 * closure and `kernel/snapshot.ts` is not in it.
 */
const snapshotQualityStatesAreTheVocabulary: Record<SnapshotQualityState, true> = {
  healthy: true,
  recovered: true,
  sparse: true,
};

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
  // `state` decides whether a capture reads as degraded, so it goes through the declared
  // vocabulary instead of a cast: this reader sees whatever a runner or an older daemon put on the
  // wire, and a state it cannot name must read as verdict-absent.
  if (!isSnapshotQualityState(raw.state) || typeof raw.backend !== 'string') return undefined;
  return raw as SnapshotQualityVerdict;
}

function isSnapshotQualityState(value: unknown): value is SnapshotQualityState {
  return typeof value === 'string' && Object.hasOwn(snapshotQualityStatesAreTheVocabulary, value);
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
