import { AppError } from '../../kernel/errors.ts';
import { roundPercent } from '../perf-utils.ts';
import { parseNumericToken } from './perf-parsing.ts';
import {
  buildWorstFrameDropWindows,
  deriveFrameDeadlineNs,
  roundOneDecimal,
  selectDroppedFrameRows,
  type AndroidFrameDropWindow,
  type AndroidFrameStatsRow,
} from './perf-frame-analysis.ts';

export type { AndroidFrameDropWindow } from './perf-frame-analysis.ts';

export const ANDROID_FRAME_SAMPLE_METHOD = 'adb-shell-dumpsys-gfxinfo-framestats';
export const ANDROID_FRAME_SAMPLE_DESCRIPTION =
  'Rendered-frame health from the current adb shell dumpsys gfxinfo <package> framestats window. Dropped frames use Android gfxinfo janky-frame/frame-deadline data when available; this is not video recording FPS.';

type AndroidFrameSummary = {
  droppedFramePercent: number;
  droppedFrameCount: number;
  totalFrameCount: number;
  sampleWindowMs?: number;
  uptimeMs?: number;
  statsSinceNs?: number;
};

type AndroidFrameCounts = {
  droppedFramePercent: number;
  droppedFrameCount: number;
  totalFrameCount: number;
};

type AndroidFrameTiming = {
  sampleWindowMs?: number;
  windowStartNs?: number;
  windowStartedAt?: string;
  windowEndedAt?: string;
  timestampSource?: 'estimated-from-device-uptime';
};

export type AndroidFramePerfSample = {
  droppedFramePercent: number;
  droppedFrameCount: number;
  totalFrameCount: number;
  sampleWindowMs?: number;
  frameDeadlineMs?: number;
  refreshRateHz?: number;
  windowStartedAt?: string;
  windowEndedAt?: string;
  timestampSource?: 'estimated-from-device-uptime';
  measuredAt: string;
  method: typeof ANDROID_FRAME_SAMPLE_METHOD;
  source: 'android-gfxinfo-summary' | 'framestats-rows';
  worstWindows?: AndroidFrameDropWindow[];
};

export function parseAndroidFramePerfSample(
  stdout: string,
  packageName: string,
  measuredAt: string,
): AndroidFramePerfSample {
  assertAndroidGfxInfoProcessFound(stdout, packageName);
  const summary = parseAndroidFrameSummary(stdout);
  const frames = parseAndroidFrameStatsRows(stdout);
  const frameDeadlineNs = readAndroidFrameDeadlineNs(frames, summary, packageName);
  const measuredAtMs = Date.parse(measuredAt);
  const timing = buildAndroidFrameTiming({
    frames,
    measuredAtMs,
    summary,
  });
  const droppedFrames = selectDroppedFrameRows({
    frames,
    frameDeadlineNs,
    summaryDroppedFrameCount: summary?.droppedFrameCount,
  });
  const sampleWindowMs =
    summary?.sampleWindowMs ?? timing.sampleWindowMs ?? computeFrameWindowMs(frames);
  const counts = buildAndroidFrameCounts(summary, frames, droppedFrames);
  const worstWindows = buildAndroidWorstWindows({
    droppedFrames,
    timing,
    measuredAtMs,
    summary,
  });

  return {
    ...counts,
    sampleWindowMs,
    ...buildAndroidFrameRateFields(frameDeadlineNs),
    windowStartedAt: timing.windowStartedAt,
    windowEndedAt: timing.windowEndedAt,
    timestampSource: timing.timestampSource,
    measuredAt,
    method: ANDROID_FRAME_SAMPLE_METHOD,
    source: summary ? 'android-gfxinfo-summary' : 'framestats-rows',
    worstWindows: worstWindows && worstWindows.length > 0 ? worstWindows : undefined,
  };
}

function assertAndroidGfxInfoProcessFound(stdout: string, packageName: string): void {
  if (!/no process found for:/i.test(stdout)) return;
  throw new AppError(
    'COMMAND_FAILED',
    `Android gfxinfo did not find a running process for ${packageName}`,
    {
      metric: 'fps',
      package: packageName,
      hint: 'Run open <app> for this session again to ensure the Android app is active, then retry perf after the interaction you want to inspect.',
    },
  );
}

function throwFrameParseError(packageName: string): never {
  throw new AppError(
    'COMMAND_FAILED',
    `Failed to parse Android framestats output for ${packageName}`,
    {
      metric: 'fps',
      package: packageName,
      hint: 'Retry perf after exercising the app screen. If the problem persists, capture adb shell dumpsys gfxinfo <package> framestats output for debugging.',
    },
  );
}

function readAndroidFrameDeadlineNs(
  frames: AndroidFrameStatsRow[],
  summary: AndroidFrameSummary | undefined,
  packageName: string,
): number | undefined {
  const frameDeadlineNs = deriveFrameDeadlineNs(frames);
  if (!summary && frames.length === 0) {
    throwFrameParseError(packageName);
  }
  if (summary || frameDeadlineNs !== undefined) return frameDeadlineNs;
  throw new AppError(
    'COMMAND_FAILED',
    `Failed to infer Android frame deadline from framestats output for ${packageName}`,
    {
      metric: 'fps',
      package: packageName,
      hint: 'Retry perf after a longer interaction window so consecutive Android frame timestamps are available.',
    },
  );
}

function buildAndroidFrameCounts(
  summary: AndroidFrameSummary | undefined,
  frames: AndroidFrameStatsRow[],
  droppedFrames: AndroidFrameStatsRow[],
): AndroidFrameCounts {
  const totalFrameCount = summary?.totalFrameCount ?? frames.length;
  const droppedFrameCount = summary?.droppedFrameCount ?? droppedFrames.length;
  return {
    totalFrameCount,
    droppedFrameCount,
    droppedFramePercent:
      summary?.droppedFramePercent ??
      (totalFrameCount > 0 ? roundPercent((droppedFrameCount / totalFrameCount) * 100) : 0),
  };
}

function buildAndroidFrameRateFields(
  frameDeadlineNs: number | undefined,
): Pick<AndroidFramePerfSample, 'frameDeadlineMs' | 'refreshRateHz'> {
  return {
    frameDeadlineMs:
      frameDeadlineNs === undefined ? undefined : roundOneDecimal(frameDeadlineNs / 1_000_000),
    refreshRateHz:
      frameDeadlineNs === undefined ? undefined : roundOneDecimal(1_000_000_000 / frameDeadlineNs),
  };
}

function buildAndroidWorstWindows(options: {
  droppedFrames: AndroidFrameStatsRow[];
  timing: AndroidFrameTiming;
  measuredAtMs: number;
  summary?: AndroidFrameSummary;
}): AndroidFrameDropWindow[] | undefined {
  const { droppedFrames, timing, measuredAtMs, summary } = options;
  if (droppedFrames.length === 0) return undefined;
  const worstWindows = buildWorstFrameDropWindows({
    frames: droppedFrames,
    windowStartNs: timing.windowStartNs,
    measuredAtMs,
    uptimeMs: summary?.uptimeMs,
  });
  return worstWindows.length > 0 ? worstWindows : undefined;
}

function parseAndroidFrameStatsRows(text: string): AndroidFrameStatsRow[] {
  const rows: AndroidFrameStatsRow[] = [];
  let columnIndex: Map<string, number> | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line === '---PROFILEDATA---') continue;

    const cells = line.split(',').map((cell) => cell.trim());
    if (isFrameStatsHeader(cells)) {
      columnIndex = new Map(cells.map((cell, index) => [cell, index]));
      continue;
    }
    const row = parseFrameStatsDataRow(cells, columnIndex);
    if (row) rows.push(row);
  }

  return rows.sort((left, right) => left.intendedVsyncNs - right.intendedVsyncNs);
}

function isFrameStatsHeader(cells: string[]): boolean {
  return cells.includes('IntendedVsync') && cells.includes('FrameCompleted');
}

function parseFrameStatsDataRow(
  cells: string[],
  columnIndex: Map<string, number> | null,
): AndroidFrameStatsRow | undefined {
  if (!columnIndex || cells.length < columnIndex.size) return undefined;
  const flags = readFrameStatsNumber(cells, columnIndex, 'Flags');
  const intendedVsyncNs = readFrameStatsNumber(cells, columnIndex, 'IntendedVsync');
  const frameCompletedNs = readFrameStatsNumber(cells, columnIndex, 'FrameCompleted');
  if (
    flags !== 0 ||
    intendedVsyncNs === null ||
    frameCompletedNs === null ||
    intendedVsyncNs <= 0 ||
    frameCompletedNs <= intendedVsyncNs
  ) {
    return undefined;
  }
  return {
    intendedVsyncNs,
    frameCompletedNs,
    durationNs: frameCompletedNs - intendedVsyncNs,
  };
}

function readFrameStatsNumber(
  cells: string[],
  columnIndex: Map<string, number>,
  column: string,
): number | null {
  const index = columnIndex.get(column);
  if (index === undefined) return null;
  const value = Number(cells[index]);
  return Number.isFinite(value) ? value : null;
}

// fallow-ignore-next-line complexity
function parseAndroidFrameSummary(text: string): AndroidFrameSummary | undefined {
  const summaryText = text.split(/\nProfile data in ms:\n/i)[0] ?? '';
  const totalFrameCount = matchSummaryInteger(summaryText, 'Total frames rendered');
  const jankyFrameMatch = summaryText.match(
    /^\s*Janky frames:\s*([0-9][0-9,]*)\s*\(([0-9.]+)%\)/im,
  );
  if (totalFrameCount === undefined || !jankyFrameMatch) return undefined;
  const droppedFrameToken = jankyFrameMatch[1];
  const droppedFramePercentToken = jankyFrameMatch[2];
  if (droppedFrameToken === undefined || droppedFramePercentToken === undefined) {
    return undefined;
  }

  const droppedFrameCount = parseNumericToken(droppedFrameToken) ?? undefined;
  const droppedFramePercent = Number(droppedFramePercentToken);
  if (
    droppedFrameCount === undefined ||
    !Number.isFinite(droppedFramePercent) ||
    totalFrameCount < 0
  ) {
    return undefined;
  }

  const uptimeMs = matchSummaryInteger(summaryText, 'Uptime');
  const statsSinceNs = matchSummaryInteger(summaryText, 'Stats since');
  return {
    droppedFramePercent: roundPercent(droppedFramePercent),
    droppedFrameCount,
    totalFrameCount,
    sampleWindowMs: parseAndroidFrameSummaryWindowMs({ uptimeMs, statsSinceNs }),
    uptimeMs,
    statsSinceNs,
  };
}

function parseAndroidFrameSummaryWindowMs(options: {
  uptimeMs?: number;
  statsSinceNs?: number;
}): number | undefined {
  const { uptimeMs, statsSinceNs } = options;
  if (uptimeMs === undefined || statsSinceNs === undefined) return undefined;
  const windowMs = uptimeMs - Math.round(statsSinceNs / 1_000_000);
  return windowMs >= 0 ? windowMs : undefined;
}

function buildAndroidFrameTiming(options: {
  frames: AndroidFrameStatsRow[];
  measuredAtMs: number;
  summary?: AndroidFrameSummary;
}): AndroidFrameTiming {
  const { frames, measuredAtMs, summary } = options;
  const bounds = computeFrameBounds(frames);
  const summaryStartNs = summary?.statsSinceNs;
  const windowStartNs = summaryStartNs ?? bounds.firstFrameNs;
  const rawSampleWindowMs = computeWindowDurationMs(windowStartNs, bounds.lastFrameNs);
  const sampleWindowMs = summary?.sampleWindowMs ?? rawSampleWindowMs;
  if (
    !Number.isFinite(measuredAtMs) ||
    summary?.uptimeMs === undefined ||
    windowStartNs === undefined
  ) {
    return { sampleWindowMs, windowStartNs };
  }

  const deviceBootWallClockMs = measuredAtMs - summary.uptimeMs;
  // Summary windows extend to the dumpsys read. The retained raw rows can end earlier.
  return {
    sampleWindowMs,
    windowStartNs,
    windowStartedAt: new Date(deviceBootWallClockMs + windowStartNs / 1_000_000).toISOString(),
    windowEndedAt: buildAndroidFrameWindowEnd({
      deviceBootWallClockMs,
      measuredAtMs,
      summaryStartNs,
      lastFrameNs: bounds.lastFrameNs,
    }),
    timestampSource: 'estimated-from-device-uptime',
  };
}

function computeFrameBounds(frames: AndroidFrameStatsRow[]): {
  firstFrameNs?: number;
  lastFrameNs?: number;
} {
  if (frames.length === 0) return {};
  return {
    firstFrameNs: Math.min(...frames.map((frame) => frame.intendedVsyncNs)),
    lastFrameNs: Math.max(...frames.map((frame) => frame.frameCompletedNs)),
  };
}

function computeWindowDurationMs(
  windowStartNs: number | undefined,
  windowEndNs: number | undefined,
): number | undefined {
  if (windowStartNs === undefined || windowEndNs === undefined) return undefined;
  return Math.max(0, Math.round((windowEndNs - windowStartNs) / 1_000_000));
}

function buildAndroidFrameWindowEnd(options: {
  deviceBootWallClockMs: number;
  measuredAtMs: number;
  summaryStartNs?: number;
  lastFrameNs?: number;
}): string | undefined {
  const { deviceBootWallClockMs, measuredAtMs, summaryStartNs, lastFrameNs } = options;
  if (summaryStartNs !== undefined) return new Date(measuredAtMs).toISOString();
  return lastFrameNs === undefined
    ? undefined
    : new Date(deviceBootWallClockMs + lastFrameNs / 1_000_000).toISOString();
}

function computeFrameWindowMs(frames: AndroidFrameStatsRow[]): number | undefined {
  if (frames.length === 0) return undefined;
  const bounds = computeFrameBounds(frames);
  return computeWindowDurationMs(bounds.firstFrameNs, bounds.lastFrameNs);
}

function matchSummaryInteger(text: string, label: string): number | undefined {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^\\s*${escapedLabel}:\\s*([0-9][0-9,]*)`, 'im'));
  if (!match) return undefined;
  const token = match[1];
  return token === undefined ? undefined : (parseNumericToken(token) ?? undefined);
}
