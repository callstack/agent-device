import { expect, test, vi } from 'vitest';
import {
  bindTestCommandHost,
  createLiveTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { setAppleRunnerHostEnvironment } from '@agent-device/platform-apple/runner-owner';
import { createPlatformRuntimeGateway } from './platform-runtime.ts';

const events = vi.hoisted(() => [] as string[]);
vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return {
    ...actual,
    releaseIosRunnerOnClose: async (...args: Parameters<typeof actual.releaseIosRunnerOnClose>) => {
      events.push(`release:${args[0]}:${args[1].retain}`);
      await actual.releaseIosRunnerOnClose(...args);
      events.push('released');
    },
  };
});
vi.mock('@agent-device/platform-apple/macos', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/platform-apple/macos')>()),
  runMacOsAlertAction: async () => {
    events.push('alerts');
    return {};
  },
}));

bindTestCommandHost();

test('the composed close awaits the real runner release before dismissing alerts', async () => {
  const root = mkdtempForTestSync('apple-close-composition-');
  const baseHost = createLiveTestHostEnvironment();
  const host = {
    ...baseHost,
    env: { ...baseHost.env, AGENT_DEVICE_IOS_RUNNER_LEASE_DIR: `${root}/leases` },
  };
  setAppleRunnerHostEnvironment(host);
  const device: DeviceInfo = {
    platform: 'apple',
    appleOs: 'macos',
    id: 'close-composition-test',
    name: 'Test Mac',
    kind: 'device',
    target: 'desktop',
    booted: true,
  };
  const gateway = createPlatformRuntimeGateway({
    host,
    sessionsDir: root,
    resolveSessionArtifacts: (sessionId) => ({
      outputPath: `${root}/${sessionId}/app.log`,
      pidPath: `${root}/${sessionId}/app-log.pid`,
    }),
  });
  const binding = await gateway.bind({
    device,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
  const close = binding.operations.finalizeApplicationClose;
  if (!close) throw new Error('close finalization was not bound');
  await close({
    surface: 'app',
    appBundleId: 'com.example.app',
    retainRunner: false,
    stateDir: root,
  });
  expect(events).toEqual(['release:close-composition-test:false', 'released', 'alerts']);
  await binding[Symbol.asyncDispose]();
});
