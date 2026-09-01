import {
  createIosSnapshotEngine,
  IosSnapshotEngineError,
} from '@agent-device/capture-kit/ios-snapshot-engine';
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
import { normalizeType } from '@agent-device/contracts/snapshot';
import type { RawSnapshotNode, Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { AppError } from '@agent-device/kernel/errors';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import type { WebDriverClient } from './webdriver-client.ts';
import { parseWebDriverSourceFacts, type WebDriverSourceRootFact } from './webdriver-source.ts';

const APPIUM_PRODUCER = IOS_SNAPSHOT_PRODUCER_CAPABILITIES['appium-source'];
const iosSnapshotEngine = createIosSnapshotEngine();
const RESIDUE_WARNINGS: Partial<Record<IosAcquisitionResidue['kind'], string>> = {
  'missing-viewport':
    'Appium page source does not provide a valid viewport; regular snapshot presentation is unavailable.',
  truncated: 'Appium page source is truncated; the snapshot hierarchy may be incomplete.',
  'provider-pruned':
    'Appium page source is provider-pruned; the snapshot hierarchy may be incomplete.',
  'stale-generation':
    'Appium snapshot generation is stale; the snapshot may not describe the current target.',
  'fallback-source': 'Appium snapshot used a fallback source; snapshot fidelity may be reduced.',
};

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
  const viewport = viewportEvidence(sourceFacts.roots);
  const residue = residueForSource(sourceFacts.truncated, viewport);
  const common = {
    producer: 'appium-source' as const,
    nodes: sourceFacts.nodes,
    truncated: sourceFacts.truncated,
    viewport,
    lineage: targetId ? { targetId } : {},
    residue,
  };
  const acquisition: IosSnapshotAcquisition =
    request.acquisitionIntent === 'full'
      ? { ...common, intent: 'full', hint: { ...plan.hint, acquisitionIntent: 'full' } }
      : {
          ...common,
          intent: 'surface-observation',
          hint: { ...plan.hint, acquisitionIntent: 'surface-observation' },
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
  const result: SnapshotResult = {
    backend: 'xctest',
    producer: 'appium-source',
    nodes: stripRefs(publication.payload.nodes),
    truncated: publication.payload.truncated,
    ...warningsForResidue(publication.residue),
  };
  return { acquisition, publication, result };
}

function viewportEvidence(roots: readonly WebDriverSourceRootFact[]): IosViewportEvidence {
  const candidates = roots.filter((node) => {
    const type = normalizeType(node.type ?? '');
    return type === 'application' || type === 'window';
  });
  const root = [...candidates].sort(compareViewportRoots)[0];
  if (!root) return { kind: 'missing', reason: 'not-provided' };
  if (root.rectStatus === 'reported' && isPositiveFiniteRect(root.rect)) {
    return { kind: 'reported', rect: root.rect };
  }
  return { kind: 'missing', reason: root.rectStatus === 'invalid' ? 'invalid' : 'not-provided' };
}

function rectArea(rect: Rect | undefined): number {
  return rect && isPositiveFiniteRect(rect) ? rect.width * rect.height : 0;
}

function compareViewportRoots(
  left: WebDriverSourceRootFact,
  right: WebDriverSourceRootFact,
): number {
  const status = rootGeometryRank(right.rectStatus) - rootGeometryRank(left.rectStatus);
  return status || rectArea(right.rect) - rectArea(left.rect);
}

function rootGeometryRank(status: WebDriverSourceRootFact['rectStatus']): number {
  return status === 'reported' ? 2 : status === 'invalid' ? 1 : 0;
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
      ? 'Appium page source does not provide hittability evidence; regular snapshot nodes are not actionable.'
      : `Appium page source does not provide ${entry.fact} evidence.`;
  }
  return RESIDUE_WARNINGS[entry.kind];
}

function stripRefs(nodes: readonly SnapshotNode[]): RawSnapshotNode[] {
  return nodes.map(({ ref: _ref, ...node }) => node);
}

function throwWebDriverIosSnapshotError(error: unknown): never {
  if (!(error instanceof IosSnapshotEngineError)) throw error;
  throw new AppError(
    'COMMAND_FAILED',
    error.message,
    {
      reason: error.reason,
      ...(error.details.field ? { field: error.details.field } : {}),
    },
    error,
  );
}
