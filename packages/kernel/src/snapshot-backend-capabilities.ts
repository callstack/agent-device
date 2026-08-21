/**
 * Typed declarations for the iOS snapshot strategies. The registry is the classification gate:
 * adding a strategy to the snapshot backend union without describing its capabilities is a
 * typecheck failure in every consumer that uses this record.
 */
export type SnapshotBackendHittable = 'hit-tested' | 'approximated' | 'n/a';
export type SnapshotBackendSupport = 'yes' | 'no' | 'n/a';
export type SnapshotBackendConformance = 'required' | 'not-applicable';

export type SnapshotBackendGap = {
  id: string;
  description: string;
  owner: string;
  trackingIssue: number;
  expiresOn: string;
};

export type SnapshotBackendCapability = {
  forceable: boolean;
  supportsRawProjection: boolean;
  hittable: SnapshotBackendHittable;
  deepExtension: SnapshotBackendSupport;
  depthLadder: SnapshotBackendSupport;
  fixtureConformance: SnapshotBackendConformance;
  knownGaps: readonly SnapshotBackendGap[];
};

export const SNAPSHOT_BACKEND_CAPABILITIES = {
  tree: {
    forceable: true,
    supportsRawProjection: true,
    hittable: 'hit-tested',
    deepExtension: 'no',
    depthLadder: 'n/a',
    fixtureConformance: 'required',
    knownGaps: [
      {
        id: 'deep-extension',
        description: 'The recursive XCTest tree does not extend missed depth-cap frontiers.',
        owner: 'iOS snapshot maintainers',
        trackingIssue: 1635,
        expiresOn: '2027-03-31',
      },
    ],
  },
  queries: {
    forceable: false,
    supportsRawProjection: false,
    hittable: 'hit-tested',
    deepExtension: 'n/a',
    depthLadder: 'n/a',
    fixtureConformance: 'not-applicable',
    knownGaps: [],
  },
  'private-ax': {
    forceable: true,
    supportsRawProjection: true,
    hittable: 'approximated',
    deepExtension: 'yes',
    depthLadder: 'yes',
    fixtureConformance: 'required',
    knownGaps: [
      {
        id: 'hittable-approximation',
        description: 'Private AX approximates hittability instead of asking XCTest to hit-test.',
        owner: 'iOS snapshot maintainers',
        trackingIssue: 1797,
        expiresOn: '2027-03-31',
      },
    ],
  },
} as const satisfies Record<string, SnapshotBackendCapability>;

export type SnapshotCaptureBackend = keyof typeof SNAPSHOT_BACKEND_CAPABILITIES;

export type SnapshotBackendCapabilityRegistry = Record<
  SnapshotCaptureBackend,
  SnapshotBackendCapability
>;

export type SnapshotPreferredBackend = {
  [Backend in SnapshotCaptureBackend]: (typeof SNAPSHOT_BACKEND_CAPABILITIES)[Backend]['forceable'] extends true
    ? Backend
    : never;
}[SnapshotCaptureBackend];

export type SnapshotConformanceBackend = {
  [Backend in SnapshotCaptureBackend]: (typeof SNAPSHOT_BACKEND_CAPABILITIES)[Backend]['fixtureConformance'] extends 'required'
    ? Backend
    : never;
}[SnapshotCaptureBackend];

export const SNAPSHOT_BACKEND_CONFORMANCE_TARGETS = Object.entries(SNAPSHOT_BACKEND_CAPABILITIES)
  .filter(([, capability]) => capability.fixtureConformance === 'required')
  .map(([backend]) => backend as SnapshotConformanceBackend);

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validateSnapshotBackendGap(
  backend: SnapshotCaptureBackend,
  gap: SnapshotBackendGap,
  gapIds: Set<string>,
  asOf: string,
): string[] {
  const errors: string[] = [];

  if (gap.id.trim().length === 0) {
    errors.push(`${backend} gap must have an id`);
  } else if (gapIds.has(gap.id)) {
    errors.push(`duplicate snapshot backend gap id ${gap.id}`);
  } else {
    gapIds.add(gap.id);
  }
  if (gap.owner.trim().length === 0) {
    errors.push(`${backend} gap ${gap.id} must name an owner`);
  }
  if (!Number.isInteger(gap.trackingIssue) || gap.trackingIssue <= 0) {
    errors.push(`${backend} gap ${gap.id} must name a positive tracking issue`);
  }
  if (!ISO_DATE_PATTERN.test(gap.expiresOn) || gap.expiresOn <= asOf) {
    errors.push(`${backend} gap ${gap.id} expiresOn must be after ${asOf}`);
  }

  return errors;
}

export function validateSnapshotBackendCapabilities(
  registry: SnapshotBackendCapabilityRegistry = SNAPSHOT_BACKEND_CAPABILITIES,
  asOf = new Date().toISOString().slice(0, 10),
): string[] {
  const errors: string[] = [];
  const gapIds = new Set<string>();

  for (const [backend, capability] of Object.entries(registry) as Array<
    [SnapshotCaptureBackend, SnapshotBackendCapability]
  >) {
    for (const gap of capability.knownGaps) {
      errors.push(...validateSnapshotBackendGap(backend, gap, gapIds, asOf));
    }
  }

  return errors;
}
