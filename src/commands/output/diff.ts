import path from 'node:path';
import { colorize, supportsColor } from './color.ts';
import { readSnapshotWarnings } from './snapshot.ts';
import type { ScreenshotDiffResult } from '../../screenshot-diff/screenshot-diff.ts';
import type { ScreenshotDiffRegion } from '../../screenshot-diff/screenshot-diff-regions.ts';
type SnapshotDiffLine = {
  kind?: 'added' | 'removed' | 'unchanged';
  text?: string;
};

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
    lines.push(...formatScreenshotDiffRegionLines(data, useColor));
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
    `    ${region.index}. x=${rect.x} y=${rect.y} ${rect.width}x${rect.height}, ` +
      `${share}% of diff`,
  ];

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

function formatMuted(text: string, useColor: boolean): string {
  return useColor ? colorize(text, 'dim') : text;
}
