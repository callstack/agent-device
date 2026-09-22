import { beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CONTACT_SHEET_CONTAINER_REASON,
  CONTACT_SHEET_DURATION_REASON,
  CONTACT_SHEET_EXTRACTION_REASON,
  CONTACT_SHEET_OUTPUT_COLLISION_REASON,
  CONTACT_SHEET_PIXEL_BUDGET_REASON,
  CONTACT_SHEET_UNSUPPORTED_HOST_REASON,
} from './contact-sheet-report.ts';
import { AppError } from '@agent-device/kernel/errors';
import { BLACK, RED, WHITE, paintPng, type Rectangle, solidPng } from '../png-pixels.fixtures.ts';
import { mkdtempForTestSync } from '../tmp-dir.fixtures.ts';
import { decodePng } from '../png.ts';
import { mp4Atom, mp4MovieHeader } from './mp4.fixtures.ts';
import { writeDecodedFrames, type StubFrame } from './contact-sheet.fixtures.ts';
import { buildRecordingContactSheet, recordingContactSheetPath } from './contact-sheet.ts';

vi.mock(import('@agent-device/host-kit/command'), async (importOriginal) => ({
  ...(await importOriginal()),
  runCmd: vi.fn(),
}));

vi.mock(import('./swift-cache.ts'), async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swift-cache.ts')>()),
  compileSwiftSourceFile: vi.fn(async () => '/cached/bin/recording-frames'),
}));

import { runCmd } from '@agent-device/host-kit/command';
import { likelyPlayableWebmContainer } from '../__tests__/test-utils/video-fixtures.ts';

const mockRunCmd = vi.mocked(runCmd);
const directory = mkdtempForTestSync('agent-device-contact-sheet-pipeline-');

/** A recording the container sniff and the timeline reader both recognise, at a chosen length. */
function recording(name: string, durationMs: number): string {
  const filePath = path.join(directory, `${name}.mp4`);
  fs.writeFileSync(
    filePath,
    Buffer.concat([
      mp4Atom('ftyp', Buffer.alloc(24)),
      mp4Atom('mdat', Buffer.alloc(16)),
      mp4Atom(
        'moov',
        mp4Atom(
          'mvhd',
          mp4MovieHeader({ version: 0, timescale: 1_000, duration: unknownable(durationMs) }),
        ),
      ),
    ]),
  );
  return filePath;
}

function unknownable(durationMs: number): number {
  return durationMs < 0 ? 0xffffffff : durationMs;
}

/** A change that stays inside a corner, which is what makes a box worth drawing. */
const LOCAL_CHANGE = { x: 1, y: 1, width: 4, height: 3 };
const OVERLAY_BORDER = [229, 72, 77];

function frame(timeMs: number, changed: boolean | Rectangle): StubFrame {
  return {
    png: changed
      ? paintPng(
          solidPng(8, 8, BLACK),
          changed === true ? { x: 0, y: 0, width: 8, height: 8 } : changed,
          RED,
        )
      : solidPng(8, 8, BLACK),
    actualTimeMs: timeMs,
  };
}

function countColor(png: { data: Buffer }, color: readonly number[]): number {
  let count = 0;
  for (let offset = 0; offset < png.data.length; offset += 4) {
    if (
      png.data[offset] === color[0] &&
      png.data[offset + 1] === color[1] &&
      png.data[offset + 2] === color[2]
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * Answers the grid the planner will ask for. `presentMs` names the times the decoder answers;
 * anything the grid asked for and is left out is reported skipped, as a real decoder declines.
 */
function answerForGrid(
  input: Readonly<{
    timesMs: readonly number[];
    presentMs?: readonly number[];
    changedMs?: readonly number[];
    /** Times whose change stays inside a corner, so the sheet has a region to box. */
    regionMs?: readonly number[];
  }>,
): void {
  const present = new Set(input.presentMs ?? input.timesMs);
  const changed = new Set(input.changedMs ?? []);
  const local = new Set(input.regionMs ?? []);
  const byRequestedTime = new Map<number, StubFrame>();
  for (const timeMs of input.timesMs) {
    if (!present.has(timeMs)) continue;
    byRequestedTime.set(
      timeMs,
      frame(timeMs, local.has(timeMs) ? LOCAL_CHANGE : changed.has(timeMs)),
    );
  }
  mockRunCmd.mockImplementation(async (_cmd, args) =>
    writeDecodedFrames({ args: args as string[], framesByRequestedTimeMs: byRequestedTime }),
  );
}

/**
 * Every case runs on a macOS host unless it names another, because frame decoding is Apple tooling
 * and the unit lane also runs on Linux.
 */
type BuildInput = Partial<
  Omit<Parameters<typeof buildRecordingContactSheet>[0], 'videoPath' | 'hostPlatform'>
> & { hostPlatform?: NodeJS.Platform };

function build(videoPath: string, input: BuildInput = {}) {
  return buildRecordingContactSheet({
    ...input,
    videoPath,
    maxPixels: input.maxPixels ?? 20_000_000,
    changedPixelThreshold: input.changedPixelThreshold ?? 0.1,
    hostPlatform: input.hostPlatform ?? 'darwin',
  });
}

async function reasonOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error instanceof AppError ? error.details?.reason : error;
  }
  return 'no error thrown';
}

describe('buildRecordingContactSheet', () => {
  beforeEach(() => {
    mockRunCmd.mockReset();
  });

  test('writes the sheet beside the recording and says what it covered', async () => {
    const video = recording('cover', 1_000);
    answerForGrid({ timesMs: [0, 250, 500, 750, 1000], changedMs: [500] });

    const sheet = await build(video);

    expect(sheet.path).toBe(recordingContactSheetPath(video));
    expect(fs.existsSync(sheet.path)).toBe(true);
    expect(sheet.videoPath).toBe(video);
    expect(sheet.durationMs).toBe(1_000);
    expect(sheet.sampledFrameCount).toBe(5);
    expect(sheet.decodedFrameCount).toBe(5);
    expect(sheet.skippedSampleCount).toBe(0);
    // 750 returns to the opening screen, which is a change against the frame kept before it.
    expect(sheet.cells.map((cell) => cell.timeMs)).toEqual([0, 500, 750, 1000]);
    expect(sheet.warning).toBeUndefined();

    const decoded = decodePng(fs.readFileSync(sheet.path), 'sheet');
    expect([decoded.width, decoded.height]).toEqual([sheet.width, sheet.height]);
    expect(
      [...fs.readdirSync(directory)].some(
        (name) => name.endsWith('.writing') || name.endsWith('.tmp'),
      ),
    ).toBe(false);
  });

  test('boxes what moved inside a cell and reports the boxes', async () => {
    const video = recording('boxed', 500);
    answerForGrid({ timesMs: [0, 250, 500], regionMs: [250] });

    const sheet = await build(video);

    expect(sheet.diffOverlay).toBe(true);
    expect(
      countColor(decodePng(fs.readFileSync(sheet.path), 'boxed sheet'), OVERLAY_BORDER),
    ).toBeGreaterThan(0);
  });

  test('prints the same cells unmarked when the overlay is off', async () => {
    const video = recording('unmarked', 500);
    answerForGrid({ timesMs: [0, 250, 500], regionMs: [250] });

    const sheet = await build(video, { diffOverlay: false });

    expect(sheet.diffOverlay).toBe(false);
    expect(sheet.cells.map((cell) => cell.timeMs)).toEqual([0, 250, 500]);
    expect(
      countColor(decodePng(fs.readFileSync(sheet.path), 'unmarked sheet'), OVERLAY_BORDER),
    ).toBe(0);
  });

  test('honours an explicit output path', async () => {
    const video = recording('explicit', 500);
    const outputPath = path.join(directory, 'named', 'sheet.png');
    answerForGrid({ timesMs: [0, 250, 500], changedMs: [250] });

    const sheet = await build(video, { outputPath });

    expect(sheet.path).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  test('keeps one cell when the recorded screen never changed', async () => {
    const video = recording('static', 500);
    answerForGrid({ timesMs: [0, 250, 500] });

    const sheet = await build(video);

    expect(sheet.cells).toHaveLength(2);
    expect(sheet.cells.at(-1)).toMatchObject({ timeMs: 500, changedPixelRatio: 0 });
  });

  test('discloses the sample times the decoder declined', async () => {
    const video = recording('skipped', 1_000);
    answerForGrid({
      timesMs: [0, 250, 500, 750, 1000],
      presentMs: [0, 750, 1000],
      changedMs: [750],
    });

    const sheet = await build(video);

    expect(sheet.sampledFrameCount).toBe(5);
    expect(sheet.decodedFrameCount).toBe(3);
    expect(sheet.skippedSampleCount).toBe(2);
    expect(sheet.warning).toMatch(/2 sample times returned no frame/);
  });

  test('refuses a WebM recording rather than decoding nothing and calling it a sheet', async () => {
    const webm = path.join(directory, 'web.webm');
    fs.writeFileSync(webm, likelyPlayableWebmContainer());

    const error = await build(webm).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).details?.reason).toBe(CONTACT_SHEET_CONTAINER_REASON);
    expect((error as AppError).message).toMatch(/WebM/);
  });

  test('refuses a file that is not a readable MP4', async () => {
    const notAVideo = path.join(directory, 'broken.mp4');
    fs.writeFileSync(notAVideo, 'not a video at all');

    expect(await reasonOf(() => build(notAVideo))).toBe(CONTACT_SHEET_CONTAINER_REASON);
  });

  test('refuses a clip whose timeline the container cannot name', async () => {
    expect(await reasonOf(() => build(recording('no-duration', -1)))).toBe(
      CONTACT_SHEET_DURATION_REASON,
    );
  });

  test('surfaces a failed extraction and writes no sheet', async () => {
    const video = recording('extraction-fails', 1_000);
    mockRunCmd.mockImplementation(async (_cmd, args) =>
      writeDecodedFrames({
        args: args as string[],
        framesByRequestedTimeMs: new Map(),
        failWithExitCode: 1,
      }),
    );

    expect(await reasonOf(() => build(video))).toBe(CONTACT_SHEET_EXTRACTION_REASON);
    expect(fs.existsSync(recordingContactSheetPath(video))).toBe(false);
  });

  test('refuses to try on a host with no frame decoder', async () => {
    const video = recording('unsupported-host', 1_000);

    expect(await reasonOf(() => build(video, { hostPlatform: 'linux' }))).toBe(
      CONTACT_SHEET_UNSUPPORTED_HOST_REASON,
    );
    expect(mockRunCmd).not.toHaveBeenCalled();
  });

  test('draws the sheet on a decoded frame whatever the source pixels were', async () => {
    const video = recording('pixels', 250);
    const byRequestedTime = new Map<number, StubFrame>([
      [0, { png: solidPng(8, 8, WHITE), actualTimeMs: 0 }],
    ]);
    mockRunCmd.mockImplementation(async (_cmd, args) =>
      writeDecodedFrames({ args: args as string[], framesByRequestedTimeMs: byRequestedTime }),
    );

    const sheet = await build(video);
    const decoded = decodePng(fs.readFileSync(sheet.path), 'sheet');

    let white = 0;
    for (let offset = 0; offset < decoded.data.length; offset += 4) {
      if (decoded.data[offset] === 255 && decoded.data[offset + 1] === 255) white += 1;
    }
    expect(white).toBeGreaterThan(0);
  });

  test('refuses to write the sheet where the recording it describes is', async () => {
    const video = recording('collision', 1_000);

    expect(await reasonOf(() => build(video, { outputPath: video }))).toBe(
      CONTACT_SHEET_OUTPUT_COLLISION_REASON,
    );
    // Refused before the decoder ran, so a mistyped --out cannot cost a ruined recording.
    expect(mockRunCmd).not.toHaveBeenCalled();
    expect(fs.readFileSync(video).length).toBeGreaterThan(0);
  });

  test('refuses an output path that reaches the recording through a second name', async () => {
    const video = recording('aliased', 1_000);
    const symlink = path.join(path.dirname(video), 'sheet-of-my-recording.mp4');
    const hardLink = path.join(path.dirname(video), 'recording-copy.mp4');
    fs.symlinkSync(video, symlink);
    fs.linkSync(video, hardLink);

    for (const outputPath of [symlink, hardLink]) {
      expect(await reasonOf(() => build(video, { outputPath }))).toBe(
        CONTACT_SHEET_OUTPUT_COLLISION_REASON,
      );
    }
    // Neither alias was opened for writing, so the recording is still whole behind both names.
    expect(mockRunCmd).not.toHaveBeenCalled();
    expect(fs.readFileSync(video).length).toBe(fs.statSync(hardLink).size);
  });

  test('refuses a decoded frame too large for the sheet it was meant to fill', async () => {
    const video = recording('oversized', 250);
    mockRunCmd.mockImplementation(async (_cmd, args) =>
      writeDecodedFrames({
        args: args as string[],
        framesByRequestedTimeMs: new Map([
          [0, { png: solidPng(16, 16, BLACK), actualTimeMs: 0 }],
          [250, { png: solidPng(16, 16, BLACK), actualTimeMs: 250 }],
        ]),
      }),
    );

    expect(await reasonOf(() => build(video, { maxPixels: 100 }))).toBe(
      CONTACT_SHEET_EXTRACTION_REASON,
    );
  });

  test('refuses a wider frame than the cells the decoder was asked to draw', async () => {
    const video = recording('wide', 250);
    mockRunCmd.mockImplementation(async (_cmd, args) =>
      writeDecodedFrames({
        args: args as string[],
        framesByRequestedTimeMs: new Map([
          [0, { png: solidPng(400, 40, BLACK), actualTimeMs: 0 }],
          [250, { png: solidPng(400, 40, BLACK), actualTimeMs: 250 }],
        ]),
      }),
    );

    expect(await reasonOf(() => build(video))).toBe(CONTACT_SHEET_EXTRACTION_REASON);
  });

  test('refuses a sheet the pixel budget cannot hold and leaves nothing at the output', async () => {
    const video = recording('budget', 1_000);
    const out = path.join(directory, 'budget-sheet.png');
    answerForGrid({ timesMs: [0, 250, 500, 750, 1000], changedMs: [250, 500, 750, 1000] });

    expect(await reasonOf(() => build(video, { outputPath: out, maxPixels: 200 }))).toBe(
      CONTACT_SHEET_PIXEL_BUDGET_REASON,
    );
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.writing'))).toEqual([]);
  });

  test('replaces a sheet that is already at the output path', async () => {
    const video = recording('replace', 1_000);
    const out = path.join(directory, 'replace-sheet.png');
    fs.writeFileSync(out, 'a sheet from an earlier run');
    answerForGrid({ timesMs: [0, 250, 500, 750, 1000], changedMs: [500] });

    const sheet = await build(video, { outputPath: out });

    expect(sheet.path).toBe(out);
    expect(fs.readFileSync(out).subarray(1, 4).toString()).toBe('PNG');
  });
});
