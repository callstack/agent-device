import { expect, test } from 'vitest';
import { prepareRecordingRequest, readRecordingScope } from '../record-runtime-request.ts';

test('normalizes recording flags while retaining explicit hide-touch intent', () => {
  expect(
    prepareRecordingRequest({
      token: 'token',
      session: 'default',
      command: 'record',
      positionals: [],
      flags: { recordingScope: 'device', hideTouches: true, fps: 30, quality: 'medium' },
    }),
  ).toMatchObject({
    scope: 'device',
    showTouches: false,
    hideTouchesRequested: true,
    fps: 30,
    exportQuality: 'medium',
  });
  expect(
    prepareRecordingRequest({
      token: 'token',
      session: 'default',
      command: 'record',
      positionals: [],
      flags: {},
    }),
  ).toMatchObject({
    scope: 'app',
    showTouches: true,
    hideTouchesRequested: false,
  });
});

test('rejects invalid scope, fps, and quality before runtime binding', () => {
  expect(() => readRecordingScope('window')).toThrow('record scope must be app, device, or system');
  expect(() =>
    prepareRecordingRequest({
      token: 'token',
      session: 'default',
      command: 'record',
      positionals: [],
      flags: { fps: 0 },
    }),
  ).toThrow('fps must be an integer between 1 and 120');
  expect(() =>
    prepareRecordingRequest({
      token: 'token',
      session: 'default',
      command: 'record',
      positionals: [],
      flags: { quality: 'huge' },
    }),
  ).toThrow('quality must be one of');
});
