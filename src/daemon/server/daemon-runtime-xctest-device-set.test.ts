import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { withMockedPlatform } from '../../__tests__/test-utils/host-execution.ts';

const legacyRedirect = vi.hoisted(() => ({
  xctestDeviceSetPath: '',
  infoPublishedAtRestore: [] as boolean[],
  infoPath: '',
}));

vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return {
    ...actual,
    restoreLegacyXctestDeviceSetRedirect: (
      onDiagnostic: Parameters<typeof actual.restoreLegacyXctestDeviceSetRedirect>[0],
    ) => {
      legacyRedirect.infoPublishedAtRestore.push(fs.existsSync(legacyRedirect.infoPath));
      actual.restoreLegacyXctestDeviceSetRedirect(onDiagnostic, legacyRedirect.xctestDeviceSetPath);
    },
  };
});

vi.mock('../../platform-runtime.ts', () => ({
  androidObservation: {},
  createRequestPlatformProviders: () => ({
    run: async (_context: unknown, task: () => Promise<unknown>) => await task(),
  }),
  createPlatformRuntimeGateway: () => ({
    applicationLifecycle: {
      recoverStartupResources: async () => {},
      detachForDaemonShutdown: async () => {},
      finalizeDaemonShutdown: async () => {},
    },
    inspectFacts: async () => {
      throw new Error('unused');
    },
    bind: async () => {
      throw new Error('unused');
    },
    shutdown: async () => {},
  }),
  createPlatformDeviceInventoryGateways: () => ({}),
}));

vi.mock('../../provider-device-runtimes.ts', () => ({
  DEFAULT_PROVIDER_RUNTIME_REQUIRED_IDS: [],
  createDefaultProviderRuntimeComposition: async () => ({ runtimes: [], platformModules: [] }),
}));

import { startDaemonRuntime } from './daemon-runtime.ts';

const roots: string[] = [];

afterEach(() => {
  legacyRedirect.infoPublishedAtRestore.length = 0;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function loggedEvents(logPath: string): Array<{ phase: string; data?: Record<string, unknown> }> {
  return fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { phase: string; data?: Record<string, unknown> })
    .filter((event) => event.phase.startsWith('ios_runner_legacy_xctest_device_set_'));
}

test('macOS daemon startup puts back a redirected XCTestDevices before it publishes readiness', async () => {
  const root = mkdtempForTestSync('agent-device-daemon-xctest-device-set-');
  roots.push(root);
  const stateDir = path.join(root, 'state');
  const developer = path.join(root, 'Library', 'Developer');
  const scopedSetPath = path.join(root, 'tenant-set');
  fs.mkdirSync(path.join(scopedSetPath, 'SCOPED-UDID'), { recursive: true });
  fs.mkdirSync(path.join(developer, 'XCTestDevices.agent-device-backup', 'HOST-UDID'), {
    recursive: true,
  });
  legacyRedirect.xctestDeviceSetPath = path.join(developer, 'XCTestDevices');
  legacyRedirect.infoPath = path.join(stateDir, 'daemon.json');
  fs.symlinkSync(scopedSetPath, legacyRedirect.xctestDeviceSetPath, 'dir');

  const runtime = await withMockedPlatform('darwin', () =>
    startDaemonRuntime({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      },
      exit: () => {},
      registerProcessHandlers: false,
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    }),
  );
  try {
    expect(runtime).not.toBeNull();
    expect(legacyRedirect.infoPublishedAtRestore).toEqual([false]);
    expect(fs.lstatSync(legacyRedirect.xctestDeviceSetPath).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(legacyRedirect.xctestDeviceSetPath, 'HOST-UDID'))).toBe(true);
    expect(fs.existsSync(path.join(scopedSetPath, 'SCOPED-UDID'))).toBe(true);
    expect(loggedEvents(path.join(stateDir, 'daemon.log'))).toEqual([
      expect.objectContaining({
        phase: 'ios_runner_legacy_xctest_device_set_link_removed',
        data: expect.objectContaining({
          resourcePath: legacyRedirect.xctestDeviceSetPath,
          linkTarget: scopedSetPath,
        }),
      }),
      expect.objectContaining({ phase: 'ios_runner_legacy_xctest_device_set_backup_restored' }),
    ]);
  } finally {
    await runtime?.shutdown();
  }
});
