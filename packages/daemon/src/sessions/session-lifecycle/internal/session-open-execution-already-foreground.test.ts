import path from 'node:path';
import { expect, test } from 'vitest';
import type { DaemonResponse, DaemonResponseData } from '@agent-device/kernel/contracts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  OpenApplicationInput,
  OpenApplicationOutcome,
} from '@agent-device/contracts/application-lifecycle-runtime';
import {
  bindTestCommandHost,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { SessionStore } from '../../../core/session-store.ts';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import type { SessionState } from '../../../core/session-state.ts';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';
import {
  handleSessionCommands,
  mockBindDeviceRuntime,
} from '../../../__tests__/support/handlers/session-command-harness.ts';

bindTestCommandHost();

const HARMONY_DEVICE: DeviceInfo = {
  platform: 'harmonyos',
  id: 'harmony-1',
  name: 'HarmonyOS test device',
  kind: 'device',
  target: 'mobile',
  booted: true,
};

function makeSessionStore(): SessionStore {
  const root = mkdtempForTestSync('agent-device-open-already-foreground-');
  return new SessionStore(path.join(root, 'sessions'), createTestHostEnvironment());
}

function publishSession(
  sessionStore: SessionStore,
  name: string,
  device: DeviceInfo,
  overrides: Partial<SessionState> = {},
): SessionState {
  const session: SessionState = {
    name,
    device,
    createdAt: Date.now(),
    actions: [],
    appName: 'com.example.application',
    ...overrides,
  };
  sessionStore.publish(name, session);
  return session;
}

async function reopenApp(params: {
  sessionStore: SessionStore;
  sessionName: string;
  openOutcome: OpenApplicationOutcome;
}): Promise<DaemonResponse | null> {
  const bindDevice: Parameters<typeof handleSessionCommands>[0]['bindDevice'] = async (
    device,
    use,
  ) => {
    const binding = await mockBindDeviceRuntime(device, use);
    return {
      ...binding,
      operations: {
        ...binding.operations,
        openApplication: async (_input: OpenApplicationInput) => params.openOutcome,
      },
    };
  };
  return await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: params.sessionName,
      command: 'open',
      positionals: ['com.example.application'],
      flags: {} as DaemonRequest['flags'],
    } as DaemonRequest,
    sessionName: params.sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore: params.sessionStore,
    invoke: async (_req: DaemonRequest): Promise<DaemonResponse> => ({ ok: true, data: {} }),
    bindDevice,
  });
}

function requireOpenData(response: DaemonResponse | null): DaemonResponseData {
  if (!response?.ok) throw new Error('the open command failed');
  return response.data ?? {};
}

test('open says the app was already foreground when the platform reports the passthrough', async () => {
  const sessionStore = makeSessionStore();
  publishSession(sessionStore, 'harmony-session', HARMONY_DEVICE);

  const data = requireOpenData(
    await reopenApp({
      sessionStore,
      sessionName: 'harmony-session',
      openOutcome: {
        appBundleId: 'com.example.application',
        alreadyForeground: true,
        timing: {},
      },
    }),
  );

  const warnings = (data.warnings as string[] | undefined) ?? [];
  expect(warnings).toContain(
    'App already foreground; dispatch skipped. Use --relaunch to restart.',
  );
});

test('open adds no already-foreground note when the outcome carries no foreground fact', async () => {
  const sessionStore = makeSessionStore();
  publishSession(sessionStore, 'harmony-session', HARMONY_DEVICE);

  const data = requireOpenData(
    await reopenApp({
      sessionStore,
      sessionName: 'harmony-session',
      openOutcome: { appBundleId: 'com.example.application', timing: {} },
    }),
  );

  const warnings = (data.warnings as string[] | undefined) ?? [];
  expect(warnings.some((warning) => warning.includes('already foreground'))).toBe(false);
});
