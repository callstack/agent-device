import { test, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { handleInstallFromSourceCommand } from '../install-source.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, SessionState } from '../../types.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../../device-ready.ts', () => ({
  ensureDeviceReady: vi.fn(async () => {}),
}));

vi.mock('../../../core/dispatch.ts', () => ({
  resolveTargetDevice: vi.fn(),
}));

vi.mock('../../../request/cancel.ts', () => ({
  getRequestSignal: vi.fn(() => undefined),
}));

vi.mock('../../../platforms/android/install-artifact.ts', () => ({
  prepareAndroidInstallArtifact: vi.fn(async () => ({
    installablePath: '/tmp/materialized/app.apk',
    packageName: undefined,
    cleanup: async () => {},
  })),
}));

vi.mock('../../../platforms/android/app-lifecycle.ts', () => ({
  installAndroidInstallablePathAndResolvePackageName: vi.fn(async () => 'com.example.app'),
  inferAndroidAppName: vi.fn(() => 'App'),
}));

vi.mock('../../../platforms/apple/core/apps.ts', () => ({
  installIosInstallablePath: vi.fn(async () => {}),
}));

function makeRequest(
  meta?: DaemonRequest['meta'],
  platform: 'android' | 'ios' = 'android',
): DaemonRequest {
  return {
    token: 't',
    session: 'default',
    command: 'install_source',
    positionals: [],
    flags: { platform },
    meta,
  };
}

function makeIosSession(name: string): SessionState {
  return {
    name,
    createdAt: Date.now(),
    actions: [],
    device: {
      platform: 'apple',
      appleOs: 'ios',
      id: 'sim-1',
      name: 'iPhone',
      kind: 'simulator',
      booted: true,
    },
  };
}

function makeSessionStore(): SessionStore {
  const root = mkdtempForTestSync('agent-device-install-source-session-');
  return new SessionStore(path.join(root, 'sessions'));
}

function makeAndroidSession(name: string): SessionState {
  return {
    name,
    createdAt: Date.now(),
    actions: [],
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    },
  };
}

test('install_from_source returns Android package identity resolved after install when artifact inspection is empty', async () => {
  const sessionStore = makeSessionStore();
  const session = makeAndroidSession('default');
  sessionStore.set(session.name, session);

  const response = await handleInstallFromSourceCommand({
    req: makeRequest({
      installSource: {
        kind: 'url',
        url: 'https://example.com/app.zip',
        headers: {},
      },
    }),
    sessionName: session.name,
    sessionStore,
  });

  expect(response).toEqual({
    ok: true,
    data: {
      packageName: 'com.example.app',
      appName: 'App',
      launchTarget: 'com.example.app',
      message: 'Installed: App',
    },
  });
  expect(session.actions.at(-1)?.result).toEqual({
    packageName: 'com.example.app',
    appName: 'App',
    launchTarget: 'com.example.app',
    message: 'Installed: App',
  });
});

test('install_from_source returns an error when Android package identity cannot be resolved', async () => {
  const { installAndroidInstallablePathAndResolvePackageName } =
    await import('../../../platforms/android/app-lifecycle.ts');
  vi.mocked(installAndroidInstallablePathAndResolvePackageName).mockResolvedValueOnce(undefined);

  const sessionStore = makeSessionStore();
  const session = makeAndroidSession('default');
  sessionStore.set(session.name, session);

  const response = await handleInstallFromSourceCommand({
    req: makeRequest({
      installSource: {
        kind: 'url',
        url: 'https://example.com/app.zip',
        headers: {},
      },
    }),
    sessionName: session.name,
    sessionStore,
  });

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toMatch(/identity could not be resolved/i);
  }
});

test('install_from_source prepares and installs a local iOS simulator app source with typed identity', async () => {
  const { resolveTargetDevice } = await import('../../../core/dispatch.ts');
  const { installIosInstallablePath } = await import('../../../platforms/apple/core/apps.ts');
  const sourceRoot = mkdtempForTestSync('agent-device-ios-source-');
  const appPath = path.join(sourceRoot, 'AgentDeviceTester.app');
  fs.mkdirSync(appPath);
  fs.writeFileSync(
    path.join(appPath, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.callstack.agentdevicelab</string>
  <key>CFBundleDisplayName</key>
  <string>Agent Device Tester</string>
</dict>
</plist>
`,
  );

  const sessionStore = makeSessionStore();
  const session = makeIosSession('ios-source');
  vi.mocked(resolveTargetDevice).mockResolvedValueOnce(session.device);
  try {
    const response = await handleInstallFromSourceCommand({
      req: makeRequest(
        {
          installSource: {
            kind: 'path',
            path: appPath,
          },
        },
        'ios',
      ),
      sessionName: session.name,
      sessionStore,
    });

    expect(response).toEqual({
      ok: true,
      data: {
        appName: 'Agent Device Tester',
        bundleId: 'com.callstack.agentdevicelab',
        launchTarget: 'com.callstack.agentdevicelab',
        message: 'Installed: Agent Device Tester',
      },
    });
    expect(installIosInstallablePath).toHaveBeenCalledWith(session.device, appPath);
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});
