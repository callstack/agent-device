import { expect, test } from 'vitest';
import { assertScreenRecordingOptionsSupported } from './screen-recording-options.ts';

test('reports only requested options outside a runtime support declaration', () => {
  expect(() =>
    assertScreenRecordingOptionsSupported(
      {
        sessionId: 'one',
        outputPath: '/tmp/capture.webm',
        scope: 'device',
        showTouches: false,
        hideTouchesRequested: true,
        recordOnlySession: false,
        fps: 30,
        fence: { token: 'fence', generation: 1 },
      },
      { scopes: ['app'], fps: false, exportQuality: false, hideTouches: false },
      (unsupported) => `unsupported: ${unsupported.join(', ')}`,
    ),
  ).toThrow('unsupported: --scope, --fps, --hide-touches');
});
