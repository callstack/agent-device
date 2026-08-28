import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { DoublespeedApiClient } from './api-client.ts';
import {
  createDoublespeedIosInteractor,
  installDoublespeedIosApp,
  installDoublespeedIosRemoteApp,
  isUserInstalledIosApp,
  type DoublespeedIosSession,
} from './ios.ts';
import {
  doublespeedIosDevice,
  doublespeedLease,
  doublespeedTestDependencies,
} from './runtime.fixtures.ts';

const IOS_APPS = [
  { bundleId: 'com.apple.Preferences', name: 'Settings', installType: 'System' },
  { bundleId: 'com.facebook.WebDriverAgentRunner.xctrunner', installType: 'User' },
  { bundleId: 'com.example.ios', name: 'Example', installType: 'User' },
];

function iosSession(client: Record<string, unknown>): DoublespeedIosSession {
  return {
    lease: doublespeedLease(),
    simulatorId: 'sim-a',
    device: doublespeedIosDevice,
    client,
    screen: { width: 393, height: 852, scale: 3 },
    dependencies: doublespeedTestDependencies,
  } as unknown as DoublespeedIosSession;
}

test('snapshot stamps the xctest channel with its own producer', async () => {
  const session = iosSession({
    elementTree: async () => [
      {
        type: 'Application',
        label: 'Example',
        frame: { x: 0, y: 0, width: 393, height: 852 },
        children: [{ type: 'Button', label: 'Continue', enabled: true, visible: true }],
      },
    ],
  });

  const result = await createDoublespeedIosInteractor(session).snapshot();

  expect(result.backend).toBe('xctest');
  expect(result.producer).toBe('doublespeed-ios-tree');
  expect(result.nodes?.map((node) => [node.label, node.depth, node.parentIndex])).toEqual([
    ['Example', 0, undefined],
    ['Continue', 1, 0],
  ]);
  expect(result.nodes?.[0]?.rect).toEqual({ x: 0, y: 0, width: 393, height: 852 });
});

test('routes open, deep links, home and orientation through the session', async () => {
  const launchApp = vi.fn(async () => undefined);
  const openUrl = vi.fn(async () => undefined);
  const pressKey = vi.fn(async () => undefined);
  const setOrientation = vi.fn(async () => undefined);
  const tapElement = vi.fn(async () => undefined);
  const interactor = createDoublespeedIosInteractor(
    iosSession({ launchApp, openUrl, pressKey, setOrientation, tapElement }),
  );

  await interactor.open('com.example.ios');
  await interactor.open('example://deep/link');
  await interactor.open('com.example.ios', { url: 'https://example.test/path' });
  await interactor.home();
  await interactor.setOrientation('landscape-left');
  await interactor.tapElementSelector?.({ key: 'text', value: 'Continue' });

  expect(launchApp.mock.calls).toEqual([['com.example.ios'], ['com.example.ios']]);
  expect(openUrl.mock.calls).toEqual([['example://deep/link'], ['https://example.test/path']]);
  expect(pressKey).toHaveBeenCalledWith('home');
  expect(setOrientation).toHaveBeenCalledWith('landscape');
  expect(tapElement).toHaveBeenCalledWith({ label: 'Continue' });
  await expect(interactor.setOrientation('portrait-upside-down')).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
  });
  await expect(interactor.back()).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
});

test('remote install waits for eventually consistent app inventory', async () => {
  const staleApps = IOS_APPS.slice(0, 2);
  const listApps = vi
    .fn(async () => IOS_APPS)
    .mockResolvedValueOnce(staleApps)
    .mockResolvedValueOnce(staleApps);
  const installApp = vi.fn(async () => ({ bundleId: 'com.example.ios' }));
  const session = iosSession({ listApps, installApp });

  await expect(
    installDoublespeedIosRemoteApp(session, 'https://blob.example/example.zip', {
      sha256: 'abc',
      relaunch: true,
      appIdentifierHint: 'com.example.ios',
    }),
  ).resolves.toEqual({ appId: 'com.example.ios' });
  expect(listApps).toHaveBeenCalledTimes(3);
  expect(installApp.mock.calls[0]).toEqual([
    { url: 'https://blob.example/example.zip', sha256: 'abc', launchMode: 'RelaunchIfRunning' },
    undefined,
  ]);
});

test('remote install infers the single new user app when the session reports no bundle id', async () => {
  const listApps = vi.fn(async () => IOS_APPS).mockResolvedValueOnce(IOS_APPS.slice(0, 2));
  const session = iosSession({ listApps, installApp: async () => ({}) });
  await expect(
    installDoublespeedIosRemoteApp(session, 'https://blob.example/x.zip'),
  ).resolves.toEqual({
    appId: 'com.example.ios',
  });
});

test('packages a .app directory, publishes it once, and installs through the signed download', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doublespeed-ios-app-'));
  const appPath = path.join(tempDir, 'Example.app');
  fs.mkdirSync(appPath);
  const archiveDirectory = vi.fn(async ({ archivePath }: { archivePath: string }) => {
    fs.writeFileSync(archivePath, 'zip-bytes');
  });
  const registerAsset = vi.fn(async (_input: { sha256: string; size: number; name: string }) => ({
    sha256: 'sha',
    exists: false,
    upload_url: 'https://blob.example/upload',
    download_url: null,
  }));
  const uploadAsset = vi.fn(async () => undefined);
  const completeAsset = vi.fn(async () => ({
    sha256: 'sha',
    exists: true,
    upload_url: null,
    download_url: 'https://blob.example/get',
  }));
  const api = { registerAsset, uploadAsset, completeAsset } as unknown as DoublespeedApiClient;
  const installApp = vi.fn(async (_input: unknown) => ({ bundleId: 'com.example.ios' }));
  const session = {
    ...iosSession({ installApp, listApps: async () => IOS_APPS }),
    dependencies: {
      host: { archiveDirectory },
      ios: {
        resolveAppAlias: async (app: string) => app,
        readBundleAppName: async () => 'Example',
      },
    },
  };

  const result = await installDoublespeedIosApp(api, session, appPath, {
    appIdentifierHint: 'com.example.ios',
  });

  expect(result).toEqual({
    bundleId: 'com.example.ios',
    launchTarget: 'com.example.ios',
    appName: 'Example',
  });
  expect(archiveDirectory).toHaveBeenCalledWith(
    expect.objectContaining({ sourceDirectory: tempDir, entryName: 'Example.app' }),
  );
  const registration = registerAsset.mock.calls[0]![0];
  expect(registration).toMatchObject({ size: 9, name: 'Example.app.zip' });
  const sha = registration.sha256;
  expect(sha).toMatch(/^[a-f0-9]{64}$/);
  expect(uploadAsset).toHaveBeenCalledWith(
    'https://blob.example/upload',
    expect.stringMatching(/Example\.app\.zip$/),
    undefined,
  );
  expect(completeAsset).toHaveBeenCalledWith(sha, 9, undefined);
  expect(installApp.mock.calls[0]?.[0]).toEqual({
    url: 'https://blob.example/get',
    sha256: sha,
    launchMode: 'ForegroundIfRunning',
  });
  expect(
    fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith('agent-device-doublespeed-ios-app-')),
  ).toEqual([]);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('user-installed inventory hides Apple and the WebDriverAgent runner', () => {
  expect(IOS_APPS.filter(isUserInstalledIosApp).map((app) => app.bundleId)).toEqual([
    'com.example.ios',
  ]);
});
