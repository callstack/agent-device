import type {
  SnapshotCaptureBackend,
  SnapshotPreferredBackend,
} from '@agent-device/kernel/snapshot';

/** #1933: every classified backend publishes this shared predicate in the wire `hittable` field. */
type SnapshotBackendHittable = 'geometric-actionability';
type SnapshotBackendSupport = 'yes' | 'no' | 'n/a';
type SnapshotRegularDepthCapability = 'presented-frontier' | 'flat' | 'raw-only';

type SnapshotBackendCapability = {
  supportsRawProjection: boolean;
  regularDepth: SnapshotRegularDepthCapability;
  hittable: SnapshotBackendHittable;
  deepExtension: SnapshotBackendSupport;
  depthLadder: SnapshotBackendSupport;
  knownGaps: readonly string[];
};

type IosSnapshotCaptureBackend = Exclude<SnapshotCaptureBackend, 'android-helper'>;

type SnapshotBackendCapabilityRegistry = {
  [Backend in IosSnapshotCaptureBackend]: SnapshotBackendCapability & {
    forceable: Backend extends SnapshotPreferredBackend ? true : false;
  };
};

type SnapshotQualityBackendCapabilityRegistry = {
  [Backend in SnapshotCaptureBackend]: SnapshotBackendCapability & {
    forceable: Backend extends SnapshotPreferredBackend ? true : false;
  };
};

/**
 * Internal contract for snapshot strategies. The mapped registry keeps every backend classified
 * and makes forceability agree with the request wire type at compile time.
 */
export const SNAPSHOT_BACKEND_CAPABILITIES = {
  tree: {
    forceable: true,
    supportsRawProjection: true,
    regularDepth: 'presented-frontier',
    hittable: 'geometric-actionability',
    deepExtension: 'no',
    depthLadder: 'n/a',
    knownGaps: ['deep-extension'],
  },
  queries: {
    forceable: false,
    supportsRawProjection: false,
    regularDepth: 'flat',
    hittable: 'geometric-actionability',
    deepExtension: 'n/a',
    depthLadder: 'n/a',
    knownGaps: [],
  },
  'private-ax': {
    forceable: true,
    supportsRawProjection: true,
    regularDepth: 'raw-only',
    hittable: 'geometric-actionability',
    deepExtension: 'yes',
    depthLadder: 'yes',
    knownGaps: [],
  },
} as const satisfies SnapshotBackendCapabilityRegistry;

/** Android's helper is a quality backend, not an iOS CLI-selectable backend. */
export const ANDROID_SNAPSHOT_BACKEND_CAPABILITIES = {
  'android-helper': {
    forceable: false,
    supportsRawProjection: true,
    regularDepth: 'presented-frontier',
    hittable: 'geometric-actionability',
    deepExtension: 'n/a',
    depthLadder: 'n/a',
    knownGaps: [],
  },
} as const satisfies Pick<SnapshotQualityBackendCapabilityRegistry, 'android-helper'>;

/** The validator registry combines platform-owned declarations without widening iOS CLI help. */
export const SNAPSHOT_QUALITY_BACKEND_CAPABILITIES = {
  ...SNAPSHOT_BACKEND_CAPABILITIES,
  ...ANDROID_SNAPSHOT_BACKEND_CAPABILITIES,
} as const satisfies SnapshotQualityBackendCapabilityRegistry;
