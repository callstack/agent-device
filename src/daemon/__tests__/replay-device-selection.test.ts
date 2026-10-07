import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseReplayInput } from '@agent-device/ad-script';
import type { ReplayScriptSourceBundle } from '@agent-device/contracts/replay';
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

test('a replay whose wire bundle has a malformed entry stays advisory', async () => {
  // The HTTP boundary validates `flags` only as an object, so a remote caller
  // can deliver a bundle without a string `entry`. #1802 keeps lock binding
  // advisory: the probe must fall back to normal device resolution, and the
  // replay handler stays the one to reject the request.
  const malformedBundles = [
    // A missing entry fails the bundle read itself.
    { entry: undefined, files: {} },
    // A non-string entry survives the read — `files` is keyed by the coerced
    // string — and reaches format resolution, where `path.extname` rejects it.
    { entry: 42, files: { '42': 'open demo://checkout\n' } },
  ] as unknown as ReplayScriptSourceBundle[];

  for (const bundle of malformedBundles) {
    await expect(
      buildReplayTargetDeviceResolution({
        token: 'test-token',
        session: 'default',
        command: 'replay',
        positionals: [],
        flags: {
          replayBackend: 'maestro',
          replayScriptSource: bundle,
        },
        meta: { cwd: mkdtempForTestSync('agent-device-replay-device-selection-') },
      }),
    ).resolves.toBeUndefined();
  }
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
