import type {
  IosTargetActivation,
  SnapshotCaptureBackend,
  SnapshotQualityState,
  SnapshotQualityVerdict,
} from '@agent-device/kernel/snapshot';
import type { AndroidSnapshotBackendMetadata } from './snapshot-types.ts';

/**
 * The two verdict names this host has to be able to speak: `state` decides whether a capture reads
 * as degraded, and `backend` names the recovery strategy in the warning line. Each map is keyed
 * against its kernel union, so a name added there without a key here is a compile error, where a set
 * literal merely typed as the union stays green and a runner's verdict is dropped as
 * verdict-absent. The maps live here rather than behind a kernel import because
 * `facades/capture.ts` pins its eager module closure and `kernel/snapshot.ts` is not in it.
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
 * Re-read of a fact this module published, in the shape `readTargetActivation` above also uses: the
 * two names that decide presentation are checked, and the verdict is forwarded as published. Named
 * apart from capture-kit's stricter `readSnapshotQualityVerdict`, which normalizes an untrusted
 * runner payload and reads every field. Reading
 * This one cannot share that code — the eager-closure gate freezes both readers' module closures and
 * the duplication gate refuses a second normalization — so the pair is pinned together by
 * `snapshot-quality-verdict.test.ts`. What stays guaranteed here is the part only this boundary can
 * check: a name this version cannot speak reads as verdict-absent, so a version-skewed runner cannot
 * hand the host a degradation it would present under a state or strategy nobody declared.
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
