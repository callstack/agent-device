import type {
  IosTargetActivation,
  SnapshotCaptureBackend,
  SnapshotQualityState,
  SnapshotQualityVerdict,
} from '@agent-device/kernel/snapshot';
import type { AndroidSnapshotBackendMetadata } from './snapshot-types.ts';

/**
 * The verdict names this host has to speak, each keyed against its kernel union so a name added
 * there without a key here is a compile error. They cannot be one shared kernel predicate: the
 * eager-closure gate keeps `kernel/snapshot.ts` out of `facades/capture.ts` (#2872).
 */
const DECLARED_STATES: Record<SnapshotQualityState, true> = {
  healthy: true,
  recovered: true,
  sparse: true,
};
const DECLARED_BACKENDS: Record<SnapshotCaptureBackend, true> = {
  tree: true,
  queries: true,
  'private-ax': true,
  'android-helper': true,
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
  const quality = readPublishedSnapshotQualityVerdict(source.quality);
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
  const quality = readPublishedSnapshotQualityVerdict(data.snapshotQuality);
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

/**
 * Re-read of a fact this module published, in the shape `readTargetActivation` above uses: the two
 * names that decide presentation are checked, the rest is forwarded as published. capture-kit's
 * `readSnapshotQualityVerdict` normalizes an untrusted runner payload field by field; the two
 * readings are pinned to each other in `snapshot-quality-verdict.test.ts`.
 */
function readPublishedSnapshotQualityVerdict(value: unknown): SnapshotQualityVerdict | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (!isDeclared(DECLARED_STATES, raw.state) || !isDeclared(DECLARED_BACKENDS, raw.backend)) {
    return undefined;
  }
  return raw as SnapshotQualityVerdict;
}

function isDeclared<Key extends string, Value>(
  vocabulary: Record<Key, Value>,
  value: unknown,
): value is Key {
  return typeof value === 'string' && Object.hasOwn(vocabulary, value);
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
