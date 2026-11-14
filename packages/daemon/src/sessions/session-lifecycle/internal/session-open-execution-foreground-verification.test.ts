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
  const root = mkdtempForTestSync('agent-device-open-foreground-');
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

async function openApp(params: {
  sessionStore: SessionStore;
  sessionName: string;
  openOutcome: OpenApplicationOutcome;
  flags?: Record<string, unknown>;
  onOpenApplication?: (input: OpenApplicationInput) => Promise<void> | void;
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
        openApplication: async (input: OpenApplicationInput) => {
          await params.onOpenApplication?.(input);
          return params.openOutcome;
        },
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
      flags: (params.flags ?? {}) as DaemonRequest['flags'],
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

test('open warns and carries the typed read when the launched app never held the foreground', async () => {
  const sessionStore = makeSessionStore();
  publishSession(sessionStore, 'harmony-session', HARMONY_DEVICE);

  const data = requireOpenData(
    await openApp({
      sessionStore,
      sessionName: 'harmony-session',
      openOutcome: {
        appBundleId: 'com.example.application',
        timing: {
          foregroundVerification: { confirmed: false, foregroundPackage: 'com.ohos.launcher' },
        },
      },
    }),
  );

  const warnings = (data.warnings as string[] | undefined) ?? [];
  expect(warnings.some((warning) => warning.includes('open-not-foreground'))).toBe(true);
  expect(warnings.some((warning) => warning.includes('"com.ohos.launcher"'))).toBe(true);
  expect(warnings.some((warning) => warning.toLowerCase().includes('unlock'))).toBe(true);
  const timing = data.timing as Record<string, unknown> | undefined;
  expect(timing?.foregroundVerification).toEqual({
    confirmed: false,
    foregroundPackage: 'com.ohos.launcher',
  });
});

test('open names the unreadable foreground instead of a holder package when no mission is foreground', async () => {
  const sessionStore = makeSessionStore();
  publishSession(sessionStore, 'harmony-session', HARMONY_DEVICE);

  const data = requireOpenData(
    await openApp({
      sessionStore,
      sessionName: 'harmony-session',
      openOutcome: {
        appBundleId: 'com.example.application',
        timing: { foregroundVerification: { confirmed: false } },
      },
    }),
  );

  const warnings = (data.warnings as string[] | undefined) ?? [];
  expect(warnings.some((warning) => warning.includes('could not read any foreground app'))).toBe(
    true,
  );
});

test('open adds no foreground warning when the lifecycle outcome carries no unconfirmed read', async () => {
  const sessionStore = makeSessionStore();
  publishSession(sessionStore, 'harmony-session', HARMONY_DEVICE);

  const data = requireOpenData(
    await openApp({
      sessionStore,
      sessionName: 'harmony-session',
      openOutcome: { appBundleId: 'com.example.application', timing: {} },
    }),
  );

  const warnings = (data.warnings as string[] | undefined) ?? [];
  expect(warnings.some((warning) => warning.includes('open-not-foreground'))).toBe(false);
});

test('open --foreground fails the command when the foreground verification is unconfirmed', async () => {
  const sessionStore = makeSessionStore();
  publishSession(sessionStore, 'harmony-session', HARMONY_DEVICE);

  // The platform owns the hard failure; the mock replays it so the route's
  // contract with --foreground is pinned end to end: the openApplication
  // failure propagates out of the route instead of reporting a successful open.
  await expect(
    openApp({
      sessionStore,
      sessionName: 'harmony-session',
      flags: { foreground: true },
      openOutcome: {
        appBundleId: 'com.example.application',
        timing: {
          foregroundVerification: { confirmed: false, foregroundPackage: 'com.ohos.launcher' },
        },
      },
      onOpenApplication: async (input) => {
        if (input.execution.foreground === true) {
          throw Object.assign(
            new Error(
              'The launch dispatch for com.example.application succeeded, but HarmonyOS did not show it in the foreground within 5s',
            ),
            { code: 'COMMAND_FAILED', details: { reason: 'open-not-foreground' } },
          );
        }
      },
    }),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED', details: { reason: 'open-not-foreground' } });
});

test('open names the unreadable probe instead of claiming the app stayed backgrounded', async () => {
  const sessionStore = makeSessionStore();
  publishSession(sessionStore, 'harmony-session', HARMONY_DEVICE);

  const data = requireOpenData(
    await openApp({
      sessionStore,
      sessionName: 'harmony-session',
      openOutcome: {
        appBundleId: 'com.example.application',
        timing: { foregroundVerification: { confirmed: false, probeState: 'unreadable' } },
      },
    }),
  );

  const warnings = (data.warnings as string[] | undefined) ?? [];
  expect(warnings.some((warning) => warning.includes('open-foreground-probe-unreadable'))).toBe(
    true,
  );
  expect(warnings.some((warning) => warning.includes('claims nothing'))).toBe(true);
  expect(warnings.some((warning) => warning.includes('open-not-foreground'))).toBe(false);
});
