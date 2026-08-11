import { expect, test } from 'vitest';
import { createScreenRecordingRuntimeHost } from './platform-runtime-screen-recording-host.ts';

test('composes the six focused recording host capabilities', () => {
  const host = createScreenRecordingRuntimeHost();
  expect(Object.keys(host).sort()).toEqual([
    'android',
    'apple',
    'finalize',
    'harmony',
    'outputs',
    'web',
  ]);
});
