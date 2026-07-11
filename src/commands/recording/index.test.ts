import { describe, expect, test } from 'vitest';
import type { CliFlags } from '../cli-grammar/flag-types.ts';
import {
  recordCliReader,
  recordCommandDefinition,
  recordCommandMetadata,
  recordDaemonWriter,
  traceCliReader,
  traceCommandDefinition,
  traceCommandMetadata,
  traceDaemonWriter,
} from './index.ts';

const NO_FLAGS = {} as CliFlags;

function expectInvalidArgs(fn: () => unknown, messageFragment: string) {
  expect(fn).toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      message: expect.stringContaining(messageFragment),
    }),
  );
}

describe('recording command interface', () => {
  test('owns record and trace public metadata', () => {
    expect(recordCommandMetadata.name).toBe('record');
    expect(recordCommandDefinition.name).toBe('record');
    expect(traceCommandMetadata.name).toBe('trace');
    expect(traceCommandDefinition.name).toBe('trace');
  });

  test('reads record CLI input with recording flags', () => {
    expect(
      recordCliReader(['start', './capture.mp4'], {
        fps: 30,
        screenshotMaxSize: 1024,
        quality: 'high',
        hideTouches: true,
        recordingScope: 'device',
      } as CliFlags),
    ).toEqual({
      action: 'start',
      path: './capture.mp4',
      fps: 30,
      maxSize: 1024,
      quality: 'high',
      hideTouches: true,
      recordingScope: 'device',
    });
  });

  test('leaves export quality unset when the flag is omitted', () => {
    expect(recordCliReader(['start'], NO_FLAGS).quality).toBeUndefined();
  });

  test('reads trace CLI input', () => {
    expect(traceCliReader(['stop', './diagnostics.trace'], NO_FLAGS)).toEqual({
      action: 'stop',
      path: './diagnostics.trace',
    });
  });

  test('rejects unsupported recording actions', () => {
    expectInvalidArgs(() => recordCliReader(['pause'], NO_FLAGS), 'record requires start|stop');
    expectInvalidArgs(() => traceCliReader(['pause'], NO_FLAGS), 'trace requires start|stop');
  });

  test('writes record and trace daemon request positionals', () => {
    expect(recordDaemonWriter({ action: 'start', path: './capture.mp4' })).toMatchObject({
      command: 'record',
      positionals: ['start', './capture.mp4'],
    });
    expect(traceDaemonWriter({ action: 'stop', path: './diagnostics.trace' })).toMatchObject({
      command: 'trace',
      positionals: ['stop', './diagnostics.trace'],
    });
  });
});
