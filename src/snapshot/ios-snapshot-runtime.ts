import {
  IosSnapshotEngineError,
  presentIosSnapshot,
  toIosSnapshotEngineErrorDetails,
} from '@agent-device/capture-kit/ios-snapshot-engine';
import {
  createIosSnapshotRequest,
  deriveIosCaptureHint,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import type {
  IosAcquisitionResidue,
  IosSnapshotFact,
  IosSnapshotInput,
} from '@agent-device/contracts/ios-snapshot';
import type {
  SnapshotOptions,
  SnapshotResult,
  SnapshotRuntimeAcquiredResult,
} from '@agent-device/contracts/interactor-types';
import { AppError } from '@agent-device/kernel/errors';

const IOS_SNAPSHOT_FACT_WARNINGS: Partial<Record<IosSnapshotFact, string>> = {
  'acquisition-depth':
    'iOS snapshot acquisition does not report hierarchy completeness; provider-side depth or child limits may omit nodes.',
  hittability:
    'iOS snapshot acquisition does not provide hittability evidence; regular snapshots omit unverified hittability while raw snapshots preserve supplied facts.',
  truncation:
    'iOS snapshot acquisition does not expose truncation metadata; tree completeness is not independently verified.',
};

export function presentIosSnapshotAcquisition(
  acquired: SnapshotRuntimeAcquiredResult,
  options?: Readonly<Omit<SnapshotOptions, 'signal'>>,
): SnapshotResult {
  const request = createIosSnapshotRequest({
    raw: options?.raw,
    interactiveOnly: options?.interactiveOnly,
    depth: options?.depth,
    scope: options?.scope,
    customActions: options?.customActions,
    acquisitionIntent: acquired.acquisition.intent,
  });
  const input = iosSnapshotInput(acquired, request);

  try {
    const presentation = presentIosSnapshot(input, request);
    return {
      backend: 'xctest',
      producer: acquired.acquisition.producer,
      nodes: presentation.nodes,
      ...(acquired.acquisition.truncated === undefined
        ? {}
        : { truncated: acquired.acquisition.truncated }),
      ...snapshotWarnings(acquired.acquisition.residue),
    };
  } catch (error) {
    throwIosSnapshotPresentationError(error);
  }
}

function iosSnapshotInput(
  acquired: SnapshotRuntimeAcquiredResult,
  request: ReturnType<typeof createIosSnapshotRequest>,
): IosSnapshotInput {
  const hint = deriveIosCaptureHint(request);
  if (acquired.acquisition.intent === 'full') {
    return {
      stage: 'acquired',
      acquisition: {
        ...acquired.acquisition,
        intent: 'full',
        hint: { ...hint, acquisitionIntent: 'full' },
      },
    };
  }
  return {
    stage: 'acquired',
    acquisition: {
      ...acquired.acquisition,
      intent: 'surface-observation',
      hint: { ...hint, acquisitionIntent: 'surface-observation' },
    },
  };
}

function snapshotWarnings(residue: readonly IosAcquisitionResidue[]): { warnings?: string[] } {
  const warnings = new Set(
    residue.flatMap((entry) => {
      if (entry.kind === 'missing-viewport') {
        return [
          `iOS snapshot acquisition did not provide a valid viewport (${entry.reason}); retry with --raw to inspect the acquired tree, while regular presentation requires viewport evidence.`,
        ];
      }
      if (entry.kind !== 'unavailable-fact') return [];
      const warning = IOS_SNAPSHOT_FACT_WARNINGS[entry.fact];
      return warning ? [warning] : [];
    }),
  );
  return warnings.size === 0 ? {} : { warnings: [...warnings] };
}

function throwIosSnapshotPresentationError(error: unknown): never {
  if (!(error instanceof IosSnapshotEngineError)) throw error;
  const details = toIosSnapshotEngineErrorDetails(error);
  const hint =
    error.reason === 'missing-viewport' || error.reason === 'invalid-viewport'
      ? 'Use snapshot --raw to inspect the acquired iOS tree; regular presentation requires valid viewport evidence.'
      : undefined;
  throw new AppError(
    'COMMAND_FAILED',
    error.message,
    { ...details, ...(hint ? { hint } : {}) },
    error,
  );
}
