import { describe, expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { ClientCommandParams } from '../router-types.ts';

const sheet = vi.hoisted(() => ({
  call: { input: {}, result: {} as Record<string, unknown> },
  formatted: '',
}));

vi.mock('../../../runtime.ts', () => ({
  createAgentDevice: () => ({
    recording: {
      contactSheet: async (input: Record<string, unknown>) => {
        sheet.call = { input, result: { path: '/tmp/a.contact-sheet.png', ...sheet.call.result } };
        return sheet.call.result;
      },
    },
  }),
  localCommandPolicy: () => ({}),
}));

vi.mock('../../../io.ts', () => ({ createLocalArtifactAdapter: () => ({}) }));

vi.mock('../shared.ts', () => ({
  writeCommandOutput: async (
    _flags: unknown,
    _result: unknown,
    format: () => string,
  ): Promise<void> => {
    sheet.formatted = format();
  },
}));

import { recordingCommand } from '../recording.ts';

function params(positionals: string[]): ClientCommandParams {
  return {
    positionals,
    flags: {} as ClientCommandParams['flags'],
    client: {} as ClientCommandParams['client'],
  };
}

/** Runs the handler against the stubbed runtime and reports what it was asked for. */
async function run(
  positionals: string[],
  flags: Partial<ClientCommandParams['flags']>,
  result: Record<string, unknown> = {},
): Promise<{ input: Record<string, unknown>; summary: string }> {
  sheet.call.result = {
    durationMs: 1_000,
    cells: [{ timeMs: 0, changedPixelRatio: 1 }],
    sampledFrameCount: 5,
    decodedFrameCount: 5,
    skippedSampleCount: 0,
    changedPixelThreshold: 0.02,
    width: 100,
    height: 100,
    videoPath: '/tmp/a.mp4',
    diffOverlay: true,
    ...result,
  };
  await recordingCommand({
    positionals,
    flags: flags as ClientCommandParams['flags'],
    client: {} as ClientCommandParams['client'],
  });
  return { input: sheet.call.input, summary: sheet.formatted };
}

async function failure(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return 'resolved without an error';
}

describe('record contact-sheet CLI action', () => {
  test('declines every action the generic route owns', async () => {
    const handled = await recordingCommand({
      ...params(['start', '/tmp/recording.mp4']),
      client: { recording: { record: vi.fn() } } as unknown as ClientCommandParams['client'],
    });

    expect(handled).toBe(false);
  });

  test('refuses a contact sheet with no recording to read', async () => {
    const error = await failure(() => recordingCommand(params(['contact-sheet'])));

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INVALID_ARGS');
    expect((error as AppError).message).toMatch(/requires a recording path/);
  });

  test('hands the options record contact-sheet reads to the local handler', async () => {
    const { input } = await run(['contact-sheet', '/tmp/a.mp4'], {
      out: '/tmp/sheet.png',
      noDiffOverlay: true,
    });

    expect(input).toMatchObject({ diffOverlay: false });
  });

  test('refuses more than one recording path', async () => {
    const error = await failure(() =>
      recordingCommand(params(['contact-sheet', '/tmp/a.mp4', '/tmp/b.mp4'])),
    );

    expect((error as AppError).message).toMatch(/one recording path/);
  });
});

describe('record contact-sheet overlay opt-out', () => {
  test('asks for unmarked cells only when --no-diff-overlay was passed', async () => {
    const withFlag = await run(['contact-sheet', '/tmp/a.mp4'], { noDiffOverlay: true });
    const without = await run(['contact-sheet', '/tmp/a.mp4'], {});

    expect(withFlag.input).toMatchObject({ diffOverlay: false });
    expect(without.input.diffOverlay).toBeUndefined();
  });

  test('says on the summary line when the cells came out unmarked', async () => {
    const boxed = await run(['contact-sheet', '/tmp/a.mp4'], {}, { diffOverlay: true });
    const unmarked = await run(['contact-sheet', '/tmp/a.mp4'], {}, { diffOverlay: false });

    expect(boxed.summary).not.toMatch(/diff overlay off/);
    expect(unmarked.summary).toMatch(/diff overlay off/);
  });
});
