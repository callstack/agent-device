import { expect, test, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PNG } from '@agent-device/capture-kit/png';
import { readPngSize } from '@agent-device/capture-kit/png-size';
import { fixture } from './limrun-ios-runner.fixtures.ts';

test('forwarded screenshots preserve PNG pixels and share density and status bar normalization', async () => {
  const png = new PNG({ width: 12, height: 18 });
  for (let i = 0; i < png.data.length; i++) png.data[i] = i % 251;
  const bytes = PNG.sync.write(png);
  const f = await fixture({
    containers: {
      'com.callstack.agentdevice.runner.uitests.xctrunner': {
        data: { 'tmp/screenshot.png': bytes },
      },
    },
    screenshot: {
      message: 'tmp/screenshot.png',
      screenshotMetadata: {
        displayID: 1,
        pixelWidth: 12,
        pixelHeight: 18,
        pixelsPerPoint: 3,
      },
    },
  });
  const interactor = f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' });
  const original = path.join(f.directory, 'original.png');
  await interactor.screenshot(original, { pixelDensity: 3 });
  expect(await fs.readFile(original)).toEqual(bytes);
  const scaled = path.join(f.directory, 'scaled.png');
  await interactor.screenshot(scaled, { pixelDensity: 1, normalizeStatusBar: true });
  expect(await readPngSize(scaled)).toEqual({ width: 4, height: 6 });
  expect(f.commands.filter((command) => command.command === 'screenshot')).toEqual([
    expect.objectContaining({ inlineScreenshot: false, fullscreen: true }),
    expect.objectContaining({ inlineScreenshot: false, fullscreen: true }),
  ]);
  const downloads = f.requests
    .filter((url) => url.includes('/files?'))
    .map((url) => new URL(url, 'http://fixture'));
  expect(downloads).toHaveLength(2);
  for (const url of downloads) {
    expect(url.searchParams.get('name')).toBe('tmp/screenshot.png');
    expect(url.searchParams.get('containerType')).toBe('data');
    expect(url.searchParams.get('bundleId')).toContain('xctrunner');
  }
  const calls = vi.mocked(f.session.client.simctl).mock.calls.map(([args]) => args);
  expect(calls.some((args) => args[0] === 'status_bar' && args.includes('9:41'))).toBe(true);
  expect(calls.some((args) => args[0] === 'io' || args[0] === 'get_app_container')).toBe(false);
  expect(calls.at(-1)).toEqual(['status_bar', 'booted', 'clear']);
});

test('a runner screenshot without a file path fails without writing a file', async () => {
  const f = await fixture();
  const outPath = path.join(f.directory, 'missing.png');
  await expect(f.runner.createInteractor().screenshot(outPath)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Failed to capture iOS screenshot: runner returned no file path',
  });
  await expect(fs.stat(outPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('canceling a normalized screenshot restores the remote status bar before returning', async () => {
  const controller = new AbortController();
  const f = await fixture({
    containers: {
      'com.callstack.agentdevice.runner.uitests.xctrunner': {
        data: { 'tmp/screenshot.png': PNG.sync.write(new PNG({ width: 2, height: 2 })) },
      },
    },
    screenshot: { message: 'tmp/screenshot.png' },
    holdFileDownload: true,
    onFileDownload: () => controller.abort(new Error('capture canceled')),
  });
  const outPath = path.join(f.directory, 'canceled.png');
  const interactor = f.runner.createInteractor({
    appBundleId: 'com.apple.Preferences',
    signal: controller.signal,
  });
  await expect(interactor.screenshot(outPath, { normalizeStatusBar: true })).rejects.toThrow(
    'capture canceled',
  );
  const calls = vi.mocked(f.session.client.simctl).mock.calls.map(([args]) => args);
  expect(calls.some((args) => args[0] === 'status_bar' && args.includes('9:41'))).toBe(true);
  expect(calls.at(-1)).toEqual(['status_bar', 'booted', 'clear']);
  await expect(fs.stat(outPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('remote tools execute the shared text-size, status bar and biometric settings', async () => {
  const f = await fixture({ simctlResult: { code: 0, stdout: 'large', stderr: '' } });
  const interactor = f.runner.createInteractor();
  await interactor.setSetting('text-size', 'large');
  expect(await interactor.readSetting!('text-size')).toMatchObject({ category: 'large' });
  await interactor.setSetting('wifi', 'off');
  await interactor.setSetting('airplane', 'on');
  await interactor.setSetting('faceid', 'match');
  await interactor.setSetting('touchid', 'nonmatch');
  const calls = vi.mocked(f.session.client.simctl).mock.calls.map(([args]) => args);
  expect(calls).toContainEqual(['ui', 'booted', 'content_size', 'large']);
  expect(calls).toContainEqual(['ui', 'booted', 'content_size']);
  expect(calls).toContainEqual(['status_bar', 'booted', 'override', '--wifiMode', 'failed']);
  expect(calls).toContainEqual([
    'spawn',
    'booted',
    'notifyutil',
    '-p',
    'com.apple.BiometricKit_Sim.pearl.match',
  ]);
  expect(calls).toContainEqual([
    'spawn',
    'booted',
    'notifyutil',
    '-p',
    'com.apple.BiometricKit_Sim.fingerTouch.nomatch',
  ]);
});

test('shared deployment resolves remote app names and uninstalls before uploading a replacement', async () => {
  const f = await fixture();
  const { createAppleToolHost } = await import('../../platform-runtime-apple-tool-host.ts');
  const { createAppleAppDeploymentExecutor } =
    await import('../../platform-runtime-apple-deployment-executor.ts');
  const order: string[] = [];
  const originalSimctl = f.session.client.simctl;
  f.session.client.simctl = vi.fn((args, options) => {
    if (args[0] === 'uninstall') order.push(`uninstall:${args[2]}`);
    return originalSimctl(args, options);
  });
  const host = {
    appleTools: createAppleToolHost(),
    appleDeployment: {
      ...createAppleAppDeploymentExecutor({}),
      prepareArtifact: async () => {
        order.push('materialize');
        return {
          installablePath: '/tmp/New.app',
          bundleId: 'com.apple.Preferences',
          cleanup: async () => {
            order.push('cleanup');
          },
        };
      },
    },
    deviceReadiness: {
      appleAutomation: {
        wasRecentlyObservedBooted: async () => true,
        keepHot: () => {},
        markBooted: () => {},
      },
    },
  } as unknown as import('@agent-device/contracts/platform-runtime-operations').PlatformRuntimeHost;
  const operations = f.runner.bindDeployment({
    host,
    signal: new AbortController().signal,
    install: async () => {
      order.push('upload-and-install');
      return { bundleId: 'com.apple.Preferences' };
    },
  });
  expect(
    await operations.deployApp!({
      app: 'Settings',
      appPath: '/tmp/New.app',
      replaceExisting: true,
    }),
  ).toMatchObject({ bundleId: 'com.apple.Preferences' });
  expect(order).toEqual([
    'uninstall:com.apple.Preferences',
    'materialize',
    'upload-and-install',
    'cleanup',
  ]);
  expect(await operations.uninstallApp!({ app: 'Settings' })).toEqual({
    wasInstalled: true,
    bundleId: 'com.apple.Preferences',
  });
  expect(await operations.uninstallApp!({ app: 'com.example.absent' })).toEqual({
    wasInstalled: false,
  });
});
