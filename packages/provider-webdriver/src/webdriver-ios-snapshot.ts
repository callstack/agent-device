import {
  createIosSnapshotEngine,
  IosSnapshotEngineError,
  resolveIosViewportEvidenceFromRoots,
  toIosSnapshotEngineErrorDetails,
} from '@agent-device/capture-kit/ios-snapshot-engine';
import {
  createIosSnapshotRequest,
  deriveIosSnapshotCapabilityResidue,
  IOS_SNAPSHOT_PRODUCER_CAPABILITIES,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import type {
  IosAcquisitionResidue,
  IosSnapshotAcquisition,
  IosSnapshotInput,
  IosSnapshotPlan,
  IosSnapshotPublication,
  IosSnapshotRequest,
  IosViewportEvidence,
} from '@agent-device/contracts/ios-snapshot';
import type { SnapshotOptions, SnapshotResult } from '@agent-device/contracts/interactor-types';
import type { RawSnapshotNode, SnapshotNode } from '@agent-device/kernel/snapshot';
import { AppError } from '@agent-device/kernel/errors';
import type { WebDriverClient } from './webdriver-client.ts';
import { parseWebDriverSourceFacts } from './webdriver-source.ts';

const APPIUM_PRODUCER = IOS_SNAPSHOT_PRODUCER_CAPABILITIES['appium-source'];
const iosSnapshotEngine = createIosSnapshotEngine();
const RESIDUE_WARNINGS = {
  'missing-viewport':
    'Appium page source does not provide valid viewport evidence; regular snapshots fail closed. Use snapshot --raw to inspect the acquired tree.',
} satisfies Pick<Record<IosAcquisitionResidue['kind'], string>, 'missing-viewport'>;
type WebDriverUnavailableFact = 'acquisition-depth' | 'hittability';

const UNAVAILABLE_FACT_WARNINGS = {
  'acquisition-depth':
    'Appium page source does not report hierarchy completeness; provider-side depth or child limits may omit nodes.',
  hittability:
    'Appium page source does not guarantee hittability evidence; absent hittable means no evidence, not false. Raw output preserves any provider-reported value.',
} satisfies Record<WebDriverUnavailableFact, string>;

export type WebDriverIosSnapshotAcquisition = Readonly<{
  request: IosSnapshotRequest;
  plan: IosSnapshotPlan;
  input: Extract<IosSnapshotInput, { stage: 'acquired' }>;
}>;

export type WebDriverIosSnapshotPublication = Readonly<{
  acquisition: WebDriverIosSnapshotAcquisition;
  publication: IosSnapshotPublication;
  result: SnapshotResult;
}>;

export async function captureWebDriverIosSnapshot(
  client: Pick<WebDriverClient, 'source'>,
  options?: SnapshotOptions,
  targetId?: string,
): Promise<SnapshotResult> {
  const acquired = acquireWebDriverIosSnapshot(await client.source(), options, targetId);
  return publishWebDriverIosSnapshot(acquired).result;
}

export function acquireWebDriverIosSnapshot(
  source: string,
  options?: SnapshotOptions,
  targetId?: string,
): WebDriverIosSnapshotAcquisition {
  const request = createIosSnapshotRequest({
    raw: options?.raw,
    interactiveOnly: options?.interactiveOnly,
    depth: options?.depth,
    scope: options?.scope,
    customActions: options?.customActions,
  });
  const plan = iosSnapshotEngine.plan(request, APPIUM_PRODUCER);
  const sourceFacts = parseWebDriverSourceFacts(source, { mode: 'facts' });
  const viewport = resolveIosViewportEvidenceFromRoots(sourceFacts.roots) ?? {
    kind: 'missing' as const,
    reason: 'not-provided' as const,
  };
  const residue = residueForSource(viewport);
  const common = {
    producer: 'appium-source' as const,
    nodes: sourceFacts.nodes,
    viewport,
    lineage: targetId ? { targetId } : {},
    residue,
  };
  const acquisition: IosSnapshotAcquisition = {
    ...common,
    intent: 'full',
    hint: { ...plan.hint, acquisitionIntent: 'full' },
  };
  return { request, plan, input: { stage: 'acquired', acquisition } };
}

export function publishWebDriverIosSnapshot(
  acquisition: WebDriverIosSnapshotAcquisition,
): WebDriverIosSnapshotPublication {
  let publication: IosSnapshotPublication;
  try {
    publication = iosSnapshotEngine.publish(acquisition.input, acquisition.request);
  } catch (error) {
    throwWebDriverIosSnapshotError(error);
  }
  const result = {
    backend: 'xctest',
    producer: 'appium-source',
    nodes: stripRefs(publication.payload.nodes),
    ...warningsForResidue(publication.residue),
  } satisfies SnapshotResult;
  return { acquisition, publication, result };
}

function residueForSource(viewport: IosViewportEvidence): readonly IosAcquisitionResidue[] {
  const residue = [...deriveIosSnapshotCapabilityResidue(APPIUM_PRODUCER)];
  if (viewport.kind === 'missing') {
    residue.push({ kind: 'missing-viewport', reason: viewport.reason });
  }
  return residue;
}

function warningsForResidue(residue: readonly IosAcquisitionResidue[]): { warnings?: string[] } {
  const warnings = new Set<string>();
  for (const entry of residue) {
    const warning = warningForResidue(entry);
    if (warning) warnings.add(warning);
  }
  return warnings.size > 0 ? { warnings: [...warnings] } : {};
}

function warningForResidue(entry: IosAcquisitionResidue): string | undefined {
  if (entry.kind === 'unavailable-fact') {
    return entry.fact === 'acquisition-depth' || entry.fact === 'hittability'
      ? UNAVAILABLE_FACT_WARNINGS[entry.fact]
      : undefined;
  }
  if (entry.kind === 'missing-viewport') {
    return RESIDUE_WARNINGS[entry.kind];
  }
  return undefined;
}

function stripRefs(nodes: readonly SnapshotNode[]): RawSnapshotNode[] {
  return nodes.map(({ ref: _ref, ...node }) => node);
}

function throwWebDriverIosSnapshotError(error: unknown): never {
  if (!(error instanceof IosSnapshotEngineError)) throw error;
  const details = toIosSnapshotEngineErrorDetails(error);
  throw new AppError(
    'COMMAND_FAILED',
    error.message,
    {
      ...details,
      ...(error.reason === 'missing-viewport' || error.reason === 'invalid-viewport'
        ? {
            hint: 'Use snapshot --raw to inspect the acquired Appium tree; regular presentation requires valid viewport evidence.',
          }
        : {}),
    },
    error,
  );
}
