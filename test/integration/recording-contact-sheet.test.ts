import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createIntegrationTestContext, type CliJsonResult } from './test-helpers.ts';

const recordingE2EEnabled = isTruthy(process.env.AGENT_DEVICE_RECORDING_E2E);

test(
  'record contact-sheet reads a live iOS simulator recording',
  {
    skip: shouldSkipContactSheetE2E(),
  },
  () => {
    const testName = 'record contact-sheet';
    const integration = createRecordingIntegrationContext('ios', testName);
    const videoPath = path.join(integration.artifactDir(), 'contact-sheet.mp4');
    const sheetPath = path.join(integration.artifactDir(), 'contact-sheet.png');
    const session = ['--session', 'recording-ios-contact-sheet'];
    const target = process.env.AGENT_DEVICE_IOS_UDID
      ? ['--udid', process.env.AGENT_DEVICE_IOS_UDID]
      : [];
    let recordingStarted = false;
    let recordingStopped = false;

    try {
      integration.runStep('open settings', [
        'open',
        'com.apple.Preferences',
        '--platform',
        'ios',
        '--relaunch',
        '--json',
        ...target,
        ...session,
      ]);
      integration.runStep('record start', [
        'record',
        'start',
        videoPath,
        '--json',
        ...target,
        ...session,
      ]);
      recordingStarted = true;
      integration.runStep('open general', [
        'click',
        'role=cell',
        'label=General',
        '--json',
        ...target,
        ...session,
      ]);
      integration.runStep('scroll down', [
        'scroll',
        'down',
        '0.6',
        '--json',
        ...target,
        ...session,
      ]);
      integration.runStep('go back', ['back', '--json', ...target, ...session]);
      const stop = integration.runStep('record stop', [
        'record',
        'stop',
        '--json',
        ...target,
        ...session,
      ]);
      recordingStopped = true;
      assert.equal(stop.json?.success, true, JSON.stringify(stop.json ?? stop.stderr));
      assert.ok(existsSync(videoPath), `expected recording at ${videoPath}`);

      const sheet = integration.runStep('record contact-sheet', [
        'record',
        'contact-sheet',
        videoPath,
        '--out',
        sheetPath,
        '--json',
      ]);
      assertContactSheet(sheet, videoPath, sheetPath);
    } finally {
      if (recordingStarted && !recordingStopped) {
        integration.runCleanupStep('cleanup record stop', [
          'record',
          'stop',
          '--json',
          ...target,
          ...session,
        ]);
      }
      integration.runCleanupStep('cleanup close', ['close', '--json', ...target, ...session]);
    }
  },
);

type ContactSheetData = {
  path?: string;
  videoPath?: string;
  durationMs?: number;
  width?: number;
  height?: number;
  sampledFrameCount?: number;
  decodedFrameCount?: number;
  skippedSampleCount?: number;
  changedPixelThreshold?: number;
  cells?: Array<{ timeMs?: number; changedPixelRatio?: number }>;
};

/** The shortest grid the planner produces for a clip long enough to navigate. */
const MIN_SAMPLED_FRAMES = 4;
/** The grid cap `planContactSheetSampleTimes` holds however long the clip runs. */
const MAX_SAMPLED_FRAMES = 48;
/** Cells one sheet prints. */
const MAX_SHEET_CELLS = 24;

function assertContactSheet(
  result: CliJsonResult,
  videoPath: string,
  sheetPath: string,
): ContactSheetData {
  assert.equal(result.status, 0, JSON.stringify(result.json ?? result.stderr));
  assert.equal(result.json?.success, true, JSON.stringify(result.json ?? result.stderr));
  const data = (result.json?.data ?? {}) as ContactSheetData;

  assert.equal(data.path, sheetPath);
  assert.equal(data.videoPath, videoPath);
  assert.ok(existsSync(sheetPath), `expected contact sheet at ${sheetPath}`);

  const bytes = readFileSync(sheetPath);
  assertPngHeader(bytes);
  assertReportedSizeMatchesHeader(bytes, data);
  assertCoverage(data);
  assertCells(data);
  return data;
}

function assertPngHeader(bytes: Buffer): void {
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'expected contact sheet to be a PNG',
  );
}

/** The sheet reports the bytes it wrote, not a size it hoped for. */
function assertReportedSizeMatchesHeader(bytes: Buffer, data: ContactSheetData): void {
  assert.ok((data.width ?? 0) > 0 && (data.height ?? 0) > 0, 'expected reported dimensions');
  assert.equal(bytes.readUInt32BE(16), data.width, 'reported width must match the PNG header');
  assert.equal(bytes.readUInt32BE(20), data.height, 'reported height must match the PNG header');
}

/** What the sheet says it looked at: a bounded grid over a measurable clip, with nothing dropped. */
function assertCoverage(data: ContactSheetData): void {
  assert.ok((data.durationMs ?? 0) > 0, 'expected a measurable clip length');
  const sampled = data.sampledFrameCount ?? 0;
  assert.ok(
    sampled >= MIN_SAMPLED_FRAMES && sampled <= MAX_SAMPLED_FRAMES,
    `expected a bounded sample grid, saw ${String(sampled)}`,
  );
  assert.ok(
    (data.decodedFrameCount ?? 0) >= MIN_SAMPLED_FRAMES,
    `expected the decoder to answer sample times, saw ${String(data.decodedFrameCount)}`,
  );
  assert.equal(data.skippedSampleCount, 0, 'expected no declined sample times');
}

function assertCells(data: ContactSheetData): void {
  const cells = data.cells ?? [];
  assert.ok(cells.length >= 2, 'expected a navigation to earn cells beyond the opening frame');
  assert.ok(
    cells.length <= MAX_SHEET_CELLS,
    `expected at most ${MAX_SHEET_CELLS} cells, saw ${cells.length}`,
  );
  assert.equal(cells[0]?.timeMs, 0, 'expected the sheet to open on the first frame');
  assertCellTimesIncreaseWithinTheClip(cells, data.durationMs ?? 0);
  assertEveryCellClearedTheThreshold(cells, data.changedPixelThreshold ?? 0);
}

function assertCellTimesIncreaseWithinTheClip(
  cells: ContactSheetData['cells'],
  durationMs: number,
): void {
  const list = cells ?? [];
  list.forEach((cell, index) => {
    if (index === 0) return;
    const previous = list[index - 1] as { timeMs?: number };
    assert.ok(
      (cell.timeMs ?? 0) > (previous.timeMs ?? 0),
      `expected strictly increasing cell times at index ${index}`,
    );
  });
  assert.ok(
    (list.at(-1)?.timeMs ?? 0) <= durationMs,
    'expected every cell inside the clip timeline',
  );
}

function assertEveryCellClearedTheThreshold(
  cells: ContactSheetData['cells'],
  threshold: number,
): void {
  for (const cell of (cells ?? []).slice(1)) {
    assert.ok(
      (cell.changedPixelRatio ?? 0) > threshold,
      `expected cell ${String(cell.timeMs)} to clear the ${String(threshold)} threshold`,
    );
  }
}

function createRecordingIntegrationContext(platform: 'ios' | 'android', testName: string) {
  const runId = new Date().toISOString().replaceAll(':', '-');
  const stateDir = path.resolve('test/artifacts', platform, sanitize(testName), runId, 'state');
  return createIntegrationTestContext({
    platform,
    testName,
    extraEnv: { ...process.env, AGENT_DEVICE_STATE_DIR: stateDir },
  });
}

function shouldSkipContactSheetE2E(): string | false {
  if (!recordingE2EEnabled) return 'set AGENT_DEVICE_RECORDING_E2E=1 to run live recording tests';
  if (process.platform !== 'darwin') return 'contact sheets need a macOS host';
  return false;
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').toLowerCase());
}

function sanitize(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/-+/g, '-');
}
