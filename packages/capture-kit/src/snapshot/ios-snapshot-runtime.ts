import {
  attachSnapshotTextInputGeometry,
  type SnapshotTextInputGeometry,
} from '@agent-device/contracts/capture';
import { isFillableType, normalizeType } from '@agent-device/contracts/snapshot';
import {
  IosSnapshotEngineError,
  publishIosSnapshot,
  toIosSnapshotEngineErrorDetails,
} from '../ios-snapshot-engine/index.ts';
import { createIosSnapshotRequest, deriveIosCaptureHint } from '../ios-snapshot-planning.ts';
import type {
  IosAcquisitionResidue,
  IosSnapshotFact,
  IosSnapshotInput,
  IosSnapshotAcquisitionFacts,
} from '@agent-device/contracts/ios-snapshot';
import type {
  SnapshotOptions,
  SnapshotResult,
  SnapshotRuntimeAcquiredResult,
} from '@agent-device/contracts/interactor-types';
import { AppError } from '@agent-device/kernel/errors';
import { isPositiveFiniteRect, snapshotViewportSizeFrom } from '@agent-device/kernel/rect';

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
    const textInputGeometry = acquiredTextInputGeometry(acquired.acquisition);
    const presentation = publishIosSnapshot(input, request);
    // The engine returns the box its regular fold validated against and no box for raw; this seam
    // only passes it through the shared construction guard (#3182).
    const validatedViewport = snapshotViewportSizeFrom(presentation.validatedViewport);
    const nodes = [...presentation.payload.nodes];
    if (textInputGeometry) attachSnapshotTextInputGeometry(nodes, textInputGeometry);
    return {
      backend: 'xctest',
      ...(presentation.qualityNotes ? { qualityNotes: presentation.qualityNotes } : {}),
      producer: acquired.acquisition.producer,
      nodes,
      ...(acquired.acquisition.keyboard ? { keyboard: acquired.acquisition.keyboard } : {}),
      comparisonIdentity: presentation.comparisonIdentity,
      ...(acquired.acquisition.truncated === undefined
        ? {}
        : { truncated: acquired.acquisition.truncated }),
      ...(validatedViewport ? { viewport: validatedViewport } : {}),
      ...(presentation.presentedSurface ? { presentedSurface: presentation.presentedSurface } : {}),
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

function acquiredTextInputGeometry(
  acquisition: IosSnapshotAcquisitionFacts,
): SnapshotTextInputGeometry | undefined {
  if (
    acquisition.intent !== 'full' ||
    acquisition.truncated !== false ||
    acquisition.nodes.length === 0
  )
    return undefined;
  if (
    acquisition.residue.some(
      (entry) =>
        entry.kind === 'provider-pruned' ||
        entry.kind === 'truncated' ||
        (entry.kind === 'unavailable-fact' && entry.fact === 'acquisition-depth'),
    )
  )
    return undefined;
  const rects = [];
  for (const node of acquisition.nodes) {
    const input = [node.type, node.role].some((type) => {
      if (!type) return false;
      const normalized = normalizeType(type).replaceAll(/[-_ ]/g, '');
      return (
        normalized !== '' &&
        (isFillableType(normalized, 'ios') ||
          normalized === 'textbox' ||
          normalized === 'searchbox')
      );
    });
    if (!input) continue;
    if (!isPositiveFiniteRect(node.rect)) return undefined;
    rects.push({ ...node.rect });
  }
  return { rects };
}
