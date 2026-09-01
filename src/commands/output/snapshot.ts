import {
  buildAndroidHelperPresentationInput,
  type AndroidHelperPresentationInput,
} from '../../snapshot/snapshot-presentation/android/helper.ts';
import { detectPossibleRepeatedNavSubtree } from '../../snapshot/snapshot-presentation/repeated-nav-subtree.ts';
import { buildSnapshotDisplayLines, formatSnapshotLine } from '../../snapshot/snapshot-lines.ts';
import {
  isSnapshotBackend,
  usesMobileSnapshotPresentation,
  type SnapshotNode,
  type SnapshotUnchanged,
  type SnapshotVisibility,
} from '@agent-device/kernel/snapshot';
import { buildMobileSnapshotPresentation } from '@agent-device/capture-kit/mobile-snapshot-semantics';

type SnapshotTextOptions = {
  raw?: boolean;
  flatten?: boolean;
  scoped?: boolean;
  depthLimited?: boolean;
};

export function formatSnapshotText(
  data: Record<string, unknown>,
  options: SnapshotTextOptions = {},
): string {
  const rawNodes = data.nodes;
  const nodes = Array.isArray(rawNodes) ? (rawNodes as SnapshotNode[]) : [];
  const backend = isSnapshotBackend(data.backend) ? data.backend : undefined;
  const useMobilePresentation = usesMobileSnapshotPresentation(backend);
  const helperPresentation = buildAndroidHelperPresentationInput(data, nodes, options);
  const prefix = formatSnapshotMetaPrefix(data);
  const notices = buildSnapshotNotices(data, nodes, options, helperPresentation);
  const noticesBlock = notices.length > 0 ? `${notices.join('\n')}\n` : '';
  const unchanged = options.raw ? null : readUnchangedSnapshot(data);
  if (unchanged) {
    return `${prefix}${noticesBlock}${formatUnchangedSnapshotText(unchanged)}\n`;
  }
  const visiblePresentation =
    options.raw || !useMobilePresentation
      ? null
      : buildMobileSnapshotPresentation(helperPresentation.nodes);
  const truncated = Boolean(data.truncated);
  const displayedNodes = visiblePresentation?.nodes ?? nodes;
  const visibility =
    options.raw || !useMobilePresentation
      ? null
      : readSnapshotVisibility(
          data,
          visiblePresentation,
          displayedNodes.length,
          nodes.length,
          helperPresentation.filteredCount,
        );
  const header = formatSnapshotHeader(nodes.length, visibility, truncated);
  if (nodes.length === 0) {
    return `${prefix}${header}\n${noticesBlock}`;
  }
  if (options.raw) {
    return `${prefix}${header}\n${noticesBlock}${formatRawSnapshotLines(nodes)}\n`;
  }
  if (options.flatten) {
    return `${prefix}${header}\n${noticesBlock}${formatFlattenedSnapshotLines(displayedNodes)}${formatSnapshotSummaryBlock(visiblePresentation)}\n`;
  }
  return `${prefix}${header}\n${noticesBlock}${formatStructuredSnapshotLines(displayedNodes)}${formatSnapshotSummaryBlock(visiblePresentation)}\n`;
}

function readUnchangedSnapshot(data: Record<string, unknown>): SnapshotUnchanged | null {
  const raw = data.unchanged;
  if (!raw || typeof raw !== 'object') return null;
  const unchanged = raw as Record<string, unknown>;
  if (typeof unchanged.ageMs !== 'number' || typeof unchanged.nodeCount !== 'number') {
    return null;
  }
  return {
    ageMs: unchanged.ageMs,
    nodeCount: unchanged.nodeCount,
    interactiveOnly: unchanged.interactiveOnly === true ? true : undefined,
    scope: typeof unchanged.scope === 'string' ? unchanged.scope : undefined,
  };
}

function formatUnchangedSnapshotText(unchanged: SnapshotUnchanged): string {
  const age = formatSnapshotAge(unchanged.ageMs);
  if (unchanged.scope) {
    return [
      `Scoped snapshot unchanged for scope "${unchanged.scope}" since previous read ${age} ago.`,
      'Previous refs in this scope remain valid. Use find/get/is for a targeted query, or --force-full to re-emit.',
    ].join('\n');
  }
  if (unchanged.interactiveOnly) {
    return [
      `Interactive snapshot unchanged since previous read ${age} ago.`,
      `${unchanged.nodeCount} visible nodes are unchanged. Previous @e refs are still valid. Use find/get/is for a targeted query, or --force-full to re-emit.`,
    ].join('\n');
  }
  return [
    `Snapshot unchanged since previous read ${age} ago.`,
    'Refs from the previous snapshot are still valid. Use --force-full to re-emit the tree, or use find/get/is for a targeted query.',
  ].join('\n');
}

function formatSnapshotAge(ageMs: number): string {
  if (ageMs < 1000) return `${Math.round(ageMs)}ms`;
  if (ageMs < 60_000) return `${(Math.round(ageMs / 100) / 10).toFixed(1)}s`;
  const minutes = ageMs / 60_000;
  if (minutes < 60) return `${(Math.round(minutes * 10) / 10).toFixed(1)}m`;
  const hours = minutes / 60;
  return `${(Math.round(hours * 10) / 10).toFixed(1)}h`;
}

function formatSnapshotMetaPrefix(data: Record<string, unknown>): string {
  const appName = typeof data.appName === 'string' ? data.appName : undefined;
  const appBundleId = typeof data.appBundleId === 'string' ? data.appBundleId : undefined;
  const meta: string[] = [];
  if (appName) meta.push(`Page: ${appName}`);
  if (appBundleId) meta.push(`App: ${appBundleId}`);
  return meta.length > 0 ? `${meta.join('\n')}\n` : '';
}

function formatSnapshotHeader(
  nodeCount: number,
  visibility: SnapshotVisibility | null,
  truncated: boolean,
): string {
  const suffix = truncated ? ' (truncated)' : '';
  if (!visibility?.partial) {
    return `Snapshot: ${nodeCount} nodes${suffix}`;
  }
  if (visibility.totalNodeCount > visibility.visibleNodeCount) {
    return `Snapshot: ${visibility.visibleNodeCount} visible nodes (${visibility.totalNodeCount} total)${suffix}`;
  }
  return `Snapshot: ${visibility.visibleNodeCount} visible nodes${suffix}`;
}

function formatRawSnapshotLines(nodes: SnapshotNode[]): string {
  return nodes.map((node) => JSON.stringify(node)).join('\n');
}

function formatFlattenedSnapshotLines(nodes: SnapshotNode[]): string {
  return buildFlattenedSnapshotDisplayLines(nodes).join('\n');
}

function formatStructuredSnapshotLines(nodes: SnapshotNode[]): string {
  return renderSnapshotDisplayLines(
    buildSnapshotDisplayLines(nodes, { summarizeTextSurfaces: true }),
  ).join('\n');
}

function formatSnapshotSummaryBlock(
  visiblePresentation: ReturnType<typeof buildMobileSnapshotPresentation> | null,
): string {
  return visiblePresentation && visiblePresentation.summaryLines.length > 0
    ? `\n${visiblePresentation.summaryLines.join('\n')}`
    : '';
}

function readSnapshotVisibility(
  data: Record<string, unknown>,
  visiblePresentation: ReturnType<typeof buildMobileSnapshotPresentation> | null,
  displayedNodeCount: number,
  totalNodeCount: number,
  filteredCount: number = 0,
): SnapshotVisibility | null {
  const payloadVisibility = readPayloadSnapshotVisibility(data);
  if (filteredCount === 0 && payloadVisibility) {
    return payloadVisibility;
  }

  const hiddenCount = (visiblePresentation?.hiddenCount ?? 0) + filteredCount;
  const hasExplicitHiddenContentHints = visiblePresentation
    ? visiblePresentation.nodes.some((node) => node.hiddenContentAbove || node.hiddenContentBelow)
    : false;
  if (hiddenCount > 0) {
    return {
      partial: true,
      visibleNodeCount: displayedNodeCount,
      totalNodeCount: Math.max(totalNodeCount, payloadVisibility?.totalNodeCount ?? totalNodeCount),
      reasons: uniqueSnapshotVisibilityReasons([
        ...(payloadVisibility?.reasons ?? []),
        'offscreen-nodes',
      ]),
    };
  }
  if (payloadVisibility) {
    return payloadVisibility;
  }
  if (hasExplicitHiddenContentHints) {
    return {
      partial: true,
      visibleNodeCount: displayedNodeCount,
      totalNodeCount: displayedNodeCount,
      reasons: [],
    };
  }
  return null;
}

function readPayloadSnapshotVisibility(data: Record<string, unknown>): SnapshotVisibility | null {
  const candidate = data.visibility;
  if (!candidate || typeof candidate !== 'object') return null;
  const visibility = candidate as Partial<SnapshotVisibility>;
  if (
    typeof visibility.partial !== 'boolean' ||
    typeof visibility.visibleNodeCount !== 'number' ||
    typeof visibility.totalNodeCount !== 'number' ||
    !Array.isArray(visibility.reasons)
  ) {
    return null;
  }
  return {
    partial: visibility.partial,
    visibleNodeCount: visibility.visibleNodeCount,
    totalNodeCount: visibility.totalNodeCount,
    reasons: visibility.reasons.filter(
      (reason): reason is SnapshotVisibility['reasons'][number] => typeof reason === 'string',
    ),
  };
}

function uniqueSnapshotVisibilityReasons(
  reasons: SnapshotVisibility['reasons'],
): SnapshotVisibility['reasons'] {
  return [...new Set(reasons)];
}

function buildSnapshotNotices(
  data: Record<string, unknown>,
  nodes: SnapshotNode[],
  options: SnapshotTextOptions,
  helperPresentation: AndroidHelperPresentationInput = { nodes, filteredCount: 0 },
): string[] {
  const notices = [...readSnapshotWarnings(data), ...fallbackScreenshotNotices(data)];
  // The structured snapshot quality verdict already carries a sharper version of this hint.
  if (shouldRenderLegacySparseSnapshotHint(data)) {
    const sparseSnapshotHint = formatSparseSnapshotHint(nodes, options);
    if (sparseSnapshotHint) notices.push(sparseSnapshotHint);
  }
  if (!options.raw && helperPresentation.filteredCount > 0) {
    notices.push(
      `Collapsed ${helperPresentation.filteredCount} Android helper node${helperPresentation.filteredCount === 1 ? '' : 's'} from the agent-facing text snapshot; use --raw or --json for the full hierarchy.`,
    );
  }
  const repeatedNavNodes = helperPresentation.filteredCount > 0 ? helperPresentation.nodes : nodes;
  if (!options.raw && detectPossibleRepeatedNavSubtree(repeatedNavNodes)) {
    notices.push('Warning: possible repeated nav subtree detected.');
  }
  return notices;
}

function fallbackScreenshotNotices(data: Record<string, unknown>): string[] {
  const fallbackPath = data.fallbackScreenshotPath;
  return typeof fallbackPath === 'string' && fallbackPath.length > 0
    ? [`Captured a screenshot of this screen automatically as visual truth: ${fallbackPath}`]
    : [];
}

function shouldRenderLegacySparseSnapshotHint(data: Record<string, unknown>): boolean {
  return !data.snapshotQuality && !isWebSnapshotData(data);
}

function isWebSnapshotData(data: Record<string, unknown>): boolean {
  const diagnostics = data.snapshotDiagnostics;
  if (!diagnostics || typeof diagnostics !== 'object') return false;
  const stats = (diagnostics as { stats?: unknown }).stats;
  return Boolean(
    stats && typeof stats === 'object' && (stats as { platform?: unknown }).platform === 'web',
  );
}

function formatSparseSnapshotHint(
  nodes: SnapshotNode[],
  options: Pick<SnapshotTextOptions, 'scoped' | 'depthLimited'>,
): string | null {
  if (options.scoped === true || options.depthLimited === true || nodes.length > 3) return null;
  const noun = nodes.length === 1 ? 'node' : 'nodes';
  return `Hint: sparse accessibility snapshot returned ${nodes.length} ${noun}; snapshot state is invalid or unavailable for this screen. Use plain screenshot, not screenshot --overlay-refs, as visual truth. If screenshot shows the Home Screen or another app, run open for this app again first. Then navigate away with coordinates if needed and retry snapshot -i on the next screen.`;
}

export function readSnapshotWarnings(data: Record<string, unknown>): string[] {
  const rawWarnings = data.warnings;
  if (!Array.isArray(rawWarnings)) {
    return [];
  }
  return rawWarnings.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
}

type SnapshotDisplayLine = ReturnType<typeof buildSnapshotDisplayLines>[number];

function renderSnapshotDisplayLines(lines: ReturnType<typeof buildSnapshotDisplayLines>): string[] {
  const output: string[] = [];
  const pendingBelow: SnapshotDisplayLine[] = [];
  const lineNodesByIndex = new Map(lines.map((line) => [line.node.index, line.node]));
  const flushClosedBelowHints = (nextLine?: SnapshotDisplayLine) => {
    while (
      pendingBelow.length > 0 &&
      (!nextLine ||
        isOutsideHiddenContentContainer(nextLine, pendingBelow.at(-1)!, lineNodesByIndex))
    ) {
      output.push(...readHiddenContentHintLines(pendingBelow.pop()!, 'below'));
    }
  };

  for (const line of lines) {
    flushClosedBelowHints(line);
    output.push(line.text);
    output.push(...readHiddenContentHintLines(line, 'above'));
    if (line.node.hiddenContentBelow) {
      pendingBelow.push(line);
    }
  }
  flushClosedBelowHints();
  return output;
}

function isOutsideHiddenContentContainer(
  line: SnapshotDisplayLine,
  containerLine: SnapshotDisplayLine,
  lineNodesByIndex: Map<number, SnapshotNode>,
): boolean {
  if (isDescendantOfRenderedLine(line.node, containerLine.node, lineNodesByIndex)) {
    return false;
  }
  return line.depth <= containerLine.depth;
}

function isDescendantOfRenderedLine(
  node: SnapshotNode,
  ancestor: SnapshotNode,
  lineNodesByIndex: Map<number, SnapshotNode>,
): boolean {
  let current = node;
  while (typeof current.parentIndex === 'number') {
    if (current.parentIndex === ancestor.index) return true;
    const parent = lineNodesByIndex.get(current.parentIndex);
    if (!parent) return false;
    current = parent;
  }
  return false;
}

function buildFlattenedSnapshotDisplayLines(nodes: SnapshotNode[]): string[] {
  // Flattened output has no subtree boundary to defer below-hints past.
  return buildSnapshotDisplayLines(nodes, { summarizeTextSurfaces: true }).flatMap((line) => [
    formatSnapshotLine(line.node, 0, false, line.type, { summarizeTextSurfaces: true }),
    ...readHiddenContentHintLines({ ...line, depth: 0 }),
  ]);
}

function readHiddenContentHintLines(
  line: SnapshotDisplayLine,
  direction?: 'above' | 'below',
): string[] {
  const target = hintTargetLabel(line.type);
  if (!target) {
    return [];
  }
  const hints: string[] = [];
  if (line.node.hiddenContentAbove && direction !== 'below') {
    hints.push(`[content above ${target} hidden]`);
  }
  if (line.node.hiddenContentBelow && direction !== 'above') {
    hints.push(`[content below ${target} hidden]`);
  }
  if (hints.length === 0) {
    return [];
  }
  const indent = '  '.repeat(line.depth + 1);
  return hints.map((hint) => `${indent}${hint}`);
}

function hintTargetLabel(type: string): string | null {
  if (type === 'scroll-area' || type === 'list' || type === 'collection' || type === 'table') {
    return type;
  }
  return null;
}
