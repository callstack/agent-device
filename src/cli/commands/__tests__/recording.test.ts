import { describe, expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { ClientCommandParams } from '../router-types.ts';
import { recordingCommand } from '../recording.ts';

function params(positionals: string[]): ClientCommandParams {
  return {
    positionals,
    flags: {} as ClientCommandParams['flags'],
    client: {} as ClientCommandParams['client'],
  };
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

  test('refuses more than one recording path', async () => {
    const error = await failure(() =>
      recordingCommand(params(['contact-sheet', '/tmp/a.mp4', '/tmp/b.mp4'])),
    );

    expect((error as AppError).message).toMatch(/one recording path/);
  });
});
