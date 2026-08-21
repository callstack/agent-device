import type {
  SnapshotCaptureBackend,
  SnapshotPreferredBackend,
} from '@agent-device/kernel/snapshot';

type SnapshotBackendHittable = 'hit-tested' | 'approximated' | 'n/a';
type SnapshotBackendSupport = 'yes' | 'no' | 'n/a';

type SnapshotBackendCapability = {
  supportsRawProjection: boolean;
  hittable: SnapshotBackendHittable;
  deepExtension: SnapshotBackendSupport;
  depthLadder: SnapshotBackendSupport;
  knownGaps: readonly string[];
};

type SnapshotBackendCapabilityRegistry = {
  [Backend in SnapshotCaptureBackend]: SnapshotBackendCapability & {
    forceable: Backend extends SnapshotPreferredBackend ? true : false;
  };
};

/**
 * Internal contract for the iOS snapshot strategies. The mapped registry keeps every backend
 * classified and makes forceability agree with the request wire type at compile time.
 */
export const SNAPSHOT_BACKEND_CAPABILITIES = {
  tree: {
    forceable: true,
    supportsRawProjection: true,
    hittable: 'hit-tested',
    deepExtension: 'no',
    depthLadder: 'n/a',
    knownGaps: ['deep-extension'],
  },
  queries: {
    forceable: false,
    supportsRawProjection: false,
    hittable: 'hit-tested',
    deepExtension: 'n/a',
    depthLadder: 'n/a',
    knownGaps: [],
  },
  'private-ax': {
    forceable: true,
    supportsRawProjection: true,
    hittable: 'approximated',
    deepExtension: 'yes',
    depthLadder: 'yes',
    knownGaps: ['hittable-approximation'],
  },
} as const satisfies SnapshotBackendCapabilityRegistry;
