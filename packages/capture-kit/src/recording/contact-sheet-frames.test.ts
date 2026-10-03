import { beforeEach, describe, expect, test, vi } from 'vitest';
import path from 'node:path';
import {
  CONTACT_SHEET_EXTRACTION_REASON,
  CONTACT_SHEET_NO_FRAMES_REASON,
  CONTACT_SHEET_UNSUPPORTED_HOST_REASON,
} from './contact-sheet-report.ts';
import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '../tmp-dir.fixtures.ts';
import { solidPng } from '../png-pixels.fixtures.ts';
import { writeDecodedFrames, type StubFrame } from './contact-sheet.fixtures.ts';
import { extractRecordingFrames } from './contact-sheet-frames.ts';

vi.mock(import('@agent-device/host-kit/command'), async (importOriginal) => ({
  ...(await importOriginal()),
  runCmd: vi.fn(),
}));

vi.mock(import('./swift-cache.ts'), async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swift-cache.ts')>()),
  compileSwiftSourceFile: vi.fn(async () => '/cached/bin/recording-frames'),
}));

import { runCmd } from '@agent-device/host-kit/command';

const mockRunCmd = vi.mocked(runCmd);
const scratchDir = mkdtempForTestSync('agent-device-contact-sheet-frames-');
const CELL_WIDTH = 360;
const VIDEO = '/tmp/recording.mp4';

function reasonOf(action: () => Promise<unknown>): Promise<unknown> | unknown {
  return action().then(
    () => 'no error thrown',
    (error: unknown) => (error instanceof AppError ? error.details?.reason : error),
  );
}

/** Decoding is Apple tooling, so every case here states the host it is pretending to be. */
function extract(
  input: Omit<Parameters<typeof extractRecordingFrames>[0], 'hostPlatform'>,
): Promise<Awaited<ReturnType<typeof extractRecordingFrames>>> {
  return extractRecordingFrames({ ...input, hostPlatform: 'darwin' });
}

function withTimes(args: readonly string[], times: string): string[] {
  const rewritten = [...args];
  rewritten[rewritten.indexOf('--times') + 1] = times;
  return rewritten;
}

function answerWith(framesByRequestedTimeMs: ReadonlyMap<number, StubFrame>) {
  mockRunCmd.mockImplementation(async (_cmd, args) =>
    writeDecodedFrames({ args: args as string[], framesByRequestedTimeMs }),
  );
}

describe('extractRecordingFrames', () => {
  beforeEach(() => {
    mockRunCmd.mockReset();
  });

  test('refuses to decode at all on a host with no frame decoder', async () => {
    expect(
      await reasonOf(() =>
        extractRecordingFrames({
          videoPath: VIDEO,
          scratchDir,
          maxWidth: CELL_WIDTH,
          timesMs: [0],
          hostPlatform: 'linux',
        }),
      ),
    ).toBe(CONTACT_SHEET_UNSUPPORTED_HOST_REASON);
    // Refused before the compiler or the decoder ran, so a Linux host never pays for a spawn.
    expect(mockRunCmd).not.toHaveBeenCalled();
  });

  test('asks the helper for exactly the grid it was given', async () => {
    answerWith(
      new Map([
        [0, { png: solidPng(4, 4), actualTimeMs: 0 }],
        [250, { png: solidPng(4, 4), actualTimeMs: 250 }],
      ]),
    );

    await extract({
      videoPath: VIDEO,
      scratchDir,
      maxWidth: CELL_WIDTH,
      timesMs: [0, 250],
    });

    const [, args] = mockRunCmd.mock.calls[0]!;
    expect(args).toEqual([
      '--input',
      VIDEO,
      '--output-dir',
      scratchDir,
      '--times',
      '0,250',
      '--max-width',
      '360',
    ]);
  });

  test('reports the times the decoder actually returned', async () => {
    answerWith(
      new Map([
        // A decoder answers a request with the frame it holds, and out of request order is legal:
        // the sheet must still read left to right in time.
        [0, { png: solidPng(4, 4), actualTimeMs: 500 }],
        [250, { png: solidPng(4, 4), actualTimeMs: 0 }],
        [500, { png: solidPng(4, 4), actualTimeMs: 250 }],
      ]),
    );

    const extracted = await extract({
      videoPath: VIDEO,
      scratchDir,
      maxWidth: CELL_WIDTH,
      timesMs: [0, 250, 500],
    });

    expect(extracted.frames.map((frame) => frame.actualTimeMs)).toEqual([0, 250, 500]);
    expect(extracted.frames.map((frame) => frame.requestedTimeMs)).toEqual([250, 500, 0]);
    expect(extracted.skippedSampleCount).toBe(0);
  });

  test('counts the sample times the decoder declined', async () => {
    answerWith(new Map([[0, { png: solidPng(4, 4), actualTimeMs: 0 }]]));

    const extracted = await extract({
      videoPath: VIDEO,
      scratchDir,
      maxWidth: CELL_WIDTH,
      timesMs: [0, 250, 500],
    });

    expect(extracted.frames).toHaveLength(1);
    expect(extracted.skippedSampleCount).toBe(2);
  });

  test('drops a frame the manifest names but the helper never wrote', async () => {
    const written = new Map<number, StubFrame>([
      [0, { png: solidPng(4, 4), actualTimeMs: 0 }],
      [250, { png: solidPng(4, 4), actualTimeMs: 250 }],
    ]);
    mockRunCmd.mockImplementation(async (_cmd, args) => {
      const result = writeDecodedFrames({
        args: args as string[],
        framesByRequestedTimeMs: written,
      });
      const manifest = JSON.parse(result.stdout) as { frames: { path: string }[] };
      manifest.frames[0]!.path = path.join(scratchDir, 'frame-9999.png');
      return { ...result, stdout: JSON.stringify(manifest) };
    });

    const extracted = await extract({
      videoPath: VIDEO,
      scratchDir,
      maxWidth: CELL_WIDTH,
      timesMs: [0, 250],
    });

    expect(extracted.frames.map((frame) => frame.actualTimeMs)).toEqual([250]);
    // A frame the manifest promised and never delivered shrinks coverage, and the sheet has to say
    // so rather than let one fewer cell look like a quieter recording.
    expect(extracted.skippedSampleCount).toBe(1);
  });

  test('refuses a manifest that answers more samples than were asked for', async () => {
    const answers = new Map<number, StubFrame>([
      [0, { png: solidPng(4, 4), actualTimeMs: 0 }],
      [250, { png: solidPng(4, 4), actualTimeMs: 250 }],
    ]);
    mockRunCmd.mockImplementation(async (_cmd, args) =>
      writeDecodedFrames({
        // The decoder was asked for one sample and hands back two: whatever those bytes are, they
        // are not the grid this command budgeted to decode.
        args: withTimes(args as string[], '0,250'),
        framesByRequestedTimeMs: answers,
      }),
    );

    expect(
      await reasonOf(() =>
        extract({
          videoPath: VIDEO,
          scratchDir,
          maxWidth: CELL_WIDTH,
          timesMs: [0],
        }),
      ),
    ).toBe(CONTACT_SHEET_EXTRACTION_REASON);
  });

  test('refuses a frame entry that cannot say which frame it is', async () => {
    mockRunCmd.mockResolvedValue({
      stdout: JSON.stringify({
        frames: [{ index: 0, path: 'frame-0.png', width: 4, height: 4 }],
        skipped: [],
      }),
      stderr: '',
      exitCode: 0,
    });

    expect(
      await reasonOf(() =>
        extract({
          videoPath: VIDEO,
          scratchDir,
          maxWidth: CELL_WIDTH,
          timesMs: [0],
        }),
      ),
    ).toBe(CONTACT_SHEET_EXTRACTION_REASON);
  });

  test('counts samples the manifest neither answered nor declared skipped', async () => {
    answerWith(new Map([[0, { png: solidPng(4, 4), actualTimeMs: 0 }]]));

    const extracted = await extract({
      videoPath: VIDEO,
      scratchDir,
      maxWidth: CELL_WIDTH,
      timesMs: [0, 250, 500],
    });

    // A decoder that stays silent about the two samples it dropped still covered one of three, and
    // a sheet may not report that as full coverage.
    expect(extracted.frames).toHaveLength(1);
    expect(extracted.skippedSampleCount).toBe(2);
  });

  test('keeps the extraction reason when the decoder cannot be built', async () => {
    const { compileSwiftSourceFile } = await import('./swift-cache.ts');
    vi.mocked(compileSwiftSourceFile).mockRejectedValueOnce(new Error('swiftc died'));

    expect(
      await reasonOf(() =>
        extract({
          videoPath: VIDEO,
          scratchDir,
          maxWidth: CELL_WIDTH,
          timesMs: [0],
        }),
      ),
    ).toBe(CONTACT_SHEET_EXTRACTION_REASON);
  });

  test('keeps the extraction reason when the decoder never started', async () => {
    mockRunCmd.mockRejectedValue(new Error('spawn /cached/bin/recording-frames ENOENT'));

    expect(
      await reasonOf(() =>
        extract({
          videoPath: VIDEO,
          scratchDir,
          maxWidth: CELL_WIDTH,
          timesMs: [0],
        }),
      ),
    ).toBe(CONTACT_SHEET_EXTRACTION_REASON);
  });

  test('hands the decoder the cancellation of the request it serves', async () => {
    answerWith(new Map([[0, { png: solidPng(4, 4), actualTimeMs: 0 }]]));
    const controller = new AbortController();

    await extract({
      videoPath: VIDEO,
      scratchDir,
      maxWidth: CELL_WIDTH,
      timesMs: [0],
      signal: controller.signal,
    });

    expect(mockRunCmd.mock.calls[0]![2]).toMatchObject({
      allowFailure: true,
      signal: controller.signal,
    });
  });

  test('answers a cancelled request as a cancellation, not an extraction failure', async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await extract({
      videoPath: VIDEO,
      scratchDir,
      maxWidth: CELL_WIDTH,
      timesMs: [0],
      signal: controller.signal,
    }).catch((error: unknown) => error);

    expect(isRequestCanceledError(error)).toBe(true);
    expect(mockRunCmd).not.toHaveBeenCalled();
  });

  test('reports a failed extraction run rather than an empty sheet', async () => {
    answerWith(new Map());
    mockRunCmd.mockImplementation(async (_cmd, args) =>
      writeDecodedFrames({
        args: args as string[],
        framesByRequestedTimeMs: new Map(),
        failWithExitCode: 1,
      }),
    );

    await expect(
      extract({ videoPath: VIDEO, scratchDir, maxWidth: CELL_WIDTH, timesMs: [0] }),
    ).rejects.toThrow(/could not open asset/);
    expect(
      await reasonOf(() =>
        extract({
          videoPath: VIDEO,
          scratchDir,
          maxWidth: CELL_WIDTH,
          timesMs: [0],
        }),
      ),
    ).toBe(CONTACT_SHEET_EXTRACTION_REASON);
  });

  test('reports an unreadable manifest as an extraction failure', async () => {
    mockRunCmd.mockResolvedValue({ stdout: 'not json', stderr: '', exitCode: 0 });

    expect(
      await reasonOf(() =>
        extract({
          videoPath: VIDEO,
          scratchDir,
          maxWidth: CELL_WIDTH,
          timesMs: [0],
        }),
      ),
    ).toBe(CONTACT_SHEET_EXTRACTION_REASON);
  });

  test('reports a clip that returned nothing usable', async () => {
    answerWith(new Map());

    expect(
      await reasonOf(() =>
        extract({
          videoPath: VIDEO,
          scratchDir,
          maxWidth: CELL_WIDTH,
          timesMs: [0],
        }),
      ),
    ).toBe(CONTACT_SHEET_NO_FRAMES_REASON);
  });

  test('refuses to spawn a decoder for an empty grid', async () => {
    expect(
      await reasonOf(() =>
        extract({ videoPath: VIDEO, scratchDir, maxWidth: CELL_WIDTH, timesMs: [] }),
      ),
    ).toBe(CONTACT_SHEET_NO_FRAMES_REASON);
    expect(mockRunCmd).not.toHaveBeenCalled();
  });
});
