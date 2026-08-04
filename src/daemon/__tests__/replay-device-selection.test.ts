import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseReplayInput } from '../../compat/replay-input.ts';
import {
  buildReplayScriptPlatformFlags,
  buildReplayTargetDeviceResolution,
} from '../replay-device-selection.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

test('replay leaves deep-link opens to normal device resolution', () => {
  const root = mkdtempForTestSync('agent-device-replay-device-selection-');
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

test('native replay applies its authored platform before a first deep link', () => {
  expect(
    buildReplayScriptPlatformFlags(
      undefined,
      parseReplayInput(
        'runtime set --platform ios --metro-port 8081\nopen demo://checkout\nopen com.example.demo\n',
        undefined,
      ).actions,
    ),
  ).toEqual({ platform: 'ios' });
});

test('native replay uses its authored Android runtime setting without an iOS app probe', () => {
  const root = mkdtempForTestSync('agent-device-replay-device-selection-');
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
