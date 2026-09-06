import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runCmd } from '@agent-device/host-kit/command';
import { sleep } from '@agent-device/host-kit/retry';
import { withAppleToolProvider } from '@agent-device/platform-apple/tool-provider';
import { createRecordingAppleToolProvider } from './providers.ts';
import { createDemoIosApp } from './fixtures.ts';
import {
  AUTOMATION_APP_ID,
  AUTOMATION_PNG,
  managedAutomationBinding,
  managedAutomationApk,
  withManagedAdbFixture,
} from './managed-runtime-automation.fixtures.ts';

vi.mock('@agent-device/host-kit/retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/retry')>()),
  sleep: vi.fn(async () => {}),
}));

test('managed iOS delegates deployment and system operations without local readiness or runner startup', async () => {
  const app = createDemoIosApp('managed-ios-automation-');
  let biometricAttempts = 0;
  const native = createRecordingAppleToolProvider({
    plist: {
      readJson: async () => ({ CFBundleIdentifier: AUTOMATION_APP_ID, CFBundleName: 'Demo' }),
    },
    simctl: async (args) => {
      expect(args.slice(0, 2)).toEqual(['--set', '/managed/set']);
      const command = args[2];
      if (command === 'list')
        return {
          stdout: JSON.stringify({
            devices: { ios: [{ udid: 'managed-ios', state: 'Shutdown' }] },
          }),
          stderr: '',
          exitCode: 0,
        };
      expect(['install', 'uninstall', 'pbpaste', 'pbcopy', 'ui', 'biometric', 'push']).toContain(
        command,
      );
      if (command === 'biometric' && ++biometricAttempts === 1)
        return { stdout: '', stderr: 'unknown command', exitCode: 1 };
      return {
        stdout: command === 'pbpaste' ? 'managed clipboard\n' : '',
        stderr: '',
        exitCode: 0,
      };
    },
  });
  try {
    await withAppleToolProvider(native.provider, async () => {
      const { binding, allocator, admission } = await managedAutomationBinding('ios');
      expect(allocator.calls.map(({ method }) => method)).toEqual(['requestLease']);
      const ops = binding.operations;
      await ops.ensureReady!({});
      await ops.deployApp!({
        app: AUTOMATION_APP_ID,
        appPath: app.appPath,
        replaceExisting: false,
      });
      await ops.deployApp!({ app: AUTOMATION_APP_ID, appPath: app.appPath, replaceExisting: true });
      const artifact = await ops.materializeAppSource!({
        source: { kind: 'path', path: app.appPath },
      });
      try {
        await ops.deployMaterializedApp!({ artifact });
      } finally {
        await artifact.cleanup();
      }
      await ops.sendPushNotification!({ appId: AUTOMATION_APP_ID, payload: {} });
      expect(await ops.readClipboard!({})).toBe('managed clipboard');
      await ops.writeClipboard!({ text: 'managed' });
      await ops.setSetting!({ setting: 'appearance', state: 'dark' });
      await ops.setSetting!({ setting: 'faceid', state: 'match' });
      expect(biometricAttempts).toBe(2);
      expect(native.calls.filter((call) => call[3] === 'install')).toHaveLength(3);
      expect(
        native.calls.some((call) => ['list', 'boot', 'bootstatus', 'shutdown'].includes(call[3]!)),
      ).toBe(false);
      expect(allocator.calls.map(({ method }) => method)).toEqual(['requestLease', 'renewLease']);
      const before = native.calls.length;
      admission.fenceBinding('replaced');
      await expect(ops.readClipboard!({})).rejects.toMatchObject({
        details: { reason: 'teardown-required' },
      });
      await binding[Symbol.asyncDispose]();
      expect(native.calls).toHaveLength(before);
    });
  } finally {
    fs.rmSync(app.tempRoot, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'managed Android contains bind probes, APK deployment, settings, clipboard and screenshot',
  async () => {
    await withManagedAdbFixture(async (native) => {
      const { binding, host, allocator, admission } = await managedAutomationBinding('android');
      expect(native.calls()).toHaveLength(1);
      expect(allocator.calls.map(({ method }) => method)).toEqual(['requestLease']);
      const ops = binding.operations;
      const apkPath = await managedAutomationApk(native.root);
      await ops.ensureReady!({});
      await ops.deployApp!({ app: AUTOMATION_APP_ID, appPath: apkPath, replaceExisting: false });
      await ops.deployApp!({ app: AUTOMATION_APP_ID, appPath: apkPath, replaceExisting: true });
      const artifact = await ops.materializeAppSource!({ source: { kind: 'path', path: apkPath } });
      try {
        await ops.deployMaterializedApp!({ artifact });
      } finally {
        await artifact.cleanup();
      }
      await ops.sendPushNotification!({ appId: AUTOMATION_APP_ID, payload: {} });
      expect(await ops.readClipboard!({})).toBe('managed clipboard');
      await ops.writeClipboard!({ text: 'managed' });
      await ops.setSetting!({ setting: 'fingerprint', state: 'match' });
      await ops.setSetting!({
        setting: 'clear-app-state',
        state: 'clear',
        appBundleId: AUTOMATION_APP_ID,
      });
      const outPath = path.join(native.root, 'capture.png');
      await ops.captureScreenshot!({ outPath, options: { stabilize: false } });
      expect(fs.readFileSync(outPath)).toEqual(AUTOMATION_PNG);
      const calls = native.calls();
      expect(calls.filter((args) => args[4] === 'install')).toHaveLength(3);
      expect(calls.some((args) => args.slice(4).join(' ') === 'emu finger touch 1')).toBe(true);
      for (const args of calls)
        expect(args.slice(0, 4)).toEqual(['-P', '15037', '-s', 'emulator-15037']);
      const bundle = path.join(native.root, 'App.aab');
      fs.writeFileSync(bundle, 'bundle');
      const archive = path.join(native.root, 'bundle.zip');
      await runCmd('zip', ['-q', archive, 'App.aab'], { cwd: native.root });
      const commands = vi.spyOn(host.commands, 'run');
      for (const replaceExisting of [false, true]) {
        await expect(
          ops.deployApp!({ app: AUTOMATION_APP_ID, appPath: bundle, replaceExisting }),
        ).rejects.toMatchObject({ details: { reason: 'managed-bundle-install-unavailable' } });
      }
      await expect(
        ops.deployApp!({ app: AUTOMATION_APP_ID, appPath: archive, replaceExisting: true }),
      ).rejects.toMatchObject({ details: { reason: 'managed-bundle-install-unavailable' } });
      await expect(
        ops.deployMaterializedApp!({
          artifact: { installablePath: bundle, cleanup: async () => {} },
        }),
      ).rejects.toMatchObject({ details: { reason: 'managed-bundle-install-unavailable' } });
      expect(commands).not.toHaveBeenCalled();
      expect(native.calls()).toEqual(calls);
      admission.fenceBinding('released');
      await expect(ops.readClipboard!({})).rejects.toMatchObject({
        details: { reason: 'teardown-required' },
      });
      await binding[Symbol.asyncDispose]();
      expect(native.calls()).toEqual(calls);
    });
  },
);

test.skipIf(process.platform === 'win32')(
  'managed screenshot failure keeps demo-mode cleanup on its private transport',
  async () => {
    await withManagedAdbFixture(async (native) => {
      const { binding } = await managedAutomationBinding('android');
      vi.mocked(sleep).mockClear();
      fs.writeFileSync(path.join(native.root, 'corrupt-screenshot'), '');
      await expect(
        binding.operations.captureScreenshot!({ outPath: path.join(native.root, 'bad.png') }),
      ).rejects.toThrow('valid PNG header');
      expect(sleep).toHaveBeenCalledOnce();
      const calls = native.calls();
      expect(calls.at(-1)?.at(-1)).toBe(
        'am broadcast -a com.android.systemui.demo -e command exit',
      );
      for (const args of calls)
        expect(args.slice(0, 4)).toEqual(['-P', '15037', '-s', 'emulator-15037']);
      await binding[Symbol.asyncDispose]();
    });
  },
);
