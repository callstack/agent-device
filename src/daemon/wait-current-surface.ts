import type { SnapshotNode } from '../kernel/snapshot.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';
import { captureSnapshot } from './handlers/snapshot-capture.ts';
import { errorResponse } from './handlers/response.ts';
import { normalizeType } from '../snapshot/snapshot-processing.ts';

type WaitCurrentSurfaceParams = {
  req: DaemonRequest;
  logPath?: string;
  session: SessionState | undefined;
  device: SessionState['device'];
};

type CurrentSurfaceDetails = {
  labels: string[];
  buttons?: string[];
};

const CHROME_ROLE_MARKERS = ['application', 'window', 'tabbar', 'scrollbar', 'image'] as const;
const CHROME_LABELS = new Set(['tab bar']);

export async function maybeWaitTimeoutSurfaceResponse(
  params: WaitCurrentSurfaceParams,
  response: DaemonResponse,
): Promise<DaemonResponse> {
  if (response.ok || !isWaitTimeoutMessage(response.error.message)) return response;
  const currentSurface = await inspectCurrentSurface(params).catch(() => null);
  if (!currentSurface) return response;
  return errorResponse(
    response.error.code,
    `${response.error.message}. Current surface: ${currentSurface.summary}.`,
    {
      ...(response.error.details ?? {}),
      currentSurface: currentSurface.details,
    },
  );
}

function isWaitTimeoutMessage(message: string): boolean {
  return /^wait timed out for (?:selector|text): /i.test(message);
}

async function inspectCurrentSurface(
  params: WaitCurrentSurfaceParams,
): Promise<{ summary: string; details: CurrentSurfaceDetails } | null> {
  const capture = await captureSnapshot({
    device: params.device,
    session: params.session,
    flags: {
      ...params.req.flags,
      snapshotInteractiveOnly: true,
    },
    logPath: params.logPath ?? '',
  });
  const orderedNodes = [...capture.snapshot.nodes].sort(compareSurfacePriority);
  const labels = topSurfaceTexts(orderedNodes, 6, { includeIdentifiers: true });
  if (labels.length === 0) return null;
  const contentNodes = orderedNodes.filter((node) => !isChromeLikeNode(node));
  const summaryLabels = topSurfaceTexts(contentNodes, 4, { includeIdentifiers: false });
  const buttons = topSurfaceTexts(orderedNodes.filter(isButtonLikeNode), 4, {
    includeIdentifiers: true,
  });
  const summary = (summaryLabels.length > 0 ? summaryLabels : labels.slice(0, 4)).join(', ');
  return {
    summary,
    details: {
      labels,
      ...(buttons.length > 0 ? { buttons } : {}),
    },
  };
}

function topSurfaceTexts(
  nodes: SnapshotNode[],
  limit: number,
  options: { includeIdentifiers: boolean },
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const node of nodes) {
    const text = extractSurfaceText(node, options);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function compareSurfacePriority(a: SnapshotNode, b: SnapshotNode): number {
  return surfacePriority(a) - surfacePriority(b) || compareSurfaceOrder(a, b);
}

function surfacePriority(node: SnapshotNode): number {
  const hasHumanText = Boolean(extractSurfaceText(node, { includeIdentifiers: false }));
  const chromePenalty = isChromeLikeNode(node) ? 2 : 0;
  return chromePenalty + (hasHumanText ? 0 : 1);
}

function compareSurfaceOrder(a: SnapshotNode, b: SnapshotNode): number {
  if (a.rect && b.rect) return a.rect.y - b.rect.y || a.rect.x - b.rect.x;
  if (a.rect) return -1;
  if (b.rect) return 1;
  return (a.depth ?? 0) - (b.depth ?? 0) || a.index - b.index;
}

function extractSurfaceText(node: SnapshotNode, options: { includeIdentifiers: boolean }): string {
  const candidates = options.includeIdentifiers
    ? [node.label, node.value, node.identifier]
    : [node.label, node.value];
  const value = candidates
    .map((candidate) => (typeof candidate === 'string' ? candidate.trim() : ''))
    .find((candidate) => candidate.length > 0);
  return value ? value.replace(/\s+/g, ' ').slice(0, 80) : '';
}

function isChromeLikeNode(node: SnapshotNode): boolean {
  const roleText = normalizeType(`${node.type ?? ''} ${node.role ?? ''} ${node.subrole ?? ''}`);
  const label = `${node.label ?? ''} ${node.value ?? ''}`.trim().toLowerCase();
  return (
    CHROME_ROLE_MARKERS.some((marker) => roleText.includes(marker)) ||
    CHROME_LABELS.has(label) ||
    label.endsWith('.fill')
  );
}

function isButtonLikeNode(node: SnapshotNode): boolean {
  const roleText = `${node.type ?? ''} ${node.role ?? ''} ${node.subrole ?? ''}`;
  return normalizeType(roleText).includes('button');
}
