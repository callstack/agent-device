import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { ResourceDiagnostic } from '@agent-device/host-kit/diagnostics';
import { mkdtempForTestSync, withMockedPlatform } from '@agent-device/test-kit';

const legacyRedirect = vi.hoisted(() => ({ xctestDeviceSetPath: '' }));

vi.mock('@agent-device/platform-apple/runner-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-apple/runner-owner')>();
  return {
    ...actual,
    restoreLegacyXctestDeviceSetRedirect: async (
      onDiagnostic: Parameters<typeof actual.restoreLegacyXctestDeviceSetRedirect>[0],
    ) =>
      await actual.restoreLegacyXctestDeviceSetRedirect(
        onDiagnostic,
        legacyRedirect.xctestDeviceSetPath,
      ),
  };
});

import { platformDaemonLifecycleOwners } from './platform-runtime-daemon-lifecycle.ts';

const roots: string[] = [];

afterEach(async () => {
  await platformDaemonLifecycleOwners.clearDaemonLockConfiguration();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeLegacyRedirect(): { stateDir: string; developer: string; scopedSetPath: string } {
  const root = mkdtempForTestSync('agent-device-owner-lifecycle-xctest-device-set-');
  roots.push(root);
  const stateDir = path.join(root, 'state');
  const developer = path.join(root, 'Library', 'Developer');
  const scopedSetPath = path.join(root, 'tenant-set');
  fs.mkdirSync(path.join(scopedSetPath, 'SCOPED-UDID'), { recursive: true });
  fs.mkdirSync(developer, { recursive: true });
  legacyRedirect.xctestDeviceSetPath = path.join(developer, 'XCTestDevices');
  fs.symlinkSync(scopedSetPath, legacyRedirect.xctestDeviceSetPath, 'dir');
  return { stateDir, developer, scopedSetPath };
}

async function configureOnDarwin(stateDir: string): Promise<ResourceDiagnostic[]> {
  const diagnostics: ResourceDiagnostic[] = [];
  await withMockedPlatform('darwin', () =>
    platformDaemonLifecycleOwners.configureForDaemonLock({
      stateDir,
      hasDeviceClaimAuthority: () => false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    }),
  );
  return diagnostics;
}

test('configuring for the daemon lock on macOS puts back a redirected XCTestDevices', async () => {
  const { stateDir, developer, scopedSetPath } = makeLegacyRedirect();
  fs.mkdirSync(path.join(developer, 'XCTestDevices.agent-device-backup', 'HOST-UDID'), {
    recursive: true,
  });

  const diagnostics = await configureOnDarwin(stateDir);

  expect(fs.lstatSync(legacyRedirect.xctestDeviceSetPath).isSymbolicLink()).toBe(false);
  expect(fs.existsSync(path.join(legacyRedirect.xctestDeviceSetPath, 'HOST-UDID'))).toBe(true);
  expect(fs.existsSync(path.join(scopedSetPath, 'SCOPED-UDID'))).toBe(true);
  expect(diagnostics).toEqual([
    expect.objectContaining({
      phase: 'ios_runner_legacy_xctest_device_set_link_removed',
      resourcePath: legacyRedirect.xctestDeviceSetPath,
      data: expect.objectContaining({ linkTarget: scopedSetPath }),
    }),
    expect.objectContaining({ phase: 'ios_runner_legacy_xctest_device_set_backup_restored' }),
  ]);
});

test.skipIf(process.getuid?.() === 0)(
  'a restore the host refuses is reported as a diagnostic and does not fail configuration',
  async () => {
    const { stateDir, developer } = makeLegacyRedirect();
    fs.chmodSync(developer, 0o555);

    try {
      const diagnostics = await configureOnDarwin(stateDir);

      expect(fs.lstatSync(legacyRedirect.xctestDeviceSetPath).isSymbolicLink()).toBe(true);
      expect(diagnostics).toEqual([
        expect.objectContaining({
          phase: 'ios_runner_legacy_xctest_device_set_restore_failed',
          resourcePath: legacyRedirect.xctestDeviceSetPath,
        }),
      ]);
    } finally {
      fs.chmodSync(developer, 0o755);
    }
  },
);
