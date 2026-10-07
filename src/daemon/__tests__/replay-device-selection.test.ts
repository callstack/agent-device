import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseReplayInput } from '@agent-device/ad-script';
import { buildReplayTargetDeviceResolution } from '../replay-device-selection.ts';
import {
  appTargetResolutionOptions,
  buildReplayScriptPlatformFlags,
} from '@agent-device/replay-port/replay-script-selection';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import {
  maestroScriptSourceBundleFor,
  replayScriptSourceBundleFor,
} from '../../__tests__/test-utils/replay-script-source.ts';

test('replay leaves deep-link opens to normal device resolution', async () => {
  const root = mkdtempForTestSync('agent-device-replay-device-selection-');
  const replayPath = path.join(root, 'deep-link.ad');
  fs.writeFileSync(replayPath, 'open demo://checkout\n');

  expect(
    await buildReplayTargetDeviceResolution({
      token: 'test-token',
      session: 'default',
      command: 'replay',
      positionals: [replayPath],
      flags: { replayScriptSource: replayScriptSourceBundleFor(replayPath) },
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

test('native replay uses its authored Android runtime setting without an iOS app probe', async () => {
  const root = mkdtempForTestSync('agent-device-replay-device-selection-');
  const replayPath = path.join(root, 'android.ad');
  fs.writeFileSync(
    replayPath,
    'runtime set --platform android --metro-port 8081\nopen com.example.demo\n',
  );

  const resolution = await buildReplayTargetDeviceResolution({
    token: 'test-token',
    session: 'default',
    command: 'replay',
    positionals: [replayPath],
    flags: { replayScriptSource: replayScriptSourceBundleFor(replayPath) },
    meta: { cwd: root },
  });

  // The request's own flags ride through untouched, so compare the decision this function makes:
  // the authored platform, and no iOS app-probe options.
  expect(resolution?.flags.platform).toBe('android');
  expect(resolution?.options).toBeUndefined();
});

test('a Maestro flow pre-binds an iOS replay to its static appId', async () => {
  const root = mkdtempForTestSync('agent-device-replay-device-selection-');
  const flowPath = path.join(root, 'checkout.yaml');
  fs.writeFileSync(flowPath, 'appId: com.example.demo\n---\n- launchApp\n');

  const resolution = await buildReplayTargetDeviceResolution({
    token: 'test-token',
    session: 'default',
    command: 'replay',
    positionals: [flowPath],
    flags: {
      platform: 'ios',
      replayBackend: 'maestro',
      replayScriptSource: await maestroScriptSourceBundleFor(flowPath),
    },
    meta: { cwd: root },
  });

  expect(resolution?.options).toEqual(appTargetResolutionOptions('com.example.demo'));
  expect(resolution?.options).toBeDefined();
});
