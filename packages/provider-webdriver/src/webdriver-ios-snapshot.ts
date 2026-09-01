import {
  createIosSnapshotEngine,
  IosSnapshotEngineError,
  resolveIosViewportEvidenceFromRoots,
  toIosSnapshotEngineErrorDetails,
} from '@agent-device/capture-kit/ios-snapshot-engine';
import { attachSnapshotPresentationEvidence } from '@agent-device/contracts/capture';
import {
  createIosSnapshotRequest,
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
    'Appium page source does not provide a valid viewport; regular snapshot presentation is unavailable.',
  truncated: 'Appium page source is truncated; the snapshot hierarchy may be incomplete.',
} satisfies Pick<Record<IosAcquisitionResidue['kind'], string>, 'missing-viewport' | 'truncated'>;

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
  const residue = residueForSource(sourceFacts.truncated, viewport);
  const common = {
    producer: 'appium-source' as const,
    nodes: sourceFacts.nodes,
    truncated: sourceFacts.truncated,
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
  const result = attachSnapshotPresentationEvidence(
    {
      backend: 'xctest',
      producer: 'appium-source',
      nodes: stripRefs(publication.payload.nodes),
      truncated: publication.payload.truncated,
      ...warningsForResidue(publication.residue),
    } satisfies SnapshotResult,
    { owner: 'ios-snapshot-engine' },
  );
  return { acquisition, publication, result };
}

function residueForSource(
  truncated: boolean,
  viewport: IosViewportEvidence,
): readonly IosAcquisitionResidue[] {
  const residue: IosAcquisitionResidue[] = [{ kind: 'unavailable-fact', fact: 'hittability' }];
  if (viewport.kind === 'missing') {
    residue.push({ kind: 'missing-viewport', reason: viewport.reason });
  }
  if (truncated) residue.push({ kind: 'truncated', dimension: 'nodes' });
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
    return entry.fact === 'hittability'
      ? 'Appium page source does not provide hittability evidence; the capture carries no hittability fact.'
      : undefined;
  }
  if (entry.kind === 'missing-viewport' || entry.kind === 'truncated') {
    return RESIDUE_WARNINGS[entry.kind];
  }
  return undefined;
}

function stripRefs(nodes: readonly SnapshotNode[]): RawSnapshotNode[] {
  return nodes.map(({ ref: _ref, ...node }) => node);
}

function throwWebDriverIosSnapshotError(error: unknown): never {
  if (!(error instanceof IosSnapshotEngineError)) throw error;
  throw new AppError(
    'COMMAND_FAILED',
    error.message,
    toIosSnapshotEngineErrorDetails(error),
    error,
  );
}
