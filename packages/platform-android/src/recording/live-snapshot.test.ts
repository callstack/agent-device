import { describe, expect, test } from 'vitest';
import { snapshot } from './live-snapshot.ts';
import { recordingInput } from './fixtures.ts';

describe('snapshot', () => {
  test('names the recorder and the path the caller asked for before any artifact exists', () => {
    expect(snapshot(recordingInput(), 1_789_000_000_000)).toEqual({
      backend: 'adb screenrecord',
      outPath: '/tmp/capture.mp4',
      startedAt: 1_789_000_000_000,
      scope: 'device',
      showTouches: true,
      recordOnlySession: false,
      activeSessionApp: undefined,
      gestureEvents: [],
    });
  });

  test('carries only the choices the caller made', () => {
    const started = snapshot(
      {
        ...recordingInput(),
        clientOutputPath: '/client/capture.mp4',
        exportQuality: 'high',
        activeSessionApp: { bundleId: 'com.example.app' },
      },
      1,
    );

    expect(started).toMatchObject({
      clientOutPath: '/client/capture.mp4',
      exportQuality: 'high',
      activeSessionApp: { bundleId: 'com.example.app' },
    });
    expect(snapshot({ ...recordingInput(), showTouches: false }, 1).showTouches).toBe(false);
  });
});
