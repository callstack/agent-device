import path from 'node:path';
import {
  buildAndroidHelperPresentationInput,
  type AndroidHelperPresentationInput,
} from './android-helper-snapshot-presentation.ts';
import { AppError, normalizeError, type NormalizedError } from '../kernel/errors.ts';
import { detectPossibleRepeatedNavSubtree } from './repeated-nav-subtree.ts';
import { buildSnapshotDisplayLines, formatSnapshotLine } from '../snapshot/snapshot-lines.ts';
import {
  isSnapshotBackend,
  usesMobileSnapshotPresentation,
  type Rect,
  type SnapshotNode,
  type SnapshotUnchanged,
  type SnapshotVisibility,
} from '../kernel/snapshot.ts';
import type { MovementRange } from '../screenshot-diff/screenshot-diff-ocr.ts';
import type { ScreenshotDiffResult } from '../screenshot-diff/screenshot-diff.ts';
import type { ScreenshotDiffRegion } from '../screenshot-diff/screenshot-diff-regions.ts';
import { styleText } from 'node:util';
import { buildMobileSnapshotPresentation } from '../snapshot/mobile-snapshot-semantics.ts';

type JsonResult =
  | { success: true; data?: unknown }
  | {
      success: false;
      error: NormalizedError;
    };

export function printJson(result: JsonResult): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export function printHumanError(
  err: AppError | NormalizedError,
  options: { showDetails?: boolean } = {},
): void {
  const normalized = err instanceof AppError ? normalizeError(err) : err;
  process.stderr.write(`Error (${normalized.code}): ${normalized.message}\n`);
  if (normalized.hint) {
    process.stderr.write(`Hint: ${normalized.hint}\n`);
  }
  if (normalized.diagnosticId) {
    process.stderr.write(`Diagnostic ID: ${normalized.diagnosticId}\n`);
  }
  if (normalized.logPath) {
    process.stderr.write(`Diagnostics Log: ${normalized.logPath}\n`);
  }
  if (options.showDetails && normalized.details) {
    process.stderr.write(`${JSON.stringify(normalized.details, null, 2)}\n`);
  }
}

type SnapshotDiffLine = {
  kind?: 'added' | 'removed' | 'unchanged';
  text?: string;
};

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

export function formatSnapshotDiffText(data: Record<string, unknown>): string {
  const baselineInitialized = data.baselineInitialized === true;
  const summaryRaw = (data.summary ?? {}) as Record<string, unknown>;
  const additions = toNumber(summaryRaw.additions);
  const removals = toNumber(summaryRaw.removals);
  const unchanged = toNumber(summaryRaw.unchanged);
  const useColor = supportsColor();
  const notices = readSnapshotWarnings(data);
  const noticesBlock = notices.length > 0 ? `${notices.join('\n')}\n` : '';
  if (baselineInitialized) {
    return `${noticesBlock}Baseline initialized (${unchanged} lines).\n`;
  }
  const rawLines = Array.isArray(data.lines) ? (data.lines as SnapshotDiffLine[]) : [];
  const contextLines = applyContextWindow(rawLines, 1);
  const lines = contextLines.map((line) => {
    const text = typeof line.text === 'string' ? line.text : '';
    if (line.kind === 'added') {
      const prefix = text.startsWith(' ') ? `+${text}` : `+ ${text}`;
      return useColor ? colorize(prefix, 'green') : prefix;
    }
    if (line.kind === 'removed') {
      const prefix = text.startsWith(' ') ? `-${text}` : `- ${text}`;
      return useColor ? colorize(prefix, 'red') : prefix;
    }
    return useColor ? colorize(text, 'dim') : text;
  });
  const body = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  if (!useColor) {
    return `${noticesBlock}${body}${additions} additions, ${removals} removals, ${unchanged} unchanged\n`;
  }
  const summary = [
    `${colorize(String(additions), 'green')} additions`,
    `${colorize(String(removals), 'red')} removals`,
    `${colorize(String(unchanged), 'dim')} unchanged`,
  ].join(', ');
  return `${noticesBlock}${body}${summary}\n`;
}

export function formatScreenshotDiffText(data: ScreenshotDiffResult): string {
  const useColor = supportsColor();
  const match = data.match === true;
  const dimensionMismatch = data.dimensionMismatch;

  const lines: string[] = [];
  lines.push(...formatScreenshotDiffStatusLines(data, useColor));
  lines.push(...formatScreenshotDiffArtifactLines(data, match, useColor));

  if (!match && !dimensionMismatch) {
    lines.push(...formatScreenshotDiffPixelCountLines(data, useColor));
    lines.push(...formatScreenshotDiffHintLines(data, useColor));
    lines.push(...formatScreenshotDiffRegionLines(data, useColor));
    lines.push(...formatScreenshotDiffOcrLines(data, useColor));
    lines.push(...formatScreenshotDiffNonTextLines(data, useColor));
  }

  return `${lines.join('\n')}\n`;
}

function formatScreenshotDiffStatusLines(data: ScreenshotDiffResult, useColor: boolean): string[] {
  if (data.match === true) {
    const indicator = useColor ? colorize('✓', 'green') : '✓';
    return [`${indicator} Screenshots match.`];
  }

  const dimensionMismatch = data.dimensionMismatch;
  const indicator = useColor ? colorize('✗', 'red') : '✗';
  if (dimensionMismatch) {
    const expected = dimensionMismatch.expected;
    const actual = dimensionMismatch.actual;
    return [
      `${indicator} Screenshots have different dimensions: ` +
        `expected ${expected?.width}x${expected?.height}, ` +
        `got ${actual?.width}x${actual?.height}`,
    ];
  }

  const differentPixels = toNumber(data.differentPixels);
  const mismatchPercentage = toNumber(data.mismatchPercentage);
  const pctLabel =
    mismatchPercentage === 0 && differentPixels > 0 ? '<0.01' : String(mismatchPercentage);
  const summary = `${pctLabel}% pixels differ`;
  return [`${indicator} ${useColor ? colorize(summary, 'red') : summary}`];
}

function formatScreenshotDiffArtifactLines(
  data: ScreenshotDiffResult,
  match: boolean,
  useColor: boolean,
): string[] {
  if (match) return [];

  const lines: string[] = [];
  if (data.diffPath) {
    const relativePath = toRelativePath(data.diffPath);
    const label = useColor ? colorize('Diff image:', 'dim') : 'Diff image:';
    const displayPath = useColor ? colorize(relativePath, 'green') : relativePath;
    lines.push(`  ${label} ${displayPath}`);
  }

  if (data.currentOverlayPath) {
    const relativePath = toRelativePath(data.currentOverlayPath);
    const label = useColor ? colorize('Current overlay:', 'dim') : 'Current overlay:';
    const displayPath = useColor ? colorize(relativePath, 'green') : relativePath;
    const refCount = toNumber(data.currentOverlayRefCount);
    const refSuffix = refCount > 0 ? ` (${refCount} refs)` : '';
    lines.push(`  ${label} ${displayPath}${refSuffix}`);
  }

  return lines;
}

function formatScreenshotDiffPixelCountLines(
  data: ScreenshotDiffResult,
  useColor: boolean,
): string[] {
  const differentPixels = toNumber(data.differentPixels);
  const totalPixels = toNumber(data.totalPixels);
  const diffCount = useColor ? colorize(String(differentPixels), 'red') : String(differentPixels);
  return [`  ${diffCount} different / ${totalPixels} total pixels`];
}

function formatScreenshotDiffHintLines(data: ScreenshotDiffResult, useColor: boolean): string[] {
  const hints = formatScreenshotDiffHints(data);
  if (hints.length === 0) return [];
  return [`  ${formatMuted('Hints:', useColor)}`, ...hints.map((hint) => `    - ${hint}`)];
}

function formatScreenshotDiffRegionLines(data: ScreenshotDiffResult, useColor: boolean): string[] {
  const regions = Array.isArray(data.regions) ? data.regions : [];
  if (regions.length === 0) return [];

  const lines = [`  ${formatMuted('Changed regions:', useColor)}`];
  for (const region of regions.slice(0, 5)) {
    lines.push(...formatScreenshotDiffRegionEntryLines(region));
  }
  return lines;
}

function formatScreenshotDiffRegionEntryLines(region: ScreenshotDiffRegion): string[] {
  const share =
    region.shareOfDiffPercentage === 0 && region.differentPixels > 0
      ? '<0.01'
      : String(region.shareOfDiffPercentage);
  const rect = region.rect;
  const lines = [
    `    ${region.index}. ${region.location} x=${rect.x} y=${rect.y} ` +
      `${rect.width}x${rect.height}, ${share}% of diff, change=${region.dominantChange}`,
  ];

  const detailLine = formatScreenshotRegionDetails(region);
  if (detailLine) {
    lines.push(`       ${detailLine}`);
  }

  const bestMatch = region.currentOverlayMatches?.[0];
  if (bestMatch) {
    const label = bestMatch.label ? ` "${bestMatch.label}"` : '';
    lines.push(
      `       overlaps @${bestMatch.ref}${label}, ` +
        `${bestMatch.regionCoveragePercentage}% of region`,
    );
  }

  return lines;
}

function formatScreenshotDiffOcrLines(data: ScreenshotDiffResult, useColor: boolean): string[] {
  const ocrMatches = data.ocr?.matches ?? [];
  if (ocrMatches.length === 0) return [];

  const shownOcrMatches = ocrMatches.slice(0, 8);
  const lines = [
    `  ${formatMuted(
      `OCR text deltas (${data.ocr?.provider}; baselineBlocks=${data.ocr?.baselineBlocks} ` +
        `currentBlocks=${data.ocr?.currentBlocks}; showing ${shownOcrMatches.length}/${ocrMatches.length}; px):`,
      useColor,
    )}`,
    `    ${formatMuted(
      'item | text | movePx | sizeDeltaPx | bboxBaseline | bboxCurrent | confidence | issueHint',
      useColor,
    )}`,
  ];

  for (const [index, ocrMatch] of shownOcrMatches.entries()) {
    const delta = ocrMatch.delta;
    lines.push(
      `    ${index + 1} | ${JSON.stringify(ocrMatch.text)} | ` +
        `${formatSignedPixels(delta.x)},${formatSignedPixels(delta.y)} | ` +
        `${formatSignedPixels(delta.width)},${formatSignedPixels(delta.height)} | ` +
        `${formatRect(ocrMatch.baselineRect)} | ${formatRect(ocrMatch.currentRect)} | ` +
        `${ocrMatch.confidence} | ` +
        `${ocrMatch.possibleTextMetricMismatch ? 'ocr-bbox-size-change' : '-'}`,
    );
  }

  return lines;
}

function formatScreenshotDiffNonTextLines(data: ScreenshotDiffResult, useColor: boolean): string[] {
  const nonTextDeltas = data.nonTextDeltas ?? [];
  if (nonTextDeltas.length === 0) return [];

  const shownNonTextDeltas = nonTextDeltas.slice(0, 8);
  const lines = [
    `  ${formatMuted(
      `Non-text visual deltas (showing ${shownNonTextDeltas.length}/${nonTextDeltas.length}; px):`,
      useColor,
    )}`,
    `    ${formatMuted('item | region | slot | kind | bboxCurrent | nearestText', useColor)}`,
  ];

  for (const delta of shownNonTextDeltas) {
    lines.push(
      `    ${delta.index} | ${delta.regionIndex ? `r${delta.regionIndex}` : '-'} | ` +
        `${delta.slot} | ${delta.likelyKind} | ${formatRect(delta.rect)} | ` +
        `${delta.nearestText ? JSON.stringify(delta.nearestText) : '-'}`,
    );
  }

  return lines;
}

function formatRect(rect: Rect): string {
  return `x=${rect.x},y=${rect.y},w=${rect.width},h=${rect.height}`;
}

function formatSignedPixels(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function formatScreenshotDiffHints(data: ScreenshotDiffResult): string[] {
  const hints: string[] = [];
  const clusters = data.ocr?.movementClusters ?? [];
  for (const cluster of clusters.slice(0, 2)) {
    hints.push(
      `text movement cluster: ${formatQuotedList(cluster.texts)} dx=${formatRange(cluster.xRange)}px ` +
        `dy=${formatRange(cluster.yRange)}px`,
    );
  }

  const controlDeltas = (data.nonTextDeltas ?? [])
    .filter((delta) => ['icon', 'toggle', 'chevron'].includes(delta.likelyKind))
    .slice(0, 3);
  if (controlDeltas.length > 0) {
    hints.push(`non-text controls: ${controlDeltas.map(formatNonTextHint).join('; ')}`);
  }

  const boundaryDeltas = (data.nonTextDeltas ?? [])
    .filter((delta) => delta.likelyKind === 'separator')
    .slice(0, 2);
  if (boundaryDeltas.length > 0) {
    hints.push(`non-text boundaries: ${boundaryDeltas.map(formatNonTextHint).join('; ')}`);
  }

  return hints.slice(0, 6);
}

function formatNonTextHint(delta: {
  likelyKind: string;
  nearestText?: string;
  regionIndex?: number;
}): string {
  const anchor = delta.nearestText ? ` near ${JSON.stringify(delta.nearestText)}` : '';
  const region = delta.regionIndex ? ` r${delta.regionIndex}` : '';
  return `${delta.likelyKind}${anchor}${region}`;
}

function formatRange(range: MovementRange): string {
  return range.min === range.max
    ? formatSignedPixels(range.min)
    : `${formatSignedPixels(range.min)}..${formatSignedPixels(range.max)}`;
}

function formatQuotedList(values: string[]): string {
  const shown = values.slice(0, 4).map((value) => JSON.stringify(value));
  const suffix = values.length > shown.length ? ` +${values.length - shown.length} more` : '';
  return `${shown.join(', ')}${suffix}`;
}

function formatScreenshotRegionDetails(region: ScreenshotDiffRegion): string | null {
  const details = [
    region.size ? `size=${region.size}` : null,
    region.shape ? `shape=${region.shape}` : null,
    typeof region.densityPercentage === 'number' ? `density=${region.densityPercentage}%` : null,
    region.averageBaselineColorHex && region.averageCurrentColorHex
      ? `avgColor=${region.averageBaselineColorHex}->${region.averageCurrentColorHex}`
      : null,
    typeof region.baselineLuminance === 'number' && typeof region.currentLuminance === 'number'
      ? `luminance=${region.baselineLuminance}->${region.currentLuminance}`
      : null,
  ].filter((entry): entry is string => entry !== null);
  return details.length > 0 ? details.join(' ') : null;
}

function toRelativePath(filePath: string): string {
  const cwd = process.cwd();
  const relativePath = path.relative(cwd, filePath);
  if (relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))) {
    return relativePath === '' ? '.' : `.${path.sep}${relativePath}`;
  }
  return filePath;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function applyContextWindow(lines: SnapshotDiffLine[], contextWindow: number): SnapshotDiffLine[] {
  if (lines.length === 0) return lines;
  const changedIndices = lines
    .map((line, index) => ({ index, kind: line.kind }))
    .filter((entry) => entry.kind === 'added' || entry.kind === 'removed')
    .map((entry) => entry.index);
  if (changedIndices.length === 0) return lines;

  const keep = new Array<boolean>(lines.length).fill(false);
  for (const index of changedIndices) {
    const start = Math.max(0, index - contextWindow);
    const end = Math.min(lines.length - 1, index + contextWindow);
    for (let i = start; i <= end; i += 1) {
      keep[i] = true;
    }
  }
  return lines.filter((_, index) => keep[index]);
}

export function supportsColor(stream: { isTTY?: boolean } = process.stdout): boolean {
  const forceColor = process.env.FORCE_COLOR;
  if (typeof forceColor === 'string') {
    return forceColor !== '0';
  }
  if (typeof process.env.NO_COLOR === 'string') {
    return false;
  }
  return Boolean(stream.isTTY);
}

export function colorize(
  text: string,
  format: Parameters<typeof styleText>[0],
  options?: Parameters<typeof styleText>[2],
): string {
  return styleText(format, text, options);
}

function formatMuted(text: string, useColor: boolean): string {
  return useColor ? colorize(text, 'dim') : text;
}

function buildSnapshotNotices(
  data: Record<string, unknown>,
  nodes: SnapshotNode[],
  options: SnapshotTextOptions,
  helperPresentation: AndroidHelperPresentationInput = { nodes, filteredCount: 0 },
): string[] {
  const notices = readSnapshotWarnings(data);
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

function readSnapshotWarnings(data: Record<string, unknown>): string[] {
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
        isOutsideHiddenContentContainer(
          nextLine,
          pendingBelow[pendingBelow.length - 1]!,
          lineNodesByIndex,
        ))
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
