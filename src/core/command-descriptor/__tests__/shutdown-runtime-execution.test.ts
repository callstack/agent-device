import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { shutdownTargetUse } from '@agent-device/contracts/platform-runtime-operations';
import { commandDescriptors } from '../registry.ts';

const sessionStateSource = readFileSync(
  new URL('../../../daemon/handlers/session-state.ts', import.meta.url),
  'utf8',
);
const sessionCloseSource = readFileSync(
  new URL('../../../daemon/session-lifecycle/internal/session-close.ts', import.meta.url),
  'utf8',
);
const appleLifecycleSource = readFileSync(
  new URL('../../../../packages/platform-apple/src/lifecycle.ts', import.meta.url),
  'utf8',
);
const androidLifecycleSource = readFileSync(
  new URL('../../../../packages/platform-android/src/lifecycle.ts', import.meta.url),
  'utf8',
);
const sharedHostSource = readFileSync(
  new URL('../../../platform-runtime-device-shutdown-host.ts', import.meta.url),
  'utf8',
);
const appleShutdownSource = readFileSync(
  new URL('../../../../packages/platform-apple/src/shutdown/runtime.ts', import.meta.url),
  'utf8',
);
const androidShutdownSource = readFileSync(
  new URL('../../../../packages/platform-android/src/shutdown/runtime.ts', import.meta.url),
  'utf8',
);

test('shutdown descriptor declares one canonical runtime operation', () => {
  const shutdown = commandDescriptors.find(({ name }) => name === 'shutdown');

  expect(shutdown).not.toHaveProperty('capability');
  expect(shutdown?.platformExecution).toEqual({
    kind: 'device-runtime',
    use: shutdownTargetUse,
  });
});

test('canonical shutdown and close parity share one concrete teardown mechanic', () => {
  const shutdownRoute = sessionStateSource.slice(
    sessionStateSource.indexOf("if (req.command === 'shutdown')"),
  );
  expect(shutdownRoute.match(/inspectFacts\(device\)/g)).toHaveLength(1);
  expect(shutdownRoute.match(/bindDevice\(device, shutdownTargetUse\)/g)).toHaveLength(1);
  expect(shutdownRoute).not.toContain('operations.ensureReady');
  expect(shutdownRoute).not.toContain('ensureReadyUse');
  expect(shutdownRoute).not.toContain('target-shutdown');

  expect(sessionCloseSource).not.toContain('session-close-shutdown');
  expect(appleLifecycleSource).toContain('host.deviceShutdown.apple.shutdownTarget');
  expect(androidLifecycleSource).toContain('host.deviceShutdown.android.shutdownTarget');

  expect(sharedHostSource).toContain('createDeviceShutdownRuntimeHost');
  expect(sharedHostSource).toContain('shutdownTargetForClose');
  expect(sharedHostSource).not.toContain('isIosFamily');
  expect(sharedHostSource).not.toContain('shutdownSimulator');
  expect(sharedHostSource).not.toContain('runAndroidAdb');
  expect(sharedHostSource).not.toContain('shutdownIosSimulator');
  expect(sharedHostSource).not.toContain('shutdownAndroidEmulator');

  expect(appleShutdownSource).toContain("tool: 'simctl'");
  expect(appleShutdownSource).toContain("device.appleOs !== 'watchos'");
  expect(androidShutdownSource).toContain("executable: 'adb'");
  expect(androidShutdownSource).toContain("device.platform === 'android'");
});
