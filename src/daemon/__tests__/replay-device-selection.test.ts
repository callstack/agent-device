import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReplayTargetDeviceResolution } from '../replay-device-selection.ts';

test('replay leaves deep-link opens to normal device resolution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-device-selection-'));
  const replayPath = path.join(root, 'deep-link.ad');
  fs.writeFileSync(replayPath, 'open demo://checkout\n');

  expect(
    buildReplayTargetDeviceResolution({
      token: 'test-token',
      session: 'default',
      command: 'replay',
      positionals: [replayPath],
      meta: { cwd: root },
    }),
  ).toBeUndefined();
});

test('native replay uses its authored Android runtime setting without an iOS app probe', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-device-selection-'));
  const replayPath = path.join(root, 'android.ad');
  fs.writeFileSync(
    replayPath,
    'runtime set --platform android --metro-port 8081\nopen com.example.demo\n',
  );

  expect(
    buildReplayTargetDeviceResolution({
      token: 'test-token',
      session: 'default',
      command: 'replay',
      positionals: [replayPath],
      meta: { cwd: root },
    }),
  ).toEqual({ flags: { platform: 'android' }, options: undefined });
});
